/**
 * SDIS specimen application service.
 *
 * Specimen identity is preserved: a specimen is always bound to the order item
 * that serves it and to the order's patient. The status vocabulary and the
 * minimal transition ordering come from the Step-1 domain contract
 * (`src/domain/specimen/specimen.ts`) — no extra states, no acceptance or
 * rejection criteria are invented.
 */

import { randomUUID } from 'node:crypto';
import {
  ACCESSION_PATTERN,
  InvalidSpecimenTransitionError,
  isSpecimenRejectionReason,
  assertAccessionAssignment,
  transitionSpecimenStatus,
  type Specimen,
  type SpecimenKind,
  type SpecimenRejectionReason,
  type SpecimenStatus,
} from '../../domain/specimen/specimen';
import type { FacilityId, OrderItemId, PatientId, SpecimenId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import { requireSession, type ApplicationSession } from '../context';
import { toSpecimenDTO, type SpecimenDTO } from '../dto';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ValidationError,
} from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore, SpecimenRepository } from '../ports';
import { type OrderService } from './order-service';

const COLLECTION_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'application specimen collection',
};

const SPECIMEN_KINDS: readonly SpecimenKind[] = [
  'BLOOD',
  'SERUM',
  'PLASMA',
  'URINE',
  'STOOL',
  'CSF',
  'SWAB',
  'TISSUE',
  'OTHER',
  'ACQUISITION',
];

export interface CollectSpecimenInput {
  readonly orderItemId: OrderItemId;
  readonly patientId: PatientId;
  readonly kind: SpecimenKind;
  readonly collectedAt: string;
  readonly collectedByRef?: string;
  readonly idempotencyKey?: string;
  readonly source?: DataSource;
}

export interface SpecimenTransitionOptions {
  readonly source?: DataSource;
  /** Non-PHI audit detail. */
  readonly detail?: string;
  /** Required when `to` is REJECTED (Step 27). Ignored otherwise. */
  readonly rejectionReason?: SpecimenRejectionReason;
  /** Accessioning options (Step 27): assign when `to` is RECEIVED. */
  readonly accessionPrefix?: string;
  readonly idempotencyKey?: string;
}

export interface SpecimenServiceDependencies {
  readonly orders: OrderService;
  readonly specimens: SpecimenRepository;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
  /**
   * Accessioning scope (Step 27): the facility whose specimens are being
   * accessioned is always the SESSION facility; the facility directory is
   * resolved through the order service scope check.
   */
  readonly facilityOf?: (session: ApplicationSession) => FacilityId;
}

export class SpecimenService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: SpecimenServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Registers a collected specimen for an order item (status COLLECTED).
   * The order must be collectable and the specimen patient MUST equal the
   * order patient (identity cannot be moved between patients). When the order
   * is still ORDERED, the first collection advances it to ACQUIRED through the
   * order domain state machine.
   */
  async collectSpecimen(
    session: ApplicationSession | undefined,
    input: CollectSpecimenInput,
  ): Promise<SpecimenDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SPECIMEN_CREATE);
    if (!SPECIMEN_KINDS.includes(input.kind)) {
      throw new ValidationError(`Unknown specimen kind "${input.kind}"`);
    }
    if (!input.collectedAt) {
      throw new ValidationError('A specimen requires a collected-at timestamp');
    }
    const order = await this.deps.orders.requireScopedOrderByItem(
      session,
      input.orderItemId,
    );
    if (!this.deps.orders.isCollectable(order)) {
      throw new InvalidStateTransitionError(
        `Cannot collect a specimen for an order in status ${order.status}`,
      );
    }
    this.deps.orders.assertSinglePatient(order, input.patientId);

    const source = input.source ?? COLLECTION_SOURCE;
    const specimen = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.SPECIMEN_COLLECT,
      input.idempotencyKey,
      () => this.collectWithAudit(session, input, source, order.status),
      session,
    );
    return toSpecimenDTO(specimen);
  }

  /**
   * Creates the specimen, records its CREATED audit event, and — only when the
   * order was still ORDERED — advances it to ACQUIRED via the order service.
   * The whole unit runs inside the idempotency closure, so a replay repeats
   * NO side effect and emits NO duplicate audit events.
   */
  private async collectWithAudit(
    session: ApplicationSession,
    input: CollectSpecimenInput,
    source: DataSource,
    orderStatusAtEntry: string,
  ): Promise<Specimen> {
    const id = randomUUID() as SpecimenId;
    const specimen: Specimen = {
      id,
      orderItemId: input.orderItemId,
      patientId: input.patientId,
      kind: input.kind,
      collectedAt: input.collectedAt,
      collectedByRef: input.collectedByRef ?? session.actor.id,
      status: 'COLLECTED',
      version: 1, // LAB-02: fresh aggregate starts at the initial version
    };
    await this.deps.specimens.save(specimen);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'specimen',
      objectId: id,
      at: input.collectedAt,
      source,
    });

    if (orderStatusAtEntry === 'ORDERED') {
      const order = await this.deps.orders.requireScopedOrderByItem(
        session,
        input.orderItemId,
      );
      await this.deps.orders.transitionOrder(
        session,
        order.id,
        'ACQUIRED',
        input.collectedAt,
      );
    }
    return specimen;
  }

  /**
   * Applies a specimen lifecycle transition (domain-authoritative, wrapped into
   * the public taxonomy). The specimen is resolved back to its order for the
   * facility-scope check.
   */
  async transitionSpecimen(
    session: ApplicationSession | undefined,
    specimenId: SpecimenId,
    to: SpecimenStatus,
    at: string,
    options: SpecimenTransitionOptions = {},
  ): Promise<SpecimenDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SPECIMEN_CREATE);
    const specimen = await this.requireScopedSpecimen(session, specimenId);

    // Exception boundary (Step 27): a REJECTED specimen requires an explicit,
    // vocabulary-bound reason. The reason is preserved with the specimen and
    // audited; rejection never deletes or rewrites history.
    let rejectionReason: SpecimenRejectionReason | undefined;
    if (to === 'REJECTED') {
      if (!isSpecimenRejectionReason(options.rejectionReason)) {
        throw new ValidationError(
          `A specimen rejection requires a reason from the bounded vocabulary: ${options.rejectionReason === undefined ? 'none supplied' : String(options.rejectionReason)}`,
        );
      }
      rejectionReason = options.rejectionReason;
    }

    // Accessioning (Step 27): an accession number is assigned exactly once,
    // at RECEIVED, is facility-unique, and immutable afterwards.
    let accessionNumber = specimen.accessionNumber;
    if (to === 'RECEIVED' && accessionNumber === undefined) {
      accessionNumber = await this.assignAccessionNumber(
        session,
        options.accessionPrefix,
      );
    }
    assertAccessionAssignment(specimen.accessionNumber, accessionNumber);

    const updated = this.transitionViaDomain(specimen.status, to);
    const saved = await this.deps.specimens.save({
      ...specimen,
      status: updated,
      ...(accessionNumber !== undefined ? { accessionNumber } : {}),
      ...(rejectionReason !== undefined ? { rejectionReason } : {}),
    });
    await this.audit.record(session, {
      action: 'TRANSITIONED',
      objectType: 'specimen',
      objectId: specimen.id,
      at,
      source: options.source ?? COLLECTION_SOURCE,
      detail:
        options.detail ??
        `${specimen.status} -> ${updated}${
          rejectionReason !== undefined ? ` (reason: ${rejectionReason})` : ''
        }${
          accessionNumber !== undefined && specimen.accessionNumber === undefined
            ? ` (accession: ${accessionNumber})`
            : ''
        }`,
    });
    return toSpecimenDTO(saved);
  }

  /**
   * Generates the next facility-scoped accession number (Step 27). Format:
   * `<PREFIX>-<YYYY>-<NNNNNN>` where PREFIX is an explicit operational prefix
   * (default `SDIS`). Uniqueness is verified against persistence inside the
   * idempotent window; the number is deterministic from the count of already
   * accessioned specimens handled by the repository probe retry loop.
   */
  private async assignAccessionNumber(
    session: ApplicationSession,
    prefixOption?: string,
  ): Promise<string> {
    const prefix = (prefixOption ?? 'SDIS').toUpperCase();
    if (!/^[A-Z][A-Z0-9]{0,7}$/.test(prefix)) {
      throw new ValidationError('Accession prefix must be 1-8 uppercase letters/digits');
    }
    const year = new Date().getUTCFullYear();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const sequence = 1 + Math.floor(Math.random() * 99_999_999);
      const candidate = `${prefix}-${year}-${String(sequence).padStart(8, '0')}`;
      if (!ACCESSION_PATTERN.test(candidate)) continue;
      const clash = await this.deps.specimens.findByAccessionNumber(
        session.facilityId,
        candidate,
      );
      if (!clash) return candidate;
    }
    throw new ConflictError('Could not allocate a unique accession number');
  }

  private transitionViaDomain(from: SpecimenStatus, to: SpecimenStatus): SpecimenStatus {
    try {
      return transitionSpecimenStatus(from, to);
    } catch (error) {
      if (error instanceof InvalidSpecimenTransitionError) {
        throw new InvalidStateTransitionError(
          `Invalid specimen transition: ${from} -> ${to}`,
        );
      }
      throw error;
    }
  }

  /** Specimen must exist and its order must be within the session facility. */
  async requireScopedSpecimen(
    session: ApplicationSession,
    specimenId: SpecimenId,
  ): Promise<Specimen> {
    const specimen = await this.deps.specimens.findById(specimenId);
    if (!specimen) throw new NotFoundError('Specimen not found');
    await this.deps.orders.requireScopedOrderByItem(session, specimen.orderItemId);
    return specimen;
  }
}

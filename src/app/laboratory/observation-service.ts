/**
 * SDIS observation application service.
 *
 * Observation ≠ Interpretation ≠ Report (docs/CLINICAL_SAFETY.md §2). This
 * service creates only OBSERVATION records — it never produces an
 * interpretation or a report, and it never evaluates clinical rules
 * (no reference ranges, critical values, thresholds, or algorithms).
 */

import { randomUUID } from 'node:crypto';
import {
  assertObservationBelongsToPatient,
  type Observation,
  type ObservationValue,
} from '../../domain/results/observation';
import { PROVENANCE_SOURCE_KINDS } from '../../types/provenance';
import type { OrderItemId, ObservationId, PatientId, SpecimenId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import { requireSession, type ApplicationSession } from '../context';
import { toObservationDTO, type ObservationDTO } from '../dto';
import { NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type {
  AuditPort,
  IdempotencyStore,
  ObservationRepository,
  SpecimenRepository,
} from '../ports';
import { type OrderService } from './order-service';

export interface EnterObservationInput {
  readonly orderItemId: OrderItemId;
  readonly patientId: PatientId;
  /** Optional binding to the specimen that served the reading. */
  readonly specimenId?: SpecimenId;
  readonly code: string;
  readonly codeSystem: string;
  readonly value: ObservationValue;
  readonly unit?: string;
  /** Mandatory provenance of the reading (device/human/integration...). */
  readonly issuedBy: DataSource;
  readonly at: string;
  readonly idempotencyKey?: string;
}

export interface ObservationServiceDependencies {
  readonly orders: OrderService;
  readonly observations: ObservationRepository;
  readonly specimens: SpecimenRepository;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

export class ObservationService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: ObservationServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Records a measured/observed data point for an order item. Structural checks
   * only: scope, identity (patient, specimen↔order item), required fields, and
   * an explicit provenance source. NO clinical validation is performed.
   */
  async enterObservation(
    session: ApplicationSession | undefined,
    input: EnterObservationInput,
  ): Promise<ObservationDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.OBSERVATION_CREATE);
    if (!input.code || !input.codeSystem) {
      throw new ValidationError('An observation requires a code and a code system');
    }
    if (!input.issuedBy || !PROVENANCE_SOURCE_KINDS.includes(input.issuedBy.kind)) {
      throw new ValidationError('An observation requires an explicit provenance source');
    }
    if (!input.value || typeof input.value !== 'object' || !('kind' in input.value)) {
      throw new ValidationError('An observation requires a value');
    }
    if (!input.at) {
      throw new ValidationError('An observation requires a timestamp');
    }

    const order = await this.deps.orders.requireScopedOrderByItem(
      session,
      input.orderItemId,
    );

    if (input.specimenId) {
      const specimen = await this.deps.specimens.findById(input.specimenId);
      if (!specimen) throw new NotFoundError('Specimen not found');
      if (specimen.orderItemId !== input.orderItemId) {
        throw new ValidationError('Specimen does not serve this order item');
      }
      this.deps.orders.assertSinglePatient(order, specimen.patientId);
    }

    const observation = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.OBSERVATION_CREATE,
      input.idempotencyKey,
      () => this.enterWithAudit(session, input, order.patientId),
      session,
    );
    return toObservationDTO(observation);
  }

  private async enterWithAudit(
    session: ApplicationSession,
    input: EnterObservationInput,
    orderPatientId: PatientId,
  ): Promise<Observation> {
    const candidate: Observation = {
      id: randomUUID() as ObservationId,
      orderItemId: input.orderItemId,
      patientId: input.patientId,
      code: input.code,
      codeSystem: input.codeSystem,
      value: Object.freeze({ ...input.value }),
      ...(input.unit ? { unit: input.unit } : {}),
      issuedBy: input.issuedBy,
      at: input.at,
    };
    // Real check (not a self-assertion): the recorded patient must be the
    // order's patient. The domain guard vocabulary is preserved.
    try {
      assertObservationBelongsToPatient(candidate, orderPatientId);
    } catch {
      throw new ValidationError('Observation patient does not match the order patient');
    }
    await this.deps.observations.save(candidate);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'observation',
      objectId: candidate.id,
      at: input.at,
      source: input.issuedBy,
    });
    return candidate;
  }

  /** Read view for the caller scope (IDOR-resistant). */
  async listForOrderItem(
    session: ApplicationSession | undefined,
    orderItemId: OrderItemId,
  ): Promise<readonly ObservationDTO[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.OBSERVATION_READ);
    await this.deps.orders.requireScopedOrderByItem(session, orderItemId);
    const observations = await this.deps.observations.listByOrderItem(orderItemId);
    return observations.map(toObservationDTO);
  }
}

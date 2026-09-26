/**
 * SDIS order application service.
 *
 * Orchestrates diagnostic orders over the Step-1 domain contract
 * (`src/domain/ordering/diagnostic-order.ts`). It never mutates status fields
 * directly — every state change funnels through the domain transition function.
 */

import { randomUUID } from 'node:crypto';
import {
  assertOrderPriority,
  canChangePriority,
  DEFAULT_ORDER_PRIORITY,
  InvalidOrderTransitionError,
  transitionOrderStatus,
  type DiagnosticOrder,
  type DiagnosticOrderPriority,
  type DiagnosticOrderStatus,
  type OrderItem,
} from '../../domain/ordering/diagnostic-order';
import type {
  DiagnosticOrderId,
  EncounterId,
  OrderItemId,
  PatientId,
} from '../../types/ids';
import type { ModalityName } from '../../types/modality';
import type { DataSource } from '../../types/provenance';
import { assertSpecimenPatientMatches } from '../../domain/specimen/specimen';
import { AuditRecorder } from '../audit';
import {
  assertResourceInFacilityScope,
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import { toOrderDTO, type OrderDTO } from '../dto';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { InvalidStateTransitionError, NotFoundError, ValidationError } from '../errors';
import type {
  AuditPort,
  EncounterDirectory,
  FacilityDirectory,
  IdempotencyStore,
  ModalityDirectory,
  OrderRepository,
  PatientDirectory,
} from '../ports';

const ORDER_ENTRY_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'application order entry',
};

/** Orders in these states may still receive a newly collected specimen. */
const COLLECTABLE_ORDER_STATUSES: readonly DiagnosticOrderStatus[] = [
  'ORDERED',
  'ACQUIRED',
  'PROCESSING',
  'RESULT_ENTERED',
];

export interface CreateOrderItemInput {
  readonly testCode: string;
  readonly codeSystem: string;
}

export interface CreateOrderInput {
  readonly patientId: PatientId;
  readonly encounterId: EncounterId;
  readonly modality: ModalityName;
  readonly items: readonly CreateOrderItemInput[];
  readonly orderedAt: string;
  readonly idempotencyKey?: string;
  /** Optional provenance source for the ordering action (HUMAN entry default). */
  readonly source?: DataSource;
  /**
   * Operational workflow priority (Step 21). Defaults to ROUTINE; validated
   * against the bounded domain vocabulary. Never a clinical attribute.
   */
  readonly priority?: string;
}

export interface OrderTransitionOptions {
  readonly source?: DataSource;
  /** Non-PHI audit detail, e.g. "reason: duplicate order". */
  readonly detail?: string;
  /**
   * Verification attribution (Step 28): the verified-by reference recorded
   * when the order enters VERIFIED. The service stamps the SESSION actor —
   * clients never supply the verifier identity.
   */
  readonly verifiedByRef?: string;
  readonly verifiedAt?: string;
}

export interface OrderServiceDependencies {
  readonly patients: PatientDirectory;
  readonly encounters: EncounterDirectory;
  readonly facilities: FacilityDirectory;
  readonly modalities: ModalityDirectory;
  readonly orders: OrderRepository;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

export class OrderService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: OrderServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Creates a verified-scope diagnostic order in the domain ORDERED state.
   * Rejects: missing session/patient/encounter, patient/encounter mismatch,
   * out-of-scope patient or encounter, unknown modality, empty items.
   */
  async createOrder(
    session: ApplicationSession | undefined,
    input: CreateOrderInput,
  ): Promise<OrderDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_CREATE);
    await assertSessionFacility(session, this.deps.facilities);
    if (!input || !Array.isArray(input.items) || input.items.length === 0) {
      throw new ValidationError('A diagnostic order requires at least one item');
    }
    for (const item of input.items) {
      if (!item || !item.testCode || !item.codeSystem) {
        throw new ValidationError('Order items require a test code and a code system');
      }
    }
    if (!input.orderedAt) {
      throw new ValidationError('A diagnostic order requires an ordered-at timestamp');
    }
    const patient = await this.deps.patients.findById(input.patientId);
    if (!patient) throw new NotFoundError('Patient not found');
    assertResourceInFacilityScope(session, {
      facilityId: patient.registeredAtFacilityId,
    });

    const encounter = await this.deps.encounters.findById(input.encounterId);
    if (!encounter) throw new NotFoundError('Encounter not found');
    if (encounter.patientId !== input.patientId) {
      throw new ValidationError('Encounter does not belong to the given patient');
    }
    assertResourceInFacilityScope(session, { facilityId: encounter.facilityId });

    if (!(await this.deps.modalities.has(input.modality))) {
      throw new ValidationError(`Unknown modality "${input.modality}"`);
    }

    // Workflow priority (Step 21): validated against the bounded vocabulary
    // at the boundary; unstated means ROUTINE. The domain validator throws a
    // plain error (domain stays app-free); the boundary translates it.
    let priority: DiagnosticOrderPriority;
    try {
      priority =
        input.priority !== undefined && input.priority !== ''
          ? assertOrderPriority(input.priority)
          : DEFAULT_ORDER_PRIORITY;
    } catch {
      throw new ValidationError(
        'Invalid order priority (expected ROUTINE, URGENT, or EMERGENCY)',
      );
    }
    const source = input.source ?? ORDER_ENTRY_SOURCE;
    const order = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.ORDER_CREATE,
      input.idempotencyKey,
      () => this.createOrderWithAudit(session, input, source, priority),
      session,
      // INT-33 §10: a client key replayed with a SUBSTANTIVELY different
      // logical operation is rejected (IDEMPOTENCY_CONFLICT) instead of
      // memoized as the original. The fingerprint covers the operation's
      // identity dimensions (patient, encounter, modality, priority, items,
      // source) and deliberately EXCLUDES `orderedAt` — a retry may
      // legitimately regenerate its client clock (the replay contract,
      // codified by the Step-18 recovery drill, serves the stored result for
      // the same logical operation; the timestamp is not part of identity).
      {
        requestFingerprint: {
          patientId: input.patientId,
          encounterId: input.encounterId,
          modality: input.modality,
          priority,
          items: input.items,
          source,
        },
      },
    );
    return toOrderDTO(order);
  }

  private async createOrderWithAudit(
    session: ApplicationSession,
    input: CreateOrderInput,
    source: DataSource,
    priority: DiagnosticOrderPriority,
  ): Promise<DiagnosticOrder> {
    const id = randomUUID() as DiagnosticOrderId;
    const items: readonly OrderItem[] = Object.freeze(
      input.items.map((item): OrderItem =>
        Object.freeze({
          id: randomUUID() as OrderItemId,
          orderId: id,
          testCode: item.testCode,
          codeSystem: item.codeSystem,
        }),
      ),
    );
    const order: DiagnosticOrder = {
      id,
      patientId: input.patientId,
      encounterId: input.encounterId,
      facilityId: session.facilityId,
      modality: input.modality,
      status: 'ORDERED',
      priority,
      orderedAt: input.orderedAt,
      orderedByRef: session.actor.id,
      items,
      version: 1, // LAB-02: fresh aggregate starts at the initial version
    };
    await this.deps.orders.save(order);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'diagnostic-order',
      objectId: id,
      at: input.orderedAt,
      source,
    });
    return order;
  }

  /**
   * Applies a lifecycle transition through the domain state machine and wraps
   * the domain error into the public application taxonomy.
   */
  async transitionOrder(
    session: ApplicationSession | undefined,
    orderId: DiagnosticOrderId,
    to: DiagnosticOrderStatus,
    at: string,
    options: OrderTransitionOptions = {},
  ): Promise<OrderDTO> {
    requireSession(session);
    // AUD-01: lifecycle transitions mutate clinical workflow state — every
    // transition requires the operator-tier order capability (same bar as
    // specimen transitions). Authentication alone is never sufficient.
    await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_CREATE);
    // Verification authorization (Step 28): VERIFIED is a high-integrity
    // review act on diagnostic content — the operator tier may enter results
    // but the reviewing/verifying signature requires the manager tier via
    // the dedicated clinical permission (never a configuration permission).
    if (to === 'VERIFIED') {
      await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_VERIFY);
    }
    const order = await this.requireScopedOrder(session, orderId);
    const updated = this.transitionViaDomain(order.status, to);
    // Verification attribution (Step 28): the verifier is the SESSION actor,
    // never a client-supplied field. Recorded on the aggregate and audit.
    const verifiedByRef = to === 'VERIFIED' ? session.actor.id : order.verifiedByRef;
    const verifiedAt = to === 'VERIFIED' ? at : order.verifiedAt;
    await this.deps.orders.save({
      ...order,
      status: updated,
      ...(verifiedByRef !== undefined ? { verifiedByRef } : {}),
      ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    });
    await this.audit.record(session, {
      action:
        to === 'CANCELLED'
          ? 'CANCELLED'
          : to === 'VERIFIED'
            ? 'VERIFIED'
            : 'TRANSITIONED',
      objectType: 'diagnostic-order',
      objectId: order.id,
      at,
      source: options.source ?? ORDER_ENTRY_SOURCE,
      detail:
        to === 'VERIFIED'
          ? `verified by ${verifiedByRef}`
          : (options.detail ?? `${order.status} -> ${updated}`),
    });
    return toOrderDTO({
      ...order,
      status: updated,
      ...(verifiedByRef !== undefined ? { verifiedByRef } : {}),
      ...(verifiedAt !== undefined ? { verifiedAt } : {}),
    });
  }

  /** Domain call wrapped into the public taxonomy. */
  private transitionViaDomain(
    from: DiagnosticOrderStatus,
    to: DiagnosticOrderStatus,
  ): DiagnosticOrderStatus {
    try {
      return transitionOrderStatus(from, to);
    } catch (error) {
      if (error instanceof InvalidOrderTransitionError) {
        throw new InvalidStateTransitionError(
          `Invalid diagnostic-order transition: ${from} -> ${to}`,
        );
      }
      throw error;
    }
  }

  /**
   * Changes an order's workflow priority (Step 21). OPERATIONAL only: this
   * never touches status, clinical values, or lifecycle state. Rules:
   * - the priority vocabulary is the domain's (`assertOrderPriority`);
   * - a CANCELLED order is closed and its priority is historical (domain
   *   `canChangePriority`);
   * - the change is audited with previous -> new priority and the caller's
   *   provenance (never client-declared authorship);
   * - the whole mutation is idempotent under the existing engine.
   */
  async changeOrderPriority(
    session: ApplicationSession | undefined,
    orderId: DiagnosticOrderId,
    priority: string,
    at: string,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<OrderDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_CREATE);
    const order = await this.requireScopedOrder(session, orderId);
    let target: DiagnosticOrderPriority;
    try {
      target = assertOrderPriority(priority);
    } catch {
      throw new ValidationError(
        'Invalid order priority (expected ROUTINE, URGENT, or EMERGENCY)',
      );
    }
    if (!canChangePriority(order)) {
      throw new InvalidStateTransitionError(
        `Order priority is historical once cancelled: ${order.id}`,
      );
    }
    if (target === order.priority) {
      return toOrderDTO(order);
    }
    const updated = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.ORDER_PRIORITY_CHANGE,
      options.idempotencyKey,
      async () => {
        const saved = await this.deps.orders.save({
          ...order,
          priority: target,
          version: order.version,
        });
        await this.audit.record(session, {
          action: 'UPDATED',
          objectType: 'diagnostic-order',
          objectId: order.id,
          at,
          source:
            session.actor.kind === 'USER'
              ? { kind: 'HUMAN', label: session.actor.id }
              : { kind: 'INTEGRATION', label: session.actor.id },
          detail: `priority ${order.priority} -> ${target}`,
        });
        return saved;
      },
      session,
    );
    return toOrderDTO(updated);
  }

  /**
   * Cancellation is a first-class lifecycle action. Legality is decided
   * ENTIRELY by the domain transition table (ORDERED/ACQUIRED/PROCESSING).
   */
  async cancelOrder(
    session: ApplicationSession | undefined,
    orderId: DiagnosticOrderId,
    at: string,
    options: OrderTransitionOptions = {},
  ): Promise<OrderDTO> {
    requireSession(session);
    const order = await this.requireScopedOrder(session, orderId);
    try {
      transitionOrderStatus(order.status, 'CANCELLED');
    } catch (error) {
      if (error instanceof InvalidOrderTransitionError) {
        throw new InvalidStateTransitionError(
          `Order in status ${order.status} cannot be cancelled`,
        );
      }
      throw error;
    }
    return this.transitionOrder(session, orderId, 'CANCELLED', at, options);
  }

  /** Reads an order within the caller scope (IDOR-resistant). */
  async getOrder(
    session: ApplicationSession | undefined,
    orderId: DiagnosticOrderId,
  ): Promise<OrderDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.ORDER_READ);
    return toOrderDTO(await this.requireScopedOrder(session, orderId));
  }

  /** Order must exist and be inside the session facility scope. */
  async requireScopedOrder(
    session: ApplicationSession,
    orderId: DiagnosticOrderId,
  ): Promise<DiagnosticOrder> {
    // RLS-01: the session facility is validated BEFORE the (tenant-scoped)
    // read — a forged session must be rejected before any resource access,
    // otherwise fail-closed RLS would turn the response into 404. The facility
    // directory itself is read outside the tenant scope (see postgres-runtime),
    // so cross-organization sessions surface as SCOPE_MISMATCH (403).
    await assertSessionFacility(session, this.deps.facilities);
    const order = await this.deps.orders.findById(orderId);
    if (!order) throw new NotFoundError('Diagnostic order not found');
    assertResourceInFacilityScope(session, order);
    return order;
  }

  /** Order that owns an item — shared by item-scoped services. */
  async requireScopedOrderByItem(
    session: ApplicationSession,
    orderItemId: OrderItemId,
  ): Promise<DiagnosticOrder> {
    await assertSessionFacility(session, this.deps.facilities);
    const order = await this.deps.orders.findByOrderItemId(orderItemId);
    if (!order) throw new NotFoundError('Order item not found');
    assertResourceInFacilityScope(session, order);
    return order;
  }

  /** Domain-level identity check: specimen/observation patient equals order patient. */
  assertSinglePatient(order: DiagnosticOrder, patientId: PatientId): void {
    try {
      assertSpecimenPatientMatches(patientId, order.patientId);
    } catch {
      throw new ValidationError(
        'Patient does not match the order patient — identity mismatch',
      );
    }
  }

  /** Orders that may still receive a newly collected specimen. */
  isCollectable(order: DiagnosticOrder): boolean {
    return COLLECTABLE_ORDER_STATUSES.includes(order.status);
  }
}

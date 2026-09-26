/**
 * SDIS billing application service — the diagnostic charge lifecycle.
 *
 * Turns an EXISTING diagnostic order item into a charge for an EXISTING
 * billable service, using the EXISTING domain contract
 * (`src/domain/billing/billing.ts`): the `Charge` shape and the
 * ledger-style rule that a retry can never create a second charge. The
 * service composes the domain `ChargeLedger` semantics with a
 * `ChargeRepository` port — there is NO second billing model.
 *
 * Scope (docs/TENANCY.md): the order is the authoritative diagnostic object;
 * it must exist and be inside the session facility scope before any charge is
 * considered. The service never trusts client-supplied scope and never
 * duplicates order state — linkage is the domain's own
 * `charge.orderItemId → order item` reference.
 *
 * Financial safety: the amount/currency come from the billable service's
 * recorded price — no pricing engine, tax, discount, insurance, or payment
 * logic is implemented here. (Reported gap per Step-8 prompt §8: the existing
 * domain has no amount derivation policy, so creation requires an existing
 * billable service and records its price verbatim.)
 */

import { randomUUID } from 'node:crypto';
import type { Charge } from '../../domain/billing/billing';
import type {
  BillableServiceId,
  ChargeId,
  DiagnosticOrderId,
  OrderItemId,
} from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  assertResourceInFacilityScope,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';

/**
 * Persistence port for the diagnostic charge lifecycle. Implements the
 * domain ledger semantics over durable storage (idempotency key UNIQUE).
 */
export interface ChargeRepository {
  /** Persists a charge; must reject duplicate idempotency keys. */
  save(charge: Charge): Promise<Charge>;
  findById(id: ChargeId): Promise<Charge | undefined>;
  listByOrderItem(orderItemId: OrderItemId): Promise<readonly Charge[]>;
  findByIdempotencyKey(key: string): Promise<Charge | undefined>;
  /** Billable-service catalog read view (facility-scoped). */
  findService(serviceId: BillableServiceId): Promise<
    | {
        readonly id: BillableServiceId;
        readonly name: string;
        readonly modality: string;
        readonly priceCurrency: string;
        readonly priceAmount: number;
        readonly facilityId: string;
      }
    | undefined
  >;
}

export interface CreateChargeInput {
  readonly orderId: DiagnosticOrderId;
  /** The order item being charged (must belong to the order). */
  readonly orderItemId: OrderItemId;
  readonly serviceId: BillableServiceId;
  readonly idempotencyKey?: string;
}

export interface ChargeDTO {
  readonly id: string;
  readonly orderId: string;
  readonly orderItemId: string;
  readonly serviceId: string;
  readonly amount: number;
  readonly currency: string;
  readonly createdAt: string;
}

export interface BillingServiceDependencies {
  /** Order lookups go through the EXISTING order service (single workflow owner). */
  readonly orders: import('../laboratory/order-service').OrderService;
  readonly charges: ChargeRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

const CHARGE_SOURCE: DataSource = {
  kind: 'SYSTEM',
  label: 'application diagnostic charge',
};

function toDTO(charge: Charge, orderId: DiagnosticOrderId): ChargeDTO {
  return {
    id: charge.id,
    orderId,
    orderItemId: charge.orderItemId,
    serviceId: charge.serviceId,
    amount: charge.amount,
    currency: charge.currency,
    createdAt: charge.createdAt,
  };
}

export class BillingService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: BillingServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Creates a charge for one order item of a scope-verified diagnostic order,
   * priced from the billable service's recorded price. Duplicate creation
   * (same service already charged for the item) surfaces as CONFLICT; a keyed
   * retry returns the stored charge without any duplicate effect.
   */
  async createCharge(
    session: ApplicationSession | undefined,
    input: CreateChargeInput,
  ): Promise<ChargeDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.BILLING_CREATE);
    await assertSessionFacility(session, this.deps.facilities);
    if (!input.orderId || !input.orderItemId || !input.serviceId) {
      throw new ValidationError(
        'A charge requires an order, an order item, and a billable service',
      );
    }
    // The ORDER service owns scope and existence for the workflow object.
    const order = await this.deps.orders.requireScopedOrder(session, input.orderId);
    const item = order.items.find((candidate) => candidate.id === input.orderItemId);
    if (!item) {
      throw new ValidationError('Order item does not belong to the given order');
    }

    const service = await this.deps.charges.findService(input.serviceId);
    if (!service) {
      throw new NotFoundError('Billable service not found');
    }
    assertResourceInFacilityScope(session, {
      facilityId: service.facilityId as import('../../types/ids').FacilityId,
    });

    return toDTO(
      await runIdempotent(
        this.deps.idempotency,
        IDEMPOTENCY_SCOPES.CHARGE_CREATE,
        input.idempotencyKey,
        () => this.createWithAudit(session, input, order.id, service),
        session,
      ),
      order.id,
    );
  }

  private async createWithAudit(
    session: ApplicationSession,
    input: CreateChargeInput,
    orderId: DiagnosticOrderId,
    service: {
      readonly id: BillableServiceId;
      readonly priceCurrency: string;
      readonly priceAmount: number;
    },
  ): Promise<Charge> {
    // BILL-04/05: a keyed replay is served from the durable charge ledger row
    // (sdis.charges.idempotency_key never expires) even when the idempotency
    // store's 24 h entry has lapsed — same request, same stored result, no new
    // row and no duplicate audit.
    if (input.idempotencyKey) {
      const replayed = await this.deps.charges.findByIdempotencyKey(input.idempotencyKey);
      if (
        replayed &&
        replayed.orderItemId === input.orderItemId &&
        replayed.serviceId === service.id
      ) {
        return replayed;
      }
    }

    const existing = await this.deps.charges.listByOrderItem(input.orderItemId);
    if (existing.some((charge) => charge.serviceId === input.serviceId)) {
      throw new ConflictError(
        'This order item is already charged for this billable service',
      );
    }

    const charge: Charge = {
      id: randomUUID() as ChargeId,
      orderItemId: input.orderItemId,
      serviceId: service.id,
      // Recorded price verbatim — no pricing policy is applied or invented.
      amount: service.priceAmount,
      currency: service.priceCurrency,
      createdAt: new Date().toISOString(),
      idempotencyKey: input.idempotencyKey ?? `charge:${randomUUID()}`,
    };
    const persisted = await this.deps.charges.save(charge);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'charge',
      objectId: persisted.id,
      at: persisted.createdAt,
      source: CHARGE_SOURCE,
      detail: `order item ${input.orderItemId} charged for service ${service.id}`,
    });
    return persisted;
  }

  /** Charge by id within the caller scope (IDOR-resistant). */
  async getCharge(
    session: ApplicationSession | undefined,
    chargeId: ChargeId,
  ): Promise<ChargeDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.BILLING_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const charge = await this.deps.charges.findById(chargeId);
    if (!charge) throw new NotFoundError('Charge not found');
    const order = await this.deps.orders.requireScopedOrderByItem(
      session,
      charge.orderItemId,
    );
    return toDTO(charge, order.id);
  }

  /** Charges associated with a scope-verified diagnostic order. */
  async listChargesForOrder(
    session: ApplicationSession | undefined,
    orderId: DiagnosticOrderId,
  ): Promise<readonly ChargeDTO[]> {
    requireSession(session);
    const order = await this.deps.orders.requireScopedOrder(session, orderId);
    const charges: Charge[] = [];
    for (const item of order.items) {
      charges.push(...(await this.deps.charges.listByOrderItem(item.id)));
    }
    return charges.map((charge) => toDTO(charge, order.id));
  }
}

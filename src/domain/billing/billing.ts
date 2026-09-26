/**
 * SDIS billing boundary contracts.
 *
 *   Investigation → Billable Service → Charge → Invoice → Payment
 *
 * Rules:
 * - Idempotency keys prevent duplicate irreversible financial effects.
 * - No statutory tax rules are implemented from memory; any statutory logic later
 *   requires configurable, date-effective, source-versioned rules.
 */

import type {
  BillableServiceId,
  ChargeId,
  InvoiceId,
  OrderItemId,
  PaymentId,
} from '../../types/ids';
import { randomUUID } from 'node:crypto';

export interface BillableService {
  readonly id: BillableServiceId;
  readonly name: string;
  readonly modality: string;
  readonly priceCurrency: string;
  readonly priceAmount: number;
}

export interface Charge {
  readonly id: ChargeId;
  readonly orderItemId: OrderItemId;
  readonly serviceId: BillableServiceId;
  readonly amount: number;
  readonly currency: string;
  readonly createdAt: string;
  /** Idempotency key supplied by the caller. */
  readonly idempotencyKey: string;
}

export interface Invoice {
  readonly id: InvoiceId;
  readonly chargeIds: readonly ChargeId[];
  readonly status: 'DRAFT' | 'ISSUED' | 'PAID' | 'VOIDED';
}

export interface Payment {
  readonly id: PaymentId;
  readonly invoiceId: InvoiceId;
  readonly amount: number;
  readonly method: string;
  readonly receivedAt: string;
}

/** Charge ledger enforcing idempotency: a retry can never create a second charge. */
export class ChargeLedger {
  private readonly byKey = new Map<string, Charge>();

  addCharge(input: Omit<Charge, 'id' | 'createdAt'> & { createdAt?: string }): Charge {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) return existing; // idempotent replay — no duplicate financial effect
    const charge: Charge = {
      id: randomUUID() as ChargeId,
      ...input,
      createdAt: input.createdAt ?? new Date().toISOString(),
    };
    this.byKey.set(charge.idempotencyKey, charge);
    return charge;
  }

  getByOrderItem(orderItemId: OrderItemId): readonly Charge[] {
    return [...this.byKey.values()].filter((c) => c.orderItemId === orderItemId);
  }
}

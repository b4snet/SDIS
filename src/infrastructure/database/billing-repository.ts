/**
 * PostgreSQL Billing Repository.
 *
 * Implements the `ChargeRepository` port against migration 009
 * (`sdis.charges`, `sdis.billable_services`). Ledger semantics are durable:
 * the idempotency key is UNIQUE at the schema level and a duplicate insert
 * surfaces as the stable CONFLICT contract. Scope filtering is applied by the
 * application service using the session; RLS remains the database guarantee.
 */

import type { ChargeRepository } from '../../app/billing/billing-service';
import type { Charge } from '../../domain/billing/billing';
import type {
  BillableServiceId,
  ChargeId,
  FacilityId,
  OrderItemId,
} from '../../types/ids';
import { ConflictError, NotFoundError } from '../../app/errors';
import { Database, getDatabase } from './database';

interface ChargeRow {
  id: string;
  order_item_id: string;
  service_id: string;
  amount: string;
  currency: string;
  created_at: Date;
  idempotency_key: string;
}

function mapRow(row: ChargeRow): Charge {
  return {
    id: row.id as ChargeId,
    orderItemId: row.order_item_id as OrderItemId,
    serviceId: row.service_id as BillableServiceId,
    amount: Number(row.amount),
    currency: row.currency,
    createdAt: row.created_at.toISOString(),
    idempotencyKey: row.idempotency_key,
  };
}

export class PostgresChargeRepository implements ChargeRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(charge: Charge): Promise<Charge> {
    try {
      // The domain Charge has no scope field by contract — the authoritative
      // facility scope is DERIVED from the charged order item's owning order
      // inside a single INSERT, so RLS scoping is never client-derivable.
      const result = await this.db.query(
        `INSERT INTO sdis.charges
                (id, order_item_id, service_id, facility_id, amount, currency, created_at, idempotency_key)
             SELECT $1, $2, $3, o.facility_id, $4, $5, $6, $7
               FROM sdis.order_items oi
               JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
               WHERE oi.id = $2`,
        [
          charge.id,
          charge.orderItemId,
          charge.serviceId,
          charge.amount,
          charge.currency,
          charge.createdAt,
          charge.idempotencyKey,
        ],
      );
      if (result.rowCount === 0) {
        // The INSERT … SELECT persisted nothing: the order item does not exist.
        throw new NotFoundError('Order item not found — charge not recorded');
      }
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ConflictError(
          'A charge for this order item and service already exists',
        );
      }
      throw error;
    }
    return charge;
  }

  async findById(id: ChargeId): Promise<Charge | undefined> {
    const result = await this.db.query<ChargeRow>(
      `SELECT id, order_item_id, service_id, amount, currency, created_at, idempotency_key
             FROM sdis.charges WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0] as ChargeRow);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Charge[]> {
    const result = await this.db.query<ChargeRow>(
      `SELECT id, order_item_id, service_id, amount, currency, created_at, idempotency_key
             FROM sdis.charges WHERE order_item_id = $1 ORDER BY created_at`,
      [orderItemId],
    );
    return result.rows.map(mapRow);
  }

  async findByIdempotencyKey(key: string): Promise<Charge | undefined> {
    const result = await this.db.query<ChargeRow>(
      `SELECT id, order_item_id, service_id, amount, currency, created_at, idempotency_key
             FROM sdis.charges WHERE idempotency_key = $1`,
      [key],
    );
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0] as ChargeRow);
  }

  async findService(serviceId: BillableServiceId) {
    const result = await this.db.query<{
      id: string;
      facility_id: string;
      name: string;
      modality: string;
      price_amount: string;
      price_currency: string;
    }>(
      `SELECT id, facility_id, name, modality, price_amount, price_currency
             FROM sdis.billable_services WHERE id = $1`,
      [serviceId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id as BillableServiceId,
          name: row.name,
          modality: row.modality,
          priceCurrency: row.price_currency,
          priceAmount: Number(row.price_amount),
          facilityId: row.facility_id,
        }
      : undefined;
  }
}

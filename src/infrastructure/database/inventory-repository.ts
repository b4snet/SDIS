/**
 * PostgreSQL inventory repository (Steps 14 + 31) — the durable edge of the
 * append-only movement ledger. Balance is never stored: it is derived from
 * `sdis.stock_movements` by the application over the ledger rows. Uniqueness
 * (item SKU per facility, lot number per item, movement idempotency key) is
 * enforced by the schema (`db/migrations/012_inventory_schema.sql`,
 * `025_inventory_lifecycle.sql`) and surfaces as the existing CONFLICT
 * contract. The lot lifecycle, item active flag, movement attribution, and
 * the ATOMIC negative-stock guard live here at the persistence boundary.
 */

import { getDatabase } from './database';
import type { Database } from './database';
import type { FacilityId, InventoryItemId } from '../../types/ids';
import type {
  InventoryItem,
  LotStatus,
  StockBatch,
  StockMovement,
} from '../../domain/inventory/inventory';
import type { InventoryRepository } from '../../app/inventory/inventory-service';
import { ConflictError, NotFoundError, ValidationError } from '../../app/errors';

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error && typeof error === 'object' && (error as { code?: string }).code === '23505'
  );
}

interface ItemRow {
  readonly id: string;
  readonly facility_id: string;
  readonly sku: string;
  readonly name: string;
  readonly category: string;
  readonly active: boolean;
}

interface LotRow {
  readonly id: string;
  readonly item_id: string;
  readonly lot_number: string;
  readonly expiry_date: Date | string;
  readonly received_at: Date | string;
  readonly received_quantity: string | number;
  readonly status: string;
}

interface MovementRow {
  readonly id: string;
  readonly lot_id: string;
  readonly movement_type: string;
  readonly quantity_signed: string | number;
  readonly at: Date | string;
  readonly actor_ref: string;
  readonly reason: string;
  readonly operation_ref: string | null;
}

function mapItemRow(row: ItemRow): InventoryItem {
  return {
    id: row.id as InventoryItemId,
    facilityId: row.facility_id as FacilityId,
    sku: row.sku,
    name: row.name,
    category: row.category as InventoryItem['category'],
    active: row.active,
  };
}

function mapLotRow(row: LotRow): StockBatch {
  return {
    id: row.id as InventoryItemId,
    itemId: row.item_id as InventoryItemId,
    lotNumber: row.lot_number,
    expiryDate: new Date(row.expiry_date).toISOString(),
    receivedAt: new Date(row.received_at).toISOString(),
    receivedQuantity: Number(row.received_quantity),
    status: row.status as LotStatus,
  };
}

function mapMovementRow(row: MovementRow): StockMovement {
  return {
    id: row.id as InventoryItemId,
    batchId: row.lot_id as InventoryItemId,
    movementType: row.movement_type as StockMovement['movementType'],
    quantitySigned: Number(row.quantity_signed),
    at: new Date(row.at).toISOString(),
    actorRef: row.actor_ref,
    reason: row.reason,
    ...(row.operation_ref !== null ? { operationRef: row.operation_ref } : {}),
  };
}
export class PostgresInventoryRepository implements InventoryRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async saveItem(item: InventoryItem): Promise<InventoryItem> {
    try {
      await this.db.query(
        `INSERT INTO sdis.inventory_items (id, facility_id, sku, name, category, active)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [item.id, item.facilityId, item.sku, item.name, item.category, item.active],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('An inventory item with this sku already exists');
      }
      throw error;
    }
    return item;
  }

  async saveItemActive(itemId: InventoryItemId, active: boolean): Promise<InventoryItem> {
    const result = await this.db.query<ItemRow>(
      `UPDATE sdis.inventory_items SET active = $2 WHERE id = $1
       RETURNING id, facility_id, sku, name, category, active`,
      [itemId, active],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Inventory item not found');
    return mapItemRow(row);
  }

  async findItem(id: InventoryItemId): Promise<InventoryItem | undefined> {
    const result = await this.db.query<ItemRow>(
      `SELECT id, facility_id, sku, name, category, active
         FROM sdis.inventory_items WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapItemRow(row) : undefined;
  }

  async findItemBySku(
    facilityId: FacilityId,
    sku: string,
  ): Promise<InventoryItem | undefined> {
    const result = await this.db.query<ItemRow>(
      `SELECT id, facility_id, sku, name, category, active
         FROM sdis.inventory_items WHERE facility_id = $1 AND sku = $2`,
      [facilityId, sku],
    );
    const row = result.rows[0];
    return row ? mapItemRow(row) : undefined;
  }

  async listItems(facilityId: FacilityId): Promise<readonly InventoryItem[]> {
    const result = await this.db.query<ItemRow>(
      `SELECT id, facility_id, sku, name, category, active
         FROM sdis.inventory_items WHERE facility_id = $1 ORDER BY created_at`,
      [facilityId],
    );
    return result.rows.map(mapItemRow);
  }

  async saveBatch(batch: StockBatch): Promise<StockBatch> {
    try {
      await this.db.query(
        `INSERT INTO sdis.inventory_lots
                (id, item_id, lot_number, expiry_date, received_at, received_quantity, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          batch.id,
          batch.itemId,
          batch.lotNumber,
          batch.expiryDate.slice(0, 10),
          batch.receivedAt,
          batch.receivedQuantity,
          batch.status,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'A lot with this lot number already exists for this item',
        );
      }
      throw error;
    }
    return batch;
  }

  async findBatch(id: InventoryItemId): Promise<StockBatch | undefined> {
    const result = await this.db.query<LotRow>(
      `SELECT id, item_id, lot_number, expiry_date, received_at, received_quantity, status
         FROM sdis.inventory_lots WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? mapLotRow(row) : undefined;
  }

  async saveLotStatus(batchId: InventoryItemId, status: LotStatus): Promise<StockBatch> {
    const result = await this.db.query<LotRow>(
      `UPDATE sdis.inventory_lots SET status = $2 WHERE id = $1
       RETURNING id, item_id, lot_number, expiry_date, received_at, received_quantity, status`,
      [batchId, status],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Inventory lot not found');
    return mapLotRow(row);
  }

  async listBatchesByItem(itemId: InventoryItemId): Promise<readonly StockBatch[]> {
    const result = await this.db.query<LotRow>(
      `SELECT id, item_id, lot_number, expiry_date, received_at, received_quantity, status
         FROM sdis.inventory_lots WHERE item_id = $1 ORDER BY received_at`,
      [itemId],
    );
    return result.rows.map(mapLotRow);
  }

  async listLotsByFacilityAndExpiry(
    facilityId: FacilityId,
    options: { readonly asOf: string; readonly horizonDays: number },
  ): Promise<readonly StockBatch[]> {
    const result = await this.db.query<LotRow>(
      `SELECT l.id, l.item_id, l.lot_number, l.expiry_date, l.received_at,
              l.received_quantity, l.status
         FROM sdis.inventory_lots l
         JOIN sdis.inventory_items i ON i.id = l.item_id
        WHERE i.facility_id = $1
          AND i.active
          AND l.expiry_date <= (SELECT ($2::timestamptz + make_interval(days => $3::int))::date)
        ORDER BY l.expiry_date, l.received_at, l.lot_number`,
      [facilityId, options.asOf, options.horizonDays],
    );
    return result.rows.map(mapLotRow);
  }

  async saveMovement(movement: StockMovement): Promise<StockMovement> {
    try {
      await this.db.query(
        `INSERT INTO sdis.stock_movements
                (id, lot_id, movement_type, quantity_signed, at, actor_ref, reason, operation_ref, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          movement.id,
          movement.batchId,
          movement.movementType,
          movement.quantitySigned,
          movement.at,
          movement.actorRef,
          movement.reason,
          movement.operationRef ?? null,
          `movement:${movement.id}`,
        ],
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A movement with this idempotency key already exists');
      }
      throw error;
    }
    return movement;
  }

  /**
   * ATOMIC depletion (Step 31 §19, CON-01 hardened): coverage check and
   * append in ONE transaction, serialized per lot. The lot row is locked
   * (`SELECT … FOR UPDATE`) BEFORE the coverage check, so concurrent
   * depletions of the same lot — even under distinct idempotency keys —
   * serialize: the loser blocks on the lock, then re-evaluates coverage
   * against the winner's committed row and is rejected when uncovered.
   * Negative stock is impossible at the persistence boundary, not just in
   * application memory. (A bare `INSERT … SELECT WHERE SUM…` does NOT
   * serialize under READ COMMITTED — the aggregate subquery takes no row
   * locks — so the explicit lot lock is the root-cause fix, not the
   * single-statement shape.)
   */
  async applyDepletingMovement(
    movement: StockMovement,
    quantity: number,
  ): Promise<StockMovement> {
    try {
      return await this.db.transaction(async (client) => {
        const locked = await client.query(
          `SELECT id FROM sdis.inventory_lots WHERE id = $1 FOR UPDATE`,
          [movement.batchId],
        );
        if (!locked.rowCount) {
          throw new ValidationError('Unknown lot for this movement');
        }
        const coverage = await client.query<{ balance: string }>(
          `SELECT COALESCE(SUM(m.quantity_signed), 0) AS balance
             FROM sdis.stock_movements m
            WHERE m.lot_id = $1`,
          [movement.batchId],
        );
        if (Number(coverage.rows[0]?.balance ?? 0) < quantity) {
          throw new ValidationError('Insufficient stock for this movement');
        }
        await client.query(
          `INSERT INTO sdis.stock_movements
                (id, lot_id, movement_type, quantity_signed, at, actor_ref, reason, operation_ref, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            movement.id,
            movement.batchId,
            movement.movementType,
            movement.quantitySigned,
            movement.at,
            movement.actorRef,
            movement.reason,
            movement.operationRef ?? null,
            `movement:${movement.id}`,
          ],
        );
        return movement;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A movement with this idempotency key already exists');
      }
      throw error;
    }
  }

  async listMovementsByOperation(
    operationRef: string,
  ): Promise<readonly StockMovement[]> {
    const result = await this.db.query<MovementRow>(
      `SELECT id, lot_id, movement_type, quantity_signed, at, actor_ref, reason, operation_ref
         FROM sdis.stock_movements WHERE operation_ref = $1 ORDER BY at, id`,
      [operationRef],
    );
    return result.rows.map(mapMovementRow);
  }

  async listMovementsByItem(
    itemId: InventoryItemId,
    limit: number,
  ): Promise<readonly StockMovement[]> {
    const result = await this.db.query<MovementRow>(
      `SELECT m.id, m.lot_id, m.movement_type, m.quantity_signed, m.at,
              m.actor_ref, m.reason, m.operation_ref
         FROM sdis.stock_movements m
         JOIN sdis.inventory_lots l ON l.id = m.lot_id
        WHERE l.item_id = $1
        ORDER BY m.at DESC, m.id DESC
        LIMIT $2`,
      [itemId, limit],
    );
    return result.rows.map(mapMovementRow);
  }
  async listMovementsByBatch(
    batchId: InventoryItemId,
  ): Promise<readonly StockMovement[]> {
    const result = await this.db.query<MovementRow>(
      `SELECT id, lot_id, movement_type, quantity_signed, at, actor_ref, reason, operation_ref
         FROM sdis.stock_movements WHERE lot_id = $1 ORDER BY at`,
      [batchId],
    );
    return result.rows.map(mapMovementRow);
  }
}

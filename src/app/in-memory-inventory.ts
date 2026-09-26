/**
 * In-memory inventory adapters (test/development) mirroring the migration-012
 * + 025 semantics: item SKU UNIQUE per facility, lot number UNIQUE per item,
 * movement idempotency key UNIQUE, append-only movements, controlled lot
 * lifecycle, and an ATOMIC negative-stock guard on depleting movements
 * (the Step-31 concurrency boundary mirrors the PostgreSQL implementation).
 */

import type { FacilityId, InventoryItemId } from '../types/ids';
import type {
  InventoryItem,
  LotStatus,
  StockBatch,
  StockMovement,
} from '../domain/inventory/inventory';
import type { InventoryRepository } from './inventory/inventory-service';
import { ConflictError, NotFoundError, ValidationError } from './errors';

export class InMemoryInventoryRepository implements InventoryRepository {
  private readonly items = new Map<InventoryItemId, InventoryItem>();
  private readonly itemsBySku = new Map<string, InventoryItemId>();
  private readonly batches = new Map<InventoryItemId, StockBatch>();
  private readonly batchesByItem = new Map<InventoryItemId, InventoryItemId[]>();
  private readonly movements = new Map<InventoryItemId, StockMovement>();
  private readonly movementsByBatch = new Map<InventoryItemId, InventoryItemId[]>();
  private readonly movementsByOperation = new Map<string, InventoryItemId[]>();
  private readonly movementKeys = new Set<string>();

  async saveItem(item: InventoryItem): Promise<InventoryItem> {
    const skuKey = `${item.facilityId}:${item.sku}`;
    if (this.itemsBySku.has(skuKey)) {
      throw new ConflictError('An inventory item with this sku already exists');
    }
    this.items.set(item.id, item);
    this.itemsBySku.set(skuKey, item.id);
    return item;
  }

  async findItem(id: InventoryItemId): Promise<InventoryItem | undefined> {
    return this.items.get(id);
  }

  async findItemBySku(
    facilityId: FacilityId,
    sku: string,
  ): Promise<InventoryItem | undefined> {
    const id = this.itemsBySku.get(`${facilityId}:${sku}`);
    return id ? this.items.get(id) : undefined;
  }

  async listItems(facilityId: FacilityId): Promise<readonly InventoryItem[]> {
    return [...this.items.values()].filter((item) => item.facilityId === facilityId);
  }

  async saveItemActive(itemId: InventoryItemId, active: boolean): Promise<InventoryItem> {
    const item = this.items.get(itemId);
    if (!item) throw new NotFoundError('Inventory item not found');
    const updated: InventoryItem = { ...item, active };
    this.items.set(itemId, updated);
    return updated;
  }

  async saveBatch(batch: StockBatch): Promise<StockBatch> {
    const siblings = this.batchesByItem.get(batch.itemId) ?? [];
    for (const siblingId of siblings) {
      if (this.batches.get(siblingId)?.lotNumber === batch.lotNumber) {
        throw new ConflictError(
          'A lot with this lot number already exists for this item',
        );
      }
    }
    this.batches.set(batch.id, batch);
    this.batchesByItem.set(batch.itemId, [...siblings, batch.id]);
    return batch;
  }

  async findBatch(id: InventoryItemId): Promise<StockBatch | undefined> {
    return this.batches.get(id);
  }

  async listBatchesByItem(itemId: InventoryItemId): Promise<readonly StockBatch[]> {
    return (this.batchesByItem.get(itemId) ?? []).flatMap((id) => {
      const batch = this.batches.get(id);
      return batch ? [batch] : [];
    });
  }

  async saveLotStatus(batchId: InventoryItemId, status: LotStatus): Promise<StockBatch> {
    const batch = this.batches.get(batchId);
    if (!batch) throw new NotFoundError('Inventory lot not found');
    const updated: StockBatch = { ...batch, status };
    this.batches.set(batchId, updated);
    return updated;
  }

  async saveMovement(movement: StockMovement): Promise<StockMovement> {
    const key = `movement:${movement.id}`;
    if (this.movementKeys.has(key)) {
      throw new ConflictError('A movement with this idempotency key already exists');
    }
    this.movements.set(movement.id, movement);
    this.movementKeys.add(key);
    this.movementsByBatch.set(movement.batchId, [
      ...(this.movementsByBatch.get(movement.batchId) ?? []),
      movement.id,
    ]);
    if (movement.operationRef !== undefined) {
      this.movementsByOperation.set(movement.operationRef, [
        ...(this.movementsByOperation.get(movement.operationRef) ?? []),
        movement.id,
      ]);
    }
    return movement;
  }

  /**
   * ATOMIC depletion (Step 31 §19, INT-33 hardened): coverage is verified and
   * the movement appended in one SYNCHRONOUS step — no interleaving in-process.
   * The earlier `await` before the check opened a window in which two racing
   * consumers both read the same balance and both appended (overdraw). The
   * guard mirrors the PostgreSQL single-statement conditional INSERT.
   */
  async applyDepletingMovement(
    movement: StockMovement,
    quantity: number,
  ): Promise<StockMovement> {
    const movements = this.listMovementsByBatchSync(movement.batchId);
    const balance = movements.reduce((sum, m) => sum + m.quantitySigned, 0);
    if (balance < quantity) {
      throw new ValidationError('Insufficient stock for this movement');
    }
    return this.saveMovement(movement);
  }

  /** Synchronous snapshot for the atomic depletion guard above. */
  private listMovementsByBatchSync(batchId: InventoryItemId): readonly StockMovement[] {
    return (this.movementsByBatch.get(batchId) ?? []).flatMap((id) => {
      const movement = this.movements.get(id);
      return movement ? [movement] : [];
    });
  }

  async listMovementsByBatch(
    batchId: InventoryItemId,
  ): Promise<readonly StockMovement[]> {
    return (this.movementsByBatch.get(batchId) ?? []).flatMap((id) => {
      const movement = this.movements.get(id);
      return movement ? [movement] : [];
    });
  }

  async listMovementsByOperation(
    operationRef: string,
  ): Promise<readonly StockMovement[]> {
    return (this.movementsByOperation.get(operationRef) ?? []).flatMap((id) => {
      const movement = this.movements.get(id);
      return movement ? [movement] : [];
    });
  }

  async listMovementsByItem(
    itemId: InventoryItemId,
    limit: number,
  ): Promise<readonly StockMovement[]> {
    const all: StockMovement[] = [];
    for (const batchId of this.batchesByItem.get(itemId) ?? []) {
      all.push(...(await this.listMovementsByBatch(batchId)));
    }
    return all
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-limit)
      .reverse();
  }

  async listLotsByFacilityAndExpiry(
    facilityId: FacilityId,
    options: { readonly asOf: string; readonly horizonDays: number },
  ): Promise<readonly StockBatch[]> {
    const asOfMs = new Date(options.asOf).getTime();
    const horizonMs = asOfMs + options.horizonDays * 24 * 60 * 60 * 1000;
    const rows: StockBatch[] = [];
    for (const batch of this.batches.values()) {
      const item = this.items.get(batch.itemId);
      if (!item || item.facilityId !== facilityId || !item.active) continue;
      const expiry = new Date(batch.expiryDate).getTime();
      if (expiry <= horizonMs) rows.push(batch);
    }
    return rows.sort(
      (a, b) =>
        new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime() ||
        new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime() ||
        a.lotNumber.localeCompare(b.lotNumber),
    );
  }
}

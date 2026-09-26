/**
 * SDIS Laboratory Medical Inventory boundary — separate from diagnostic results.
 *
 * Reagents, consumables, kits, controls, calibrators: batches, lot numbers, expiry,
 * storage, stock movement, wastage, procurement, vendor. Inventory state is never
 * duplicated across laboratory departments.
 */

import type { FacilityId, InventoryItemId } from '../../types/ids';

/**
 * Lot lifecycle (Step 31). CREATED on registration; transitions are
 * application-controlled and monotonic — no arbitrary status mutation:
 *
 *   AVAILABLE ─→ QUARANTINED ─→ RETIRED
 *        │            │
 *        └── RELEASED ┘ (back to AVAILABLE; RETIRED is terminal)
 *
 * An EXPIRED lot is never a stored status: expiry is DERIVED from the
 * recorded expiry date (time moves, history must not be rewritten), and the
 * application gate blocks depleting movements against expired lots.
 */
export const LOT_STATUSES = ['AVAILABLE', 'QUARANTINED', 'RELEASED', 'RETIRED'] as const;

export type LotStatus = (typeof LOT_STATUSES)[number];

export interface InventoryItem {
  readonly id: InventoryItemId;
  readonly facilityId: FacilityId;
  readonly sku: string;
  readonly name: string;
  readonly category:
    'REAGENT' | 'CONSUMABLE' | 'KIT' | 'CONTROL' | 'CALIBRATOR' | 'OTHER';
  /** Operational lifecycle (Step 31): retired items accept no new stock. */
  readonly active: boolean;
}

export interface StockBatch {
  readonly id: InventoryItemId;
  readonly itemId: InventoryItemId;
  readonly lotNumber: string;
  readonly expiryDate: string;
  readonly receivedAt: string;
  readonly receivedQuantity: number;
  /** Controlled lifecycle state (Step 31); CREATED/AVAILABLE on registration. */
  readonly status: LotStatus;
}

export type StockMovementType = 'IN' | 'OUT' | 'WASTAGE' | 'RETURN';

export interface StockMovement {
  readonly id: InventoryItemId;
  readonly batchId: InventoryItemId;
  readonly movementType: StockMovementType;
  /** Positive for IN/RETURN, negative for OUT/WASTAGE. */
  readonly quantitySigned: number;
  readonly at: string;
  readonly actorRef: string;
  /**
   * Required attribution (Step 31 §8): WHY the stock changed. Bounded,
   * non-PHI label (e.g. 'expired-disposal', 'receipt', 'qc-consumption').
   */
  readonly reason: string;
  /**
   * Laboratory-operation traceability (Step 31 §14): which order/QC record
   * consumed this lot, when the workflow can establish the linkage. Absent
   * for bulk/operational movements — never fabricated.
   */
  readonly operationRef?: string;
}

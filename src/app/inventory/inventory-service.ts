/**
 * SDIS laboratory inventory application service (Step 14).
 *
 * Makes the EXISTING inventory domain contract
 * (`src/domain/inventory/inventory.ts`) a real capability: items and lots are
 * created through the domain shapes, and stock state is an APPEND-ONLY
 * movement ledger — there is no balance overwrite and no second ledger.
 * Current balance is always DERIVED from the recorded movements, so a
 * partially-applied movement is impossible by construction (one movement
 * row = one state delta; the derive step is read-only).
 *
 * Scope (docs/TENANCY.md): every object is facility-scoped server-side from
 * the session; the service never trusts client-supplied scope. Authorization
 * goes through the ONE authorization engine (fail-closed when absent).
 *
 * Operational boundary: inventory is infrastructure, not clinical logic — no
 * clinical decision rules, no procurement, no automatic reordering, no
 * patient linkage beyond what the domain defines (none).
 */

import { randomUUID } from 'node:crypto';
import type { FacilityId, InventoryItemId } from '../../types/ids';
import type {
  InventoryItem,
  LotStatus,
  StockBatch,
  StockMovement,
  StockMovementType,
} from '../../domain/inventory/inventory';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';

/** Lot lifecycle vocabulary (domain-mirrored for runtime validation). */
const LOT_STATUS_VOCABULARY: readonly LotStatus[] = [
  'AVAILABLE',
  'QUARANTINED',
  'RELEASED',
  'RETIRED',
];

/** Movement transitions that are permitted (monotonic; RETIRED is terminal). */
const LOT_TRANSITIONS: Readonly<Record<LotStatus, readonly LotStatus[]>> = {
  AVAILABLE: ['QUARANTINED', 'RETIRED'],
  QUARANTINED: ['RELEASED', 'RETIRED'],
  RELEASED: ['QUARANTINED', 'RETIRED'],
  RETIRED: [],
};

/**
 * Persistence port for the inventory lifecycle. `saveMovement` is the ONLY
 * write to stock state and must be unique on the movement idempotency key —
 * the append-only guarantee is enforced by the store, not the service.
 */
export interface InventoryRepository {
  saveItem(item: InventoryItem): Promise<InventoryItem>;
  findItem(id: InventoryItemId): Promise<InventoryItem | undefined>;
  findItemBySku(facilityId: FacilityId, sku: string): Promise<InventoryItem | undefined>;
  listItems(facilityId: FacilityId): Promise<readonly InventoryItem[]>;

  saveBatch(batch: StockBatch): Promise<StockBatch>;
  findBatch(id: InventoryItemId): Promise<StockBatch | undefined>;
  listBatchesByItem(itemId: InventoryItemId): Promise<readonly StockBatch[]>;

  /** Appends one movement; must reject a duplicate idempotency key. */
  saveMovement(movement: StockMovement): Promise<StockMovement>;
  listMovementsByBatch(batchId: InventoryItemId): Promise<readonly StockMovement[]>;

  // ---- Step 31: lifecycle, traceability, and operational queries ----------

  /** Applies a controlled lot-status transition (uniqueness/monotonicity enforced here). */
  saveLotStatus(batchId: InventoryItemId, status: LotStatus): Promise<StockBatch>;
  /** Persists the item operational lifecycle (retired items accept no stock). */
  saveItemActive(itemId: InventoryItemId, active: boolean): Promise<InventoryItem>;
  /**
   * Single atomic depletion: verifies coverage and appends inside ONE
   * concurrency-safe step so two racing consumers can never overdraw.
   * Rejects when the derived balance is below `quantity`.
   */
  applyDepletingMovement(
    movement: StockMovement,
    quantity: number,
  ): Promise<StockMovement>;
  /** Movements referencing a laboratory operation (usage traceability, §14). */
  listMovementsByOperation(operationRef: string): Promise<readonly StockMovement[]>;
  /** Item-centric movement view (§27 recent-movements query). */
  listMovementsByItem(
    itemId: InventoryItemId,
    limit: number,
  ): Promise<readonly StockMovement[]>;
  /** Expiring/expired lots over ACTIVE items in facility (§11 expiry handling). */
  listLotsByFacilityAndExpiry(
    facilityId: FacilityId,
    options: { readonly asOf: string; readonly horizonDays: number },
  ): Promise<readonly StockBatch[]>;
}

export interface RegisterItemInput {
  readonly sku: string;
  readonly name: string;
  readonly category: InventoryItem['category'];
}

export interface RegisterLotInput {
  readonly itemId: InventoryItemId;
  readonly lotNumber: string;
  /** ISO-8601 date (YYYY-MM-DD) or timestamp; the domain stores it verbatim. */
  readonly expiryDate: string;
  readonly receivedQuantity: number;
}

export type MovementInputType = 'IN' | 'OUT' | 'WASTAGE' | 'RETURN';

export interface ReceiveStockInput {
  readonly itemId: InventoryItemId;
  readonly lotNumber: string;
  readonly expiryDate: string;
  readonly quantity: number;
  /** Required attribution label for the receipt movement (Step 31 §8). */
  readonly reason?: string;
  readonly idempotencyKey?: string;
}

/** Reason-code vocabulary for controlled adjustments/disposals (Step 31 §18). */
export const MOVEMENT_REASON_CODES = [
  'receipt',
  'consumption',
  'qc-consumption',
  'wastage',
  'expired-disposal',
  'damaged-disposal',
  'quarantine-disposal',
  'correction',
  'return-to-stock',
] as const;

export type MovementReasonCode = (typeof MOVEMENT_REASON_CODES)[number];

export interface IssueStockInput {
  readonly batchId: InventoryItemId;
  readonly quantity: number;
  /** Wastage is an explicitly recorded OUT with a reason label. */
  readonly movementType: 'OUT' | 'WASTAGE' | 'RETURN';
  /**
   * Required attribution (Step 31 §8): why the stock changed. Bounded,
   * non-PHI label persisted with the movement.
   */
  readonly reason: string;
  /**
   * Optional laboratory-operation reference (order/QC record id) for
   * lot-level usage traceability (Step 31 §14). Never fabricated.
   */
  readonly operationRef?: string;
  readonly idempotencyKey?: string;
}

export interface ItemDTO {
  readonly id: string;
  readonly facilityId: string;
  readonly sku: string;
  readonly name: string;
  readonly category: InventoryItem['category'];
  readonly active: boolean;
}

export interface LotDTO {
  readonly id: string;
  readonly itemId: string;
  readonly lotNumber: string;
  readonly expiryDate: string;
  readonly receivedAt: string;
  readonly receivedQuantity: number;
  readonly status: LotStatus;
  /** Derived from the recorded expiry date — never a stored status. */
  readonly expiryStatus: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED';
}

export interface BatchStatusDTO {
  readonly lot: LotDTO;
  readonly balance: number;
  /**
   * Whether the lot may be consumed NOW (Step 31 §11/§17): expiry derived,
   * lifecycle status applied. Quarantined/retired/expired lots are excluded
   * from consumption but remain fully visible here and in history.
   */
  readonly consumable: boolean;
}

export interface ItemBalanceDTO {
  readonly itemId: string;
  readonly facilityId: string;
  readonly sku: string;
  readonly name: string;
  readonly totalBalance: number;
  readonly lots: readonly BatchStatusDTO[];
}

export interface MovementDTO {
  readonly id: string;
  readonly batchId: string;
  readonly movementType: StockMovementType;
  readonly quantitySigned: number;
  readonly at: string;
  readonly reason: string;
  readonly operationRef?: string;
}

export interface ExpiringLotsDTO {
  readonly lots: readonly (LotDTO & {
    readonly itemId: string;
    readonly sku: string;
    readonly balance: number;
  })[];
  readonly generatedAt: string;
}

export interface LotUsageDTO {
  readonly lot: LotDTO;
  readonly movements: readonly MovementDTO[];
}

/** Lot lifecycle transition input (Step 31 §6): controlled, audited, reasoned. */
export interface LotStatusChangeInput {
  readonly batchId: InventoryItemId;
  readonly target: LotStatus;
  /** Required bounded reason (quarantine cause, retirement justification...). */
  readonly reason: string;
  readonly idempotencyKey?: string;
}

/** Item lifecycle input: retiring an item stops all future stock activity. */
export interface ItemStatusChangeInput {
  readonly itemId: InventoryItemId;
  readonly active: boolean;
  readonly reason: string;
  readonly idempotencyKey?: string;
}

export interface InventoryServiceDependencies {
  readonly inventory: InventoryRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

const INVENTORY_SOURCE = {
  kind: 'SYSTEM',
  label: 'application inventory movement',
} as const;

/** Receipt movements default to the receipt reason; callers may override. */
const DEFAULT_RECEIPT_REASON = 'receipt';

/**
 * The domain's item categories, mirrored for runtime validation (the domain
 * union is erased at runtime and the schema CHECK enforces the same set).
 */
const ITEM_CATEGORIES: readonly InventoryItem['category'][] = [
  'REAGENT',
  'CONSUMABLE',
  'KIT',
  'CONTROL',
  'CALIBRATOR',
  'OTHER',
];

/** Expiry is operational information only — never a clinical usability rule. */
const EXPIRING_SOON_DAYS = 30;

/** Three-state expiry view (Step 31 §11): VALID / EXPIRING_SOON / EXPIRED. */
function expiryStatusOf(
  batch: StockBatch,
  now: string,
): 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' {
  const expiry = new Date(batch.expiryDate).getTime();
  const nowMs = new Date(now).getTime();
  if (expiry < nowMs) return 'EXPIRED';
  if (expiry - nowMs <= EXPIRING_SOON_DAYS * 24 * 60 * 60 * 1000) {
    return 'EXPIRING_SOON';
  }
  return 'VALID';
}

/**
 * Whether a lot may be consumed NOW (Step 31 §11/§17): expiry derived from
 * the recorded date, lifecycle status applied. Expired, quarantined, and
 * retired lots remain visible in history — they are only excluded from
 * NEW depletion.
 */
function isConsumable(batch: StockBatch, now: string): boolean {
  if (batch.status !== 'AVAILABLE' && batch.status !== 'RELEASED') return false;
  return expiryStatusOf(batch, now) !== 'EXPIRED';
}

function toItemDTO(item: InventoryItem): ItemDTO {
  return {
    id: item.id,
    facilityId: item.facilityId,
    sku: item.sku,
    name: item.name,
    category: item.category,
    active: item.active,
  };
}

function toLotDTO(batch: StockBatch): LotDTO {
  return {
    id: batch.id,
    itemId: batch.itemId,
    lotNumber: batch.lotNumber,
    expiryDate: batch.expiryDate,
    receivedAt: batch.receivedAt,
    receivedQuantity: batch.receivedQuantity,
    status: batch.status,
    expiryStatus: expiryStatusOf(batch, new Date().toISOString()),
  };
}

/** Signed delta for a movement type (domain rule, mirrored for validation). */
function signedDelta(type: StockMovementType, quantity: number): number {
  return type === 'IN' || type === 'RETURN' ? quantity : -quantity;
}

function toMovementDTO(movement: StockMovement): MovementDTO {
  return {
    id: movement.id,
    batchId: movement.batchId,
    movementType: movement.movementType,
    quantitySigned: movement.quantitySigned,
    at: movement.at,
    reason: movement.reason,
    ...(movement.operationRef !== undefined
      ? { operationRef: movement.operationRef }
      : {}),
  };
}

/**
 * Validates a movement/transition attribution reason (Step 31 §8/§22):
 * required, bounded, free of control characters — non-PHI by contract.
 */
function assertValidReason(reason: string, what: string): void {
  const trimmed = reason.trim();
  if (trimmed.length === 0 || trimmed.length > 120) {
    throw new ValidationError(`${what} reason must be 1-120 characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ValidationError(`${what} reason must not contain control characters`);
  }
}

export class InventoryService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: InventoryServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Registers an inventory item (reagent, consumable, kit, control,
   * calibrator). SKU is unique per facility — the store rejects duplicates.
   */
  async registerItem(
    session: ApplicationSession | undefined,
    input: RegisterItemInput,
  ): Promise<ItemDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    if (!input.sku || !input.name || !input.category) {
      throw new ValidationError('An inventory item requires a sku, name, and category');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(input.sku)) {
      throw new ValidationError(
        'Inventory item sku must be 2-64 safe identifier characters',
      );
    }
    if (input.name.trim().length === 0 || input.name.length > 200) {
      throw new ValidationError('Inventory item name must be 1-200 characters');
    }
    if (!ITEM_CATEGORIES.includes(input.category)) {
      throw new ValidationError('Unsupported inventory item category');
    }
    const existing = await this.deps.inventory.findItemBySku(
      facilityId,
      input.sku.trim(),
    );
    if (existing) {
      throw new ConflictError('An inventory item with this sku already exists');
    }
    const item: InventoryItem = {
      id: randomUUID() as InventoryItemId,
      facilityId,
      sku: input.sku.trim(),
      name: input.name.trim(),
      category: input.category,
      active: true,
    };
    const persisted = await this.deps.inventory.saveItem(item);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'inventory-item',
      objectId: persisted.id,
      at: new Date().toISOString(),
      source: INVENTORY_SOURCE,
      detail: `inventory item ${persisted.sku} registered (${persisted.category})`,
    });
    return toItemDTO(persisted);
  }

  /**
   * Registers a lot/batch for an existing scope-verified item. Lots are
   * immutable once created ("do not silently modify existing lots") — a
   * duplicate lot number on the same item surfaces as CONFLICT.
   */
  async registerLot(
    session: ApplicationSession | undefined,
    input: RegisterLotInput,
  ): Promise<LotDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    if (!input.itemId || !input.lotNumber || !input.expiryDate) {
      throw new ValidationError('A lot requires an item, lot number, and expiry date');
    }
    if (input.lotNumber.trim().length === 0 || input.lotNumber.length > 100) {
      throw new ValidationError('Lot number must be 1-100 characters');
    }
    if (!Number.isFinite(input.receivedQuantity) || input.receivedQuantity <= 0) {
      throw new ValidationError('Lot received quantity must be a positive number');
    }
    if (Number.isNaN(new Date(input.expiryDate).getTime())) {
      throw new ValidationError('Lot expiry date must be a valid date');
    }
    const item = await this.requireScopedItem(facilityId, input.itemId);
    const duplicates = await this.deps.inventory.listBatchesByItem(item.id);
    if (duplicates.some((batch) => batch.lotNumber === input.lotNumber.trim())) {
      throw new ConflictError('A lot with this lot number already exists for this item');
    }
    const batch: StockBatch = {
      id: randomUUID() as InventoryItemId,
      itemId: item.id,
      lotNumber: input.lotNumber.trim(),
      expiryDate: input.expiryDate,
      receivedAt: new Date().toISOString(),
      receivedQuantity: input.receivedQuantity,
      status: 'AVAILABLE',
    };
    const persisted = await this.deps.inventory.saveBatch(batch);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'inventory-lot',
      objectId: persisted.id,
      at: persisted.receivedAt,
      source: INVENTORY_SOURCE,
      detail: `lot ${persisted.lotNumber} registered for item ${item.sku}`,
    });
    // The declared receipt enters the ONE ledger as an IN movement — the
    // batch's `receivedQuantity` is the receipt record, never a second ledger.
    await this.applyMovement(
      session,
      persisted.id,
      'IN',
      input.receivedQuantity,
      DEFAULT_RECEIPT_REASON,
    );
    return toLotDTO(persisted);
  }

  /**
   * Receives stock: creates the lot when absent (or reuses the existing one)
   * and appends an IN movement. Keyed retries return the stored movement
   * without any duplicate stock.
   */
  async receiveStock(
    session: ApplicationSession | undefined,
    input: ReceiveStockInput,
  ): Promise<MovementDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    if (!input.itemId || !input.lotNumber || !input.expiryDate) {
      throw new ValidationError(
        'Stock receipt requires an item, lot number, and expiry date',
      );
    }
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('Received quantity must be a positive number');
    }
    if (Number.isNaN(new Date(input.expiryDate).getTime())) {
      throw new ValidationError('Lot expiry date must be a valid date');
    }
    const item = await this.requireScopedItem(facilityId, input.itemId);
    // Retired items accept no new stock (Step 31 §8).
    if (!item.active) {
      throw new ConflictError('Stock cannot be received against an inactive item');
    }
    const movement = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.INVENTORY_RECEIVE,
      input.idempotencyKey,
      () =>
        this.appendMovement(
          session,
          item.id,
          input.lotNumber,
          input.expiryDate,
          'IN',
          input.quantity,
          undefined,
          input.reason ?? DEFAULT_RECEIPT_REASON,
        ),
      session,
    );
    return toMovementDTO(movement);
  }

  /**
   * Issues/consumes/wastes stock from an existing scope-verified lot as an
   * OUT/WASTAGE/RETURN movement. The derived balance must cover the quantity
   * — the ledger never goes negative and there is no balance overwrite.
   */
  async issueStock(
    session: ApplicationSession | undefined,
    input: IssueStockInput,
  ): Promise<MovementDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    if (!input.batchId || !input.movementType) {
      throw new ValidationError('Stock issue requires a batch and a movement type');
    }
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new ValidationError('Issued quantity must be a positive number');
    }
    // Every movement is attributable (Step 31 §8) — no unexplained changes.
    assertValidReason(input.reason, 'Stock movement');
    if (input.operationRef !== undefined) {
      const opRef = input.operationRef.trim();
      if (opRef.length === 0 || opRef.length > 120) {
        throw new ValidationError('operationRef must be 1-120 characters');
      }
    }
    const batch = await this.requireScopedBatch(facilityId, input.batchId);
    const item = await this.requireScopedItem(facilityId, batch.itemId);
    if (!item.active) {
      throw new ConflictError('Stock cannot be issued against an inactive item');
    }
    // Expiry/lifecycle gate (Step 31 §11/§17): consuming movements (OUT) are
    // refused for expired, quarantined, or retired lots. WASTAGE is the
    // DISPOSAL path (Step 31 §18) — recording wastage of expired/damaged
    // stock is exactly how it leaves the ledger — so only a retired lot
    // blocks wastage. History is never rewritten either way.
    if (input.movementType === 'OUT' && !isConsumable(batch, new Date().toISOString())) {
      throw new ValidationError(
        `Lot ${batch.lotNumber} is not consumable (${batch.status}, expiry ${batch.expiryDate})`,
      );
    }
    if (input.movementType === 'WASTAGE' && batch.status === 'RETIRED') {
      throw new ValidationError('Stock cannot be wasted from a retired lot');
    }
    if (input.movementType === 'RETURN' && batch.status === 'RETIRED') {
      throw new ValidationError('Stock cannot be returned to a retired lot');
    }
    const movement = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.INVENTORY_ISSUE,
      input.idempotencyKey,
      () =>
        this.appendMovement(
          session,
          batch.itemId,
          undefined,
          undefined,
          input.movementType,
          input.quantity,
          input.batchId,
          input.reason.trim(),
          input.operationRef?.trim(),
        ),
      session,
    );
    return toMovementDTO(movement);
  }

  /**
   * Current balance for one item: derived from the recorded movements of
   * every lot of the item (read-only aggregation — the single source of
   * truth is the movement ledger).
   */
  async getBalance(
    session: ApplicationSession | undefined,
    itemId: InventoryItemId,
  ): Promise<ItemBalanceDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    const item = await this.requireScopedItem(facilityId, itemId);
    const batches = await this.deps.inventory.listBatchesByItem(item.id);
    const now = new Date().toISOString();
    let total = 0;
    const lots: BatchStatusDTO[] = [];
    for (const batch of batches) {
      const movements = await this.deps.inventory.listMovementsByBatch(batch.id);
      const balance = movements.reduce(
        (sum, movement) => sum + movement.quantitySigned,
        0,
      );
      total += balance;
      lots.push({
        lot: toLotDTO(batch),
        balance,
        consumable: isConsumable(batch, now),
      });
    }
    return {
      itemId: item.id,
      facilityId: item.facilityId,
      sku: item.sku,
      name: item.name,
      totalBalance: total,
      lots,
    };
  }

  /**
   * Lot-level status for one item: per-lot balance, expiry status, and
   * consumability (operational information only — never a clinical rule).
   */
  async getLotStatus(
    session: ApplicationSession | undefined,
    itemId: InventoryItemId,
  ): Promise<Omit<ItemBalanceDTO, 'totalBalance'>> {
    const balance = await this.getBalance(session, itemId);
    const { totalBalance: _totalBalance, ...lots } = balance;
    return lots;
  }

  /**
   * Controlled lot lifecycle transition (Step 31 §6): QUARANTINE (from
   * AVAILABLE/RELEASED), RELEASE (from QUARANTINED), RETIRE (terminal).
   * Audited with the required reason; RETIRED is terminal and expiry is
   * never rewritten — the derived expiry gate continues to apply.
   */
  async changeLotStatus(
    session: ApplicationSession | undefined,
    input: LotStatusChangeInput,
  ): Promise<LotDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    assertValidReason(input.reason, 'Lot transition');
    if (!LOT_STATUS_VOCABULARY.includes(input.target)) {
      throw new ValidationError('Unsupported lot status');
    }
    const facilityId = session.facilityId;
    const batch = await this.requireScopedBatch(facilityId, input.batchId);
    const allowed = LOT_TRANSITIONS[batch.status];
    if (!allowed.includes(input.target)) {
      throw new ConflictError(
        `Lot cannot transition from ${batch.status} to ${input.target}`,
      );
    }
    const persisted = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.INVENTORY_LOT_STATUS,
      input.idempotencyKey,
      async () => {
        const saved = await this.deps.inventory.saveLotStatus(
          input.batchId,
          input.target,
        );
        await this.audit.record(session, {
          action: 'TRANSITIONED',
          objectType: 'inventory-lot',
          objectId: saved.id,
          at: new Date().toISOString(),
          source: INVENTORY_SOURCE,
          detail: `lot ${saved.lotNumber} ${batch.status} -> ${input.target}: ${input.reason.trim()}`,
        });
        return saved;
      },
      session,
    );
    return toLotDTO(persisted);
  }

  /**
   * Item operational lifecycle (Step 31 §3): retiring an item stops all
   * new stock activity; re-activation is explicit and audited.
   */
  async changeItemStatus(
    session: ApplicationSession | undefined,
    input: ItemStatusChangeInput,
  ): Promise<ItemDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    assertValidReason(input.reason, 'Item transition');
    const facilityId = session.facilityId;
    const item = await this.requireScopedItem(facilityId, input.itemId);
    if (item.active === input.active) {
      throw new ConflictError(`Item is already ${item.active ? 'active' : 'inactive'}`);
    }
    const persisted = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.INVENTORY_ITEM_STATUS,
      input.idempotencyKey,
      async () => {
        const saved = await this.deps.inventory.saveItemActive(
          input.itemId,
          input.active,
        );
        await this.audit.record(session, {
          action: 'TRANSITIONED',
          objectType: 'inventory-item',
          objectId: saved.id,
          at: new Date().toISOString(),
          source: INVENTORY_SOURCE,
          detail: `item ${saved.sku} ${input.active ? 'reactivated' : 'retired'}: ${input.reason.trim()}`,
        });
        return saved;
      },
      session,
    );
    return toItemDTO(persisted);
  }

  /**
   * FEFO stock selection (Step 31 §12): deterministic pick over the
   * facility's consumable lots of one item — earliest expiry first, with a
   * receivedAt-then-lotNumber tie-breaker. Selection is a READ: nothing is
   * consumed automatically; the caller issues against the returned lot
   * through `issueStock` (which re-applies every gate).
   */
  async selectLotForConsumption(
    session: ApplicationSession | undefined,
    itemId: InventoryItemId,
  ): Promise<(LotDTO & { balance: number; itemId: string; sku: string }) | undefined> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    const item = await this.requireScopedItem(facilityId, itemId);
    const now = new Date().toISOString();
    const candidates: { lot: LotDTO; balance: number; batch: StockBatch }[] = [];
    for (const batch of await this.deps.inventory.listBatchesByItem(item.id)) {
      if (!isConsumable(batch, now)) continue;
      const movements = await this.deps.inventory.listMovementsByBatch(batch.id);
      const balance = movements.reduce((sum, m) => sum + m.quantitySigned, 0);
      if (balance <= 0) continue;
      candidates.push({ lot: toLotDTO(batch), balance, batch });
    }
    if (candidates.length === 0) return undefined;
    candidates.sort(
      (a, b) =>
        new Date(a.batch.expiryDate).getTime() - new Date(b.batch.expiryDate).getTime() ||
        new Date(a.batch.receivedAt).getTime() - new Date(b.batch.receivedAt).getTime() ||
        a.batch.lotNumber.localeCompare(b.batch.lotNumber),
    );
    const chosen = candidates[0]!;
    return {
      ...chosen.lot,
      balance: chosen.balance,
      itemId: item.id,
      sku: item.sku,
    };
  }

  /**
   * Expiring-lots query (Step 31 §11/§27): lots of ACTIVE items in the
   * facility whose expiry falls within `horizonDays` (or already passed),
   * derived balance included. Bounded by the repository; ordering is
   * deterministic (expiry -> receivedAt -> lotNumber).
   */
  async listExpiringLots(
    session: ApplicationSession | undefined,
    horizonDays: number,
  ): Promise<ExpiringLotsDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_READ);
    await assertSessionFacility(session, this.deps.facilities);
    if (!Number.isFinite(horizonDays) || horizonDays < 1 || horizonDays > 365) {
      throw new ValidationError('horizonDays must be between 1 and 365');
    }
    const facilityId = session.facilityId;
    const generatedAt = new Date().toISOString();
    const batches = await this.deps.inventory.listLotsByFacilityAndExpiry(facilityId, {
      asOf: generatedAt,
      horizonDays,
    });
    const rows: ExpiringLotsDTO['lots'][number][] = [];
    for (const batch of batches) {
      const item = await this.deps.inventory.findItem(batch.itemId);
      if (!item) continue;
      const movements = await this.deps.inventory.listMovementsByBatch(batch.id);
      const balance = movements.reduce((sum, m) => sum + m.quantitySigned, 0);
      rows.push({
        ...toLotDTO(batch),
        itemId: item.id,
        sku: item.sku,
        balance,
      });
    }
    return { lots: rows, generatedAt };
  }

  /**
   * Lot usage traceability (Step 31 §14/§27): the full movement history of
   * one lot, including the laboratory-operation references. Historical
   * usage is never rewritten or deleted.
   */
  async getLotUsage(
    session: ApplicationSession | undefined,
    batchId: InventoryItemId,
  ): Promise<LotUsageDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    const batch = await this.requireScopedBatch(facilityId, batchId);
    const movements = await this.deps.inventory.listMovementsByBatch(batch.id);
    return { lot: toLotDTO(batch), movements: movements.map(toMovementDTO) };
  }

  /**
   * Operation-centric traceability (Step 31 §14): every inventory movement
   * recorded against one laboratory operation (order/QC record id).
   */
  async getOperationUsage(
    session: ApplicationSession | undefined,
    operationRef: string,
  ): Promise<{
    readonly operationRef: string;
    readonly movements: readonly MovementDTO[];
  }> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.INVENTORY_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const trimmed = operationRef.trim();
    if (trimmed.length === 0 || trimmed.length > 120) {
      throw new ValidationError('operationRef must be 1-120 characters');
    }
    const movements = await this.deps.inventory.listMovementsByOperation(trimmed);
    return {
      operationRef: trimmed,
      movements: movements.map(toMovementDTO),
    };
  }

  private async appendMovement(
    session: ApplicationSession,
    itemId: InventoryItemId,
    lotNumber: string | undefined,
    expiryDate: string | undefined,
    type: StockMovementType,
    quantity: number,
    existingBatchId?: InventoryItemId,
    reason: string = DEFAULT_RECEIPT_REASON,
    operationRef?: string,
  ): Promise<StockMovement> {
    let batchId = existingBatchId;
    if (!batchId) {
      // Receipt: reuse the matching lot or create it (first receipt path).
      // A reused lot must be lifecycle-valid: expired/quarantined/retired
      // lots cannot be topped up (Step 31 §11/§17) — new stock goes to a
      // fresh lot.
      const batches = await this.deps.inventory.listBatchesByItem(itemId);
      const existing = batches.find((batch) => batch.lotNumber === lotNumber!.trim());
      if (existing) {
        if (!isConsumable(existing, new Date().toISOString())) {
          throw new ValidationError(
            `Lot ${existing.lotNumber} is not consumable (${existing.status}, expiry ${existing.expiryDate})`,
          );
        }
        batchId = existing.id;
      } else {
        const created = await this.deps.inventory.saveBatch({
          id: randomUUID() as InventoryItemId,
          itemId,
          lotNumber: lotNumber!.trim(),
          expiryDate: expiryDate!,
          receivedAt: new Date().toISOString(),
          receivedQuantity: quantity,
          status: 'AVAILABLE',
        });
        batchId = created.id;
        await this.audit.record(session, {
          action: 'CREATED',
          objectType: 'inventory-lot',
          objectId: created.id,
          at: created.receivedAt,
          source: INVENTORY_SOURCE,
          detail: `lot ${created.lotNumber} registered for item ${itemId}`,
        });
      }
    }
    return this.applyMovement(session, batchId, type, quantity, reason, operationRef);
  }

  /**
   * Appends ONE movement to the ledger and audits it. Ledger-safety: a
   * depleting movement (OUT/WASTAGE) may never drive the derived balance
   * below zero — insufficient stock is a validation failure, and no partial
   * movement is ever recorded.
   */
  private async applyMovement(
    session: ApplicationSession,
    batchId: InventoryItemId,
    type: StockMovementType,
    quantity: number,
    reason: string,
    operationRef?: string,
  ): Promise<StockMovement> {
    const movement: StockMovement = {
      id: randomUUID() as InventoryItemId,
      batchId,
      movementType: type,
      quantitySigned: signedDelta(type, quantity),
      at: new Date().toISOString(),
      actorRef: session.actor.id,
      reason,
      ...(operationRef !== undefined ? { operationRef } : {}),
    };
    // Ledger-safety (Step 31 §19): the negative-stock guard is ATOMIC — the
    // store verifies coverage and appends in one concurrency-safe step, so
    // two racing consumers can never overdraw. IN/RETURN never deplete and
    // need no guard.
    const persisted =
      type === 'OUT' || type === 'WASTAGE'
        ? await this.deps.inventory.applyDepletingMovement(movement, quantity)
        : await this.deps.inventory.saveMovement(movement);
    await this.audit.record(session, {
      action: 'TRANSITIONED',
      objectType: 'inventory-movement',
      objectId: persisted.id,
      at: persisted.at,
      source: INVENTORY_SOURCE,
      detail: `${persisted.movementType} ${Math.abs(persisted.quantitySigned)} on lot ${batchId} (${persisted.reason})${
        persisted.operationRef ? ` for ${persisted.operationRef}` : ''
      }`,
    });
    return persisted;
  }

  private async requireScopedItem(
    facilityId: FacilityId,
    itemId: InventoryItemId,
  ): Promise<InventoryItem> {
    const item = await this.deps.inventory.findItem(itemId);
    if (!item || item.facilityId !== facilityId) {
      // Scope-unaware 404: no existence leak across facilities.
      throw new NotFoundError('Inventory item not found');
    }
    return item;
  }

  private async requireScopedBatch(
    facilityId: FacilityId,
    batchId: InventoryItemId,
  ): Promise<StockBatch> {
    const batch = await this.deps.inventory.findBatch(batchId);
    if (!batch) throw new NotFoundError('Inventory lot not found');
    // Scope derives from the OWNING ITEM's facility (server-side, never from
    // the request) — a cross-facility batch is indistinguishable from a
    // missing one.
    const item = await this.deps.inventory.findItem(batch.itemId);
    if (!item || item.facilityId !== facilityId) {
      throw new NotFoundError('Inventory lot not found');
    }
    return batch;
  }
}

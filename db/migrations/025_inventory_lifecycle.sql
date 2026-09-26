-- Migration 025: Inventory lifecycle completion (Step 31).
--
-- Extends the Step-14 append-only inventory foundation with the controlled
-- lot lifecycle (Step 31 §6), attributable movements (§8), and operation
-- traceability (§14). Stock state REMAINS derived from the movement ledger —
-- no balance column is added and no second ledger is created.
--
-- Boundary: operational infrastructure only. No procurement, accounting,
-- supplier management, purchasing, or clinical decision logic is implemented
-- or implied by this migration. Expiry remains recorded information enforced
-- at the application boundary.

SET search_path = sdis, public;

-- ============================================================
-- INVENTORY ITEMS: operational active/inactive lifecycle
-- ============================================================
ALTER TABLE sdis.inventory_items
    ADD COLUMN active BOOLEAN NOT NULL DEFAULT TRUE;

COMMENT ON COLUMN sdis.inventory_items.active IS
    'Step 31: retired items accept no new lots or stock movements (default true preserves Step-14 rows)';

-- ============================================================
-- STOCK LOTS: controlled lifecycle state
-- ============================================================
ALTER TABLE sdis.inventory_lots
    ADD COLUMN status TEXT NOT NULL DEFAULT 'AVAILABLE'
        CHECK (status IN ('AVAILABLE', 'QUARANTINED', 'RELEASED', 'RETIRED'));

CREATE INDEX idx_inventory_lots_status ON sdis.inventory_lots(status);
CREATE INDEX idx_inventory_lots_expiry ON sdis.inventory_lots(expiry_date);

COMMENT ON COLUMN sdis.inventory_lots.status IS
    'Step 31 lot lifecycle: AVAILABLE -> QUARANTINED -> RELEASED/RETIRED. EXPIRED is never stored - it is derived from expiry_date; RETIRED is terminal';

-- ============================================================
-- STOCK MOVEMENTS: attribution (reason) + operation traceability
-- ============================================================
ALTER TABLE sdis.stock_movements
    ADD COLUMN reason TEXT NOT NULL DEFAULT 'unattributed-legacy'
        CHECK (length(reason) BETWEEN 1 AND 120),
    ADD COLUMN operation_ref TEXT
        CHECK (operation_ref IS NULL OR length(operation_ref) BETWEEN 1 AND 120);

COMMENT ON COLUMN sdis.stock_movements.reason IS
    'Step 31 §8: required non-PHI attribution label for every movement (legacy rows carry an explicit unattributed marker - history is never rewritten)';
COMMENT ON COLUMN sdis.stock_movements.operation_ref IS
    'Step 31 §14: optional laboratory-operation reference (order/QC record id) establishing lot-level usage traceability where the workflow can establish it';

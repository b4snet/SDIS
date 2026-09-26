-- Migration 012: Laboratory Inventory Schema (Step 14)
-- Reagents, consumables, kits, controls, calibrators: items, lots, and an
-- APPEND-ONLY stock-movement ledger. Current balance is always DERIVED from
-- the recorded movements — there is no balance column to overwrite and no
-- second stock ledger.
--
-- Boundary: operational infrastructure only. No procurement, accounting,
-- supplier management, purchasing, or clinical decision logic is implemented
-- or implied by this schema. Expiry is recorded information, not a clinical
-- usability rule.

SET search_path = sdis, public;

-- ============================================================
-- INVENTORY ITEMS (facility-scoped catalog of managed materials)
-- ============================================================
CREATE TABLE sdis.inventory_items (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Scope: an item belongs to exactly one facility.
    facility_id  UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    sku          TEXT NOT NULL CHECK (length(sku) BETWEEN 2 AND 64),
    name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    category     TEXT NOT NULL CHECK (category IN
        ('REAGENT','CONSUMABLE','KIT','CONTROL','CALIBRATOR','OTHER')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Item identity is per facility (per-facility catalogs, not global).
    CONSTRAINT uq_inventory_items_facility_sku UNIQUE (facility_id, sku)
);

CREATE INDEX idx_inventory_items_facility ON sdis.inventory_items(facility_id);

COMMENT ON TABLE sdis.inventory_items IS
    'Facility-scoped laboratory inventory items (reagents, consumables, kits, controls, calibrators)';

-- ============================================================
-- STOCK LOTS / BATCHES (immutable once created)
-- ============================================================
CREATE TABLE sdis.inventory_lots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    item_id           UUID NOT NULL REFERENCES sdis.inventory_items(id) ON DELETE RESTRICT,
    lot_number        TEXT NOT NULL CHECK (length(lot_number) BETWEEN 1 AND 100),
    -- Expiry is recorded operational information, never a clinical rule.
    expiry_date       DATE NOT NULL,
    received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    received_quantity NUMERIC(14,4) NOT NULL CHECK (received_quantity > 0),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Lots are immutable: no UPDATE of identity/quantity is permitted by
    -- application behavior; the constraint documents that intent.
    CONSTRAINT uq_inventory_lots_item_lot UNIQUE (item_id, lot_number)
);

CREATE INDEX idx_inventory_lots_item ON sdis.inventory_lots(item_id);

COMMENT ON TABLE sdis.inventory_lots IS
    'Immutable stock lots/batches per inventory item (lot number unique per item)';

-- ============================================================
-- STOCK MOVEMENTS (append-only ledger — the single source of truth)
-- ============================================================
CREATE TABLE sdis.stock_movements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lot_id          UUID NOT NULL REFERENCES sdis.inventory_lots(id) ON DELETE RESTRICT,
    movement_type   TEXT NOT NULL CHECK (movement_type IN ('IN','OUT','WASTAGE','RETURN')),
    -- Signed delta: positive for IN/RETURN, negative for OUT/WASTAGE.
    quantity_signed NUMERIC(14,4) NOT NULL CHECK (quantity_signed <> 0),
    at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_ref       TEXT NOT NULL,
    -- Idempotent replay: a keyed retry can never append a second movement.
    idempotency_key TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_stock_movements_idempotency UNIQUE (idempotency_key),
    CONSTRAINT ck_stock_movements_sign CHECK (
        (movement_type IN ('IN','RETURN') AND quantity_signed > 0) OR
        (movement_type IN ('OUT','WASTAGE') AND quantity_signed < 0)
    )
);

CREATE INDEX idx_stock_movements_lot ON sdis.stock_movements(lot_id);

COMMENT ON TABLE sdis.stock_movements IS
    'Append-only stock movement ledger; balance is derived, never stored';

-- ============================================================
-- RLS Policies (mirror migration 006/009/011 conventions)
-- ============================================================
ALTER TABLE sdis.inventory_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_inventory_items_tenant ON sdis.inventory_items
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_inventory_items_facility ON sdis.inventory_items
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

GRANT SELECT, INSERT, UPDATE ON sdis.inventory_items TO sdis_app;

ALTER TABLE sdis.inventory_lots ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_inventory_lots_tenant ON sdis.inventory_lots
    FOR ALL TO sdis_app
    USING (item_id IN (
        SELECT i.id FROM sdis.inventory_items i
        JOIN sdis.facilities f ON f.id = i.facility_id
        WHERE f.organization_id = sdis.current_organization_id()))
    WITH CHECK (item_id IN (
        SELECT i.id FROM sdis.inventory_items i
        JOIN sdis.facilities f ON f.id = i.facility_id
        WHERE f.organization_id = sdis.current_organization_id()));

CREATE POLICY pol_inventory_lots_facility ON sdis.inventory_lots
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR item_id IN (
        SELECT i.id FROM sdis.inventory_items i WHERE i.facility_id = sdis.current_facility_id()))
    WITH CHECK (sdis.current_facility_id() IS NULL OR item_id IN (
        SELECT i.id FROM sdis.inventory_items i WHERE i.facility_id = sdis.current_facility_id()));

GRANT SELECT, INSERT, UPDATE ON sdis.inventory_lots TO sdis_app;

ALTER TABLE sdis.stock_movements ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_stock_movements_tenant ON sdis.stock_movements
    FOR ALL TO sdis_app
    USING (lot_id IN (
        SELECT l.id FROM sdis.inventory_lots l
        JOIN sdis.inventory_items i ON i.id = l.item_id
        JOIN sdis.facilities f ON f.id = i.facility_id
        WHERE f.organization_id = sdis.current_organization_id()))
    WITH CHECK (lot_id IN (
        SELECT l.id FROM sdis.inventory_lots l
        JOIN sdis.inventory_items i ON i.id = l.item_id
        JOIN sdis.facilities f ON f.id = i.facility_id
        WHERE f.organization_id = sdis.current_organization_id()));

CREATE POLICY pol_stock_movements_facility ON sdis.stock_movements
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR lot_id IN (
        SELECT l.id FROM sdis.inventory_lots l
        JOIN sdis.inventory_items i ON i.id = l.item_id
        WHERE i.facility_id = sdis.current_facility_id()))
    WITH CHECK (sdis.current_facility_id() IS NULL OR lot_id IN (
        SELECT l.id FROM sdis.inventory_lots l
        JOIN sdis.inventory_items i ON i.id = l.item_id
        WHERE i.facility_id = sdis.current_facility_id()));

GRANT SELECT, INSERT ON sdis.stock_movements TO sdis_app;

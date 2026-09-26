-- Migration 009: Billing Schema - Billable Services and Diagnostic Charges
-- Foundational diagnostic charge lifecycle: an existing diagnostic order item
-- is charged for an existing billable service at its recorded price. This is
-- infrastructure only — no tax rules, discounts, insurance, invoicing
-- workflows, payments, or accounting are implemented or implied.

SET search_path = sdis, public;

-- ============================================================
-- BILLABLE SERVICES (facility-scoped catalog entries)
-- ============================================================
CREATE TABLE sdis.billable_services (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    name            TEXT NOT NULL,
    modality        TEXT NOT NULL REFERENCES sdis.modalities(name),
    price_amount    NUMERIC(12, 2) NOT NULL CHECK (price_amount >= 0),
    price_currency  TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_billable_services_facility ON sdis.billable_services(facility_id);
CREATE INDEX idx_billable_services_modality ON sdis.billable_services(modality);

CREATE TRIGGER trg_billable_services_updated_at
    BEFORE UPDATE ON sdis.billable_services
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

COMMENT ON TABLE sdis.billable_services IS
    'Chargeable diagnostic services with recorded prices; no pricing policy engine';

-- ============================================================
-- CHARGES (order-item scoped, ledger-style)
-- ============================================================
CREATE TABLE sdis.charges (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id       UUID NOT NULL REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    service_id          UUID NOT NULL REFERENCES sdis.billable_services(id) ON DELETE RESTRICT,
    -- Scope denormalized from the owning order for RLS and indexed retrieval.
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    amount              NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
    currency            TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Domain contract (src/domain/billing/billing.ts): a retry can never
    -- create a second charge for the same key.
    idempotency_key     TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_charges_order_item ON sdis.charges(order_item_id);
CREATE INDEX idx_charges_facility ON sdis.charges(facility_id);

COMMENT ON TABLE sdis.charges IS
    'Diagnostic charges binding order items to billable services; ledger-style idempotent inserts';

-- ============================================================
-- RLS Policies (mirror migration 006 conventions)
-- ============================================================
ALTER TABLE sdis.billable_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.charges ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_billable_services_tenant ON sdis.billable_services
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_billable_services_facility ON sdis.billable_services
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

CREATE POLICY pol_charges_tenant ON sdis.charges
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_charges_facility ON sdis.charges
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.billable_services TO sdis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.charges TO sdis_app;

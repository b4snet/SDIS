-- Migration 003: Ordering Schema - Diagnostic Orders and Order Items
-- This migration creates the diagnostic order and order item tables

SET search_path = sdis, public;

-- ============================================================
-- MODALITY REFERENCE
-- ============================================================
CREATE TABLE sdis.modalities (
    name        TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    capabilities TEXT[] NOT NULL DEFAULT '{}'
);

-- Seed known modalities
INSERT INTO sdis.modalities (name, display_name, capabilities) VALUES
    ('LAB',      'Laboratory',      ARRAY['ORDERING','SPECIMEN','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('ECG',      'ECG',             ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('EEG',      'EEG',             ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('PFT',      'PFT',             ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('TMT',      'TMT',             ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('ECHO',     'Echocardiography',ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('ULTRASOUND','Ultrasound',     ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT']),
    ('RADIOLOGY','Radiology',       ARRAY['ORDERING','ACQUISITION','OBSERVATIONS','INTERPRETATION','REPORT'])
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- DIAGNOSTIC ORDERS
-- ============================================================
CREATE TABLE sdis.diagnostic_orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    encounter_id        UUID NOT NULL REFERENCES sdis.encounters(id) ON DELETE RESTRICT,
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    modality            TEXT NOT NULL REFERENCES sdis.modalities(name),
    status              TEXT NOT NULL CHECK (status IN ('ORDERED','ACQUIRED','PROCESSING','RESULT_ENTERED','VERIFIED','FINALIZED','REPORTED','CANCELLED')) DEFAULT 'ORDERED',
    ordered_at          TIMESTAMPTZ NOT NULL,
    ordered_by_ref      TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER NOT NULL DEFAULT 1  -- Optimistic concurrency
);

CREATE INDEX idx_diagnostic_orders_patient ON sdis.diagnostic_orders(patient_id);
CREATE INDEX idx_diagnostic_orders_encounter ON sdis.diagnostic_orders(encounter_id);
CREATE INDEX idx_diagnostic_orders_facility ON sdis.diagnostic_orders(facility_id);
CREATE INDEX idx_diagnostic_orders_status ON sdis.diagnostic_orders(status);
CREATE INDEX idx_diagnostic_orders_ordered_at ON sdis.diagnostic_orders(ordered_at);
CREATE INDEX idx_diagnostic_orders_modality ON sdis.diagnostic_orders(modality);

-- ============================================================
-- ORDER ITEMS
-- ============================================================
CREATE TABLE sdis.order_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES sdis.diagnostic_orders(id) ON DELETE CASCADE,
    test_code           TEXT NOT NULL,
    code_system         TEXT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_order_items_order ON sdis.order_items(order_id);
CREATE INDEX idx_order_items_test_code ON sdis.order_items(test_code, code_system);

-- ============================================================
-- Updated at trigger
-- ============================================================
CREATE TRIGGER trg_diagnostic_orders_updated_at
    BEFORE UPDATE ON sdis.diagnostic_orders
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE sdis.modalities IS 'Registered diagnostic modalities with their capabilities';
COMMENT ON TABLE sdis.diagnostic_orders IS 'Diagnostic order with lifecycle state machine';
COMMENT ON TABLE sdis.order_items IS 'Individual test/procedure line within an order';
COMMENT ON COLUMN sdis.diagnostic_orders.version IS 'Optimistic concurrency control';
COMMENT ON COLUMN sdis.diagnostic_orders.status IS 'Lifecycle: ORDERED -> ACQUIRED -> PROCESSING -> RESULT_ENTERED -> VERIFIED -> FINALIZED -> REPORTED, or CANCELLED';
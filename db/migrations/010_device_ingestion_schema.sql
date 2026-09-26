-- Migration 010: Device Ingestion Schema
-- Registered devices and their acquisitions. Devices enter the platform ONLY
-- through adapters; provenance preserves source device, adapter, acquisition
-- timestamp, and ingestion timestamp. This is an ingestion FOUNDATION — no
-- real vendor/analyzer/HL7/ASTM/DICOM integration is implemented or implied.

SET search_path = sdis, public;

-- ============================================================
-- DEVICES (registered per facility)
-- ============================================================
CREATE TABLE sdis.devices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    name            TEXT NOT NULL,
    model           TEXT,
    modality        TEXT NOT NULL REFERENCES sdis.modalities(name),
    kind            TEXT NOT NULL CHECK (kind IN
        ('ANALYZER','ECG','EEG','PFT','TMT','ECHO','ULTRASOUND','OTHER')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_devices_facility ON sdis.devices(facility_id);
CREATE INDEX idx_devices_modality ON sdis.devices(modality);

CREATE TRIGGER trg_devices_updated_at
    BEFORE UPDATE ON sdis.devices
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

COMMENT ON TABLE sdis.devices IS
    'Registered acquisition devices; adapters normalize their payloads';

-- ============================================================
-- DEVICE ACQUISITIONS (ingestion boundary — raw, never interpreted)
-- ============================================================
CREATE TABLE sdis.device_acquisitions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id       UUID NOT NULL REFERENCES sdis.devices(id) ON DELETE RESTRICT,
    order_item_id   UUID REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    patient_id      UUID REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    -- Scope denormalized from the device (authoritative registration scope)
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    adapter_id      TEXT NOT NULL,
    acquired_at     TIMESTAMPTZ NOT NULL,
    ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Opaque vendor payload, preserved verbatim (JSONB)
    raw_payload     JSONB NOT NULL,
    -- The idempotent ingestion key supplied by the adapter/gateway
    ingestion_key   TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_device_acquisitions_device ON sdis.device_acquisitions(device_id);
CREATE INDEX idx_device_acquisitions_order_item ON sdis.device_acquisitions(order_item_id);
CREATE INDEX idx_device_acquisitions_facility ON sdis.device_acquisitions(facility_id);

COMMENT ON TABLE sdis.device_acquisitions IS
    'Raw device acquisitions at the ingestion boundary; observations are created only through the observation service';

-- ============================================================
-- RLS Policies (mirror migration 006 conventions)
-- ============================================================
ALTER TABLE sdis.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.device_acquisitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_devices_tenant ON sdis.devices
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_devices_facility ON sdis.devices
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

CREATE POLICY pol_device_acquisitions_tenant ON sdis.device_acquisitions
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_device_acquisitions_facility ON sdis.device_acquisitions
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.devices TO sdis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.device_acquisitions TO sdis_app;

-- Migration 004: Specimen and Results Schema - Specimens, Observations, Interpretations, Reports
-- This migration creates the specimen lifecycle and results tables

SET search_path = sdis, public;

-- ============================================================
-- SPECIMENS
-- ============================================================
CREATE TABLE sdis.specimens (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id       UUID NOT NULL REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    kind                TEXT NOT NULL CHECK (kind IN ('BLOOD','SERUM','PLASMA','URINE','STOOL','CSF','SWAB','TISSUE','OTHER','ACQUISITION')),
    status              TEXT NOT NULL CHECK (status IN ('COLLECTED','RECEIVED','ACCEPTED','REJECTED','PROCESSED')) DEFAULT 'COLLECTED',
    collected_at        TIMESTAMPTZ NOT NULL,
    collected_by_ref    TEXT NOT NULL,
    received_at         TIMESTAMPTZ,
    accepted_at         TIMESTAMPTZ,
    rejected_at         TIMESTAMPTZ,
    processed_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX idx_specimens_order_item ON sdis.specimens(order_item_id);
CREATE INDEX idx_specimens_patient ON sdis.specimens(patient_id);
CREATE INDEX idx_specimens_status ON sdis.specimens(status);

-- Specimen status transition events (for audit/history)
CREATE TABLE sdis.specimen_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    specimen_id         UUID NOT NULL REFERENCES sdis.specimens(id) ON DELETE CASCADE,
    from_status         TEXT CHECK (from_status IN ('COLLECTED','RECEIVED','ACCEPTED','REJECTED','PROCESSED')),
    to_status           TEXT NOT NULL CHECK (to_status IN ('COLLECTED','RECEIVED','ACCEPTED','REJECTED','PROCESSED')),
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_ref           TEXT NOT NULL,
    detail              TEXT
);

CREATE INDEX idx_specimen_events_specimen ON sdis.specimen_events(specimen_id);

-- ============================================================
-- OBSERVATIONS
-- ============================================================
CREATE TABLE sdis.observations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id       UUID NOT NULL REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    specimen_id         UUID REFERENCES sdis.specimens(id) ON DELETE SET NULL,
    code                TEXT NOT NULL,
    code_system         TEXT NOT NULL,
    value_kind          TEXT NOT NULL CHECK (value_kind IN ('QUANTITATIVE','QUALITATIVE','CODED','TEXT')),
    value_numeric       NUMERIC,
    value_text          TEXT,
    value_code          TEXT,
    value_code_system   TEXT,
    unit                TEXT,  -- UCUM code for quantitative
    issued_by_kind      TEXT NOT NULL CHECK (issued_by_kind IN ('HUMAN','DEVICE','ALGORITHM','INTEGRATION','SYSTEM')),
    issued_by_label     TEXT NOT NULL,
    issued_by_ref       TEXT,
    at                  TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_observations_order_item ON sdis.observations(order_item_id);
CREATE INDEX idx_observations_patient ON sdis.observations(patient_id);
CREATE INDEX idx_observations_specimen ON sdis.observations(specimen_id);
CREATE INDEX idx_observations_code ON sdis.observations(code, code_system);

-- ============================================================
-- INTERPRETATIONS
-- ============================================================
CREATE TABLE sdis.interpretations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_item_id       UUID NOT NULL REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    source_kind         TEXT NOT NULL CHECK (source_kind IN ('HUMAN','DEVICE','ALGORITHM','INTEGRATION','SYSTEM')),
    source_label        TEXT NOT NULL,
    source_ref          TEXT,
    text                TEXT NOT NULL,
    at                  TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_interpretations_order_item ON sdis.interpretations(order_item_id);
CREATE INDEX idx_interpretations_source_kind ON sdis.interpretations(source_kind);

-- ============================================================
-- REPORTS
-- ============================================================
CREATE TABLE sdis.reports (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID NOT NULL REFERENCES sdis.diagnostic_orders(id) ON DELETE RESTRICT,
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    current_version     INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_reports_order ON sdis.reports(order_id);
CREATE INDEX idx_reports_patient ON sdis.reports(patient_id);
CREATE INDEX idx_reports_facility ON sdis.reports(facility_id);

-- Report versions (immutable, append-only chain)
CREATE TABLE sdis.report_versions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    report_id           UUID NOT NULL REFERENCES sdis.reports(id) ON DELETE CASCADE,
    version             INTEGER NOT NULL,
    status              TEXT NOT NULL CHECK (status IN ('DRAFT','FINALIZED')) DEFAULT 'DRAFT',
    content             TEXT NOT NULL,
    authored_by_ref     TEXT NOT NULL,
    authored_at         TIMESTAMPTZ NOT NULL,
    finalized_at        TIMESTAMPTZ,
    supersedes_version_id UUID REFERENCES sdis.report_versions(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, version)
);

CREATE INDEX idx_report_versions_report ON sdis.report_versions(report_id);
CREATE INDEX idx_report_versions_supersedes ON sdis.report_versions(supersedes_version_id);

-- ============================================================
-- Updated at triggers
-- ============================================================
CREATE TRIGGER trg_specimens_updated_at
    BEFORE UPDATE ON sdis.specimens
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

CREATE TRIGGER trg_reports_updated_at
    BEFORE UPDATE ON sdis.reports
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE sdis.specimens IS 'Specimen/acquisition lifecycle - patient identity locked to order item';
COMMENT ON TABLE sdis.specimen_events IS 'Specimen status transition history';
COMMENT ON TABLE sdis.observations IS 'Measured/observed data points - source preserved (device/human/integration)';
COMMENT ON TABLE sdis.interpretations IS 'Human/device/algorithm reading of observations - source kind never collapsed';
COMMENT ON TABLE sdis.reports IS 'Diagnostic report header with version tracking';
COMMENT ON TABLE sdis.report_versions IS 'Immutable report versions - amendments create new versions, never overwrite';
COMMENT ON COLUMN sdis.specimens.status IS 'COLLECTED -> RECEIVED -> ACCEPTED -> PROCESSED (or REJECTED from RECEIVED)';
COMMENT ON COLUMN sdis.report_versions.status IS 'DRAFT or FINALIZED - finalized reports are immutable';
COMMENT ON COLUMN sdis.report_versions.supersedes_version_id IS 'Amendment chain - references the version this replaces';
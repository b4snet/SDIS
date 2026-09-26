-- Migration 008: Terminology Persistence Schema
-- Canonical internal codes mapped to external terminologies (LOINC, SNOMED CT,
-- UCUM, ICD, local codes). Terminology storage is infrastructure only — no
-- licensed terminology data is bundled and no standards conformance is claimed.

SET search_path = sdis, public;

-- ============================================================
-- TERMINOLOGY MAPPINGS
-- ============================================================
CREATE TABLE sdis.terminology_mappings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Internal canonical code (system is always the SDIS internal system,
    -- enforced by the application domain and mirrored as a schema constraint)
    canonical_system TEXT NOT NULL DEFAULT 'sdis' CHECK (canonical_system = 'sdis'),
    canonical_code  TEXT NOT NULL,
    external_system TEXT NOT NULL CHECK (external_system IN
        ('loinc', 'snomed', 'ucum', 'icd10', 'atc', 'local')),
    external_code   TEXT NOT NULL,
    -- NULL = global mapping; non-NULL = facility-specific override
    facility_id     UUID REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    -- Provenance of the mapping decision (preserved, never discarded)
    validated       BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The domain resolution rule (facility override wins over global) is 1:1
    -- with this uniqueness shape; the schema makes the conflict explicit.
    CONSTRAINT uq_terminology_mapping UNIQUE (canonical_code, external_system, external_code, facility_id)
);

CREATE INDEX idx_terminology_canonical ON sdis.terminology_mappings(canonical_code, external_system);
CREATE INDEX idx_terminology_facility ON sdis.terminology_mappings(facility_id);

CREATE TRIGGER trg_terminology_updated_at
    BEFORE UPDATE ON sdis.terminology_mappings
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

COMMENT ON TABLE sdis.terminology_mappings IS
    'Internal canonical code to external terminology mappings; facility overrides';

-- ============================================================
-- RLS Policies (mirror migration 006 conventions)
-- ============================================================
ALTER TABLE sdis.terminology_mappings ENABLE ROW LEVEL SECURITY;

-- Tenant isolation: a mapping is visible when its scope facility belongs to
-- the caller organization. Global mappings (facility_id IS NULL) are visible
-- across organizations of the same deployment — matching the domain model,
-- where global mappings are deployment-wide defaults.
CREATE POLICY pol_terminology_tenant ON sdis.terminology_mappings
    FOR ALL TO sdis_app
    USING (
        facility_id IS NULL
        OR facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    )
    WITH CHECK (
        facility_id IS NULL
        OR facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    );

-- Facility isolation: when a facility GUC is set, only that facility's own
-- overrides and the global defaults are visible — other facilities' overrides
-- are never readable.
CREATE POLICY pol_terminology_facility ON sdis.terminology_mappings
    FOR ALL TO sdis_app
    USING (
        sdis.current_facility_id() IS NULL
        OR facility_id IS NULL
        OR facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_facility_id() IS NULL
        OR facility_id IS NULL
        OR facility_id = sdis.current_facility_id()
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.terminology_mappings TO sdis_app;

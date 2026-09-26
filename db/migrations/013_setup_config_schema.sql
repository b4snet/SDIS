-- Migration 013: Master Setup / Configuration Schema (Step 15)
-- Controlled configuration for SDIS. The domain rule is preserved literally:
-- every configuration record is SCOPED and VERSIONED. An update appends a new
-- version row — nothing is overwritten and nothing is deleted, so history
-- always shows which configuration was in effect at a given time.
--
-- Scope: FACILITY settings belong to exactly one facility; DEPARTMENT settings
-- belong to a department INSIDE that facility. A facility configuration never
-- becomes organization-global configuration.
--
-- Boundary: configuration infrastructure only. No clinical semantics
-- (reference ranges, thresholds, critical-value policies, interpretation
-- rules), no user/role/permission administration, no procurement/accounting.
-- The `family` allowlist is intentionally narrow; families whose authoritative
-- source of truth already exists elsewhere are NOT duplicated here.

SET search_path = sdis, public;

-- ============================================================
-- SETUP CONFIGURATION (append-only versions)
-- ============================================================
CREATE TABLE sdis.setup_config (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Scope: the owning facility (tenant is derived through the facility).
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    -- Department scope is REQUIRED for the DEPARTMENT family and forbidden for
    -- FACILITY (enforced by the check constraint below); the composite scope is
    -- always validated against the owning facility by the application.
    department_id   UUID REFERENCES sdis.departments(id) ON DELETE RESTRICT,
    family          TEXT NOT NULL CHECK (family IN ('FACILITY','DEPARTMENT')),
    key             TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 128),
    -- Opaque operational value; never clinical interpretation, never secrets
    -- (the application refuses secret-bearing keys before insert).
    value           JSONB NOT NULL,
    version         INTEGER NOT NULL CHECK (version >= 1),
    source_version  TEXT CHECK (source_version IS NULL OR length(source_version) BETWEEN 1 AND 64),
    effective_from  TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_setup_config_department_scope CHECK (
        (family = 'FACILITY' AND department_id IS NULL) OR
        (family = 'DEPARTMENT' AND department_id IS NOT NULL)
    )
);

-- One version row per scope/family/key; a retry or concurrent writer conflicts
-- instead of silently duplicating history. COALESCE keeps the facility-scoped
-- rows (NULL department) inside the same uniqueness rule.
CREATE UNIQUE INDEX uq_setup_config_scope_version ON sdis.setup_config (
    facility_id,
    family,
    COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::uuid),
    key,
    version
);

-- Latest-version lookup path (the read the application always performs).
CREATE INDEX idx_setup_config_scope_key ON sdis.setup_config (facility_id, family, key, version DESC);

COMMENT ON TABLE sdis.setup_config IS
    'Scoped, versioned master-setup configuration; updates append versions, nothing is overwritten';

-- ============================================================
-- RLS Policies (mirror migration 006/009/011 conventions)
-- ============================================================
ALTER TABLE sdis.setup_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_setup_config_tenant ON sdis.setup_config
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_setup_config_facility ON sdis.setup_config
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- Append-only at the privilege level: no UPDATE and no DELETE are granted.
GRANT SELECT, INSERT ON sdis.setup_config TO sdis_app;

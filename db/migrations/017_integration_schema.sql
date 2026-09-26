-- Migration 017: External integration system identity + order external references (Step 20)
--
-- Two authoritative records for the interoperability foundation:
--
-- 1. `sdis.external_systems` — the formal identity of an EXTERNAL SYSTEM
--    (SWASTHYA HMS today as a reserved row, future hospital/lab systems).
--    An external system is NOT a human principal and NOT an SDIS patient:
--    it is a registered integration counterpart. Status is an operational
--    switch ('ACTIVE' | 'DISABLED'); the gateway fails closed for unknown or
--    disabled systems. `config_ref` is a NON-SECRET configuration reference
--    (e.g. a setup-config id or environment key NAME). Credentials are
--    intentionally out of scope — secret management is a documented future
--    dependency and no secret value may ever be stored here.
--
-- 2. `sdis.order_external_references` — preserves the caller's own order
--    identifier (e.g. an HMS order id) alongside the canonical SDIS
--    diagnostic order. Uniqueness is per (external system, external order
--    reference) — the SAME external value under a DIFFERENT system is a
--    different reference and does not collide. Canonical SDIS order ids are
--    never overwritten by external identifiers; this table only adds the
--    correlation map external -> canonical.
--
-- Conventions mirror migrations 006/009/011/013: RLS on tenant/facility,
-- sdis_app-only grants, and append-only behavior where updates are not part
-- of the contract. Both tables are tenant-scoped through facility_id.

-- ============================================================
-- External system registry
-- ============================================================
CREATE TABLE sdis.external_systems (
    id              UUID PRIMARY KEY,
    system_key      VARCHAR(64) NOT NULL UNIQUE,
    name            VARCHAR(160) NOT NULL,
    system_type     VARCHAR(40) NOT NULL,
    organization_id UUID NOT NULL REFERENCES sdis.organizations(id),
    facility_id     UUID REFERENCES sdis.facilities(id),
    status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    config_ref      VARCHAR(160),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT external_systems_status_check
        CHECK (status IN ('ACTIVE', 'DISABLED')),
    CONSTRAINT external_systems_type_check
        CHECK (system_type IN ('HMS', 'LABORATORY', 'STANDARDS', 'TEST', 'OTHER'))
);

COMMENT ON TABLE sdis.external_systems IS
    'Registered external integration systems (never human principals, never SDIS patients). config_ref is a non-secret reference only.';

CREATE INDEX idx_external_systems_org ON sdis.external_systems (organization_id);

-- ============================================================
-- Order external references (external order id -> canonical order id)
-- ============================================================
CREATE TABLE sdis.order_external_references (
    id              UUID PRIMARY KEY,
    system_key      VARCHAR(64) NOT NULL,
    external_ref    VARCHAR(160) NOT NULL,
    order_id        UUID NOT NULL REFERENCES sdis.diagnostic_orders(id),
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id),
    correlation_id  VARCHAR(128),
    recorded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT order_external_references_unique
        UNIQUE (system_key, external_ref)
);

COMMENT ON TABLE sdis.order_external_references IS
    'Correlation map from an external system''s own order identifier to the canonical SDIS diagnostic order. Uniqueness is per external system; canonical ids are never replaced.';

CREATE INDEX idx_order_external_references_order
    ON sdis.order_external_references (order_id);
CREATE INDEX idx_order_external_references_facility
    ON sdis.order_external_references (facility_id);

-- ============================================================
-- RLS Policies (mirror migration 013 conventions)
-- ============================================================
ALTER TABLE sdis.external_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.order_external_references ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_external_systems_tenant ON sdis.external_systems
    FOR ALL TO sdis_app
    USING (organization_id = sdis.current_organization_id()
           OR facility_id IN (SELECT id FROM sdis.facilities
                              WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (organization_id = sdis.current_organization_id()
           OR facility_id IN (SELECT id FROM sdis.facilities
                              WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_external_systems_facility ON sdis.external_systems
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id IS NULL
           OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id IS NULL
           OR facility_id = sdis.current_facility_id());

CREATE POLICY pol_order_external_references_tenant ON sdis.order_external_references
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities
                           WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities
                           WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_order_external_references_facility ON sdis.order_external_references
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- Registry rows are administrative data: managed through the application
-- service (insert by sdis_app), corrections via explicit UPDATE of status
-- only. Order references are append-only: no UPDATE, no DELETE.
GRANT SELECT, INSERT, UPDATE ON sdis.external_systems TO sdis_app;
GRANT SELECT, INSERT ON sdis.order_external_references TO sdis_app;

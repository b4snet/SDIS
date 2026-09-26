-- Migration 027: close the migration-017 fail-open RLS branches (SEC-01).
--
-- Migration 017's facility policies admit a row when the facility GUC is
-- unset (`sdis.current_facility_id() IS NULL OR ...`). PostgreSQL combines
-- permissive policies with OR, so an `sdis_app` session WITHOUT tenant
-- context satisfies the facility policy and sees every row — the exact
-- fail-open posture migration 014 removed for the older tables (RLS-01).
--
-- This migration (forward-only, no data change):
--   * replaces both facility policies with strict equality (keeping the
--     documented global-row allowance `facility_id IS NULL` for
--     `external_systems`, whose facility is nullable by design);
--   * adds one RESTRICTIVE fail-closed policy per table (014 pattern):
--     without BOTH tenant GUCs every row is invisible and every write denied;
--   * applies FORCE ROW LEVEL SECURITY (owner/superuser bypass is unchanged
--     for the pool role; the application role is fully constrained).
--
-- Intended visibility with both GUCs set is UNCHANGED: organization-scoped
-- rows (global NULL-facility registry rows included). The only rows that lose
-- visibility are cross-organization-inconsistent rows (facility of another
-- org), which the application never writes (session org + facility always
-- agree), and unscoped sessions, which must see nothing.

SET search_path = sdis, public;

ALTER TABLE sdis.external_systems FORCE ROW LEVEL SECURITY;
ALTER TABLE sdis.order_external_references FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pol_external_systems_facility ON sdis.external_systems;
CREATE POLICY pol_external_systems_facility ON sdis.external_systems
    FOR ALL TO sdis_app
    USING (facility_id IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id IS NULL OR facility_id = sdis.current_facility_id());

DROP POLICY IF EXISTS pol_order_external_references_facility
    ON sdis.order_external_references;
CREATE POLICY pol_order_external_references_facility
    ON sdis.order_external_references
    FOR ALL TO sdis_app
    USING (facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id = sdis.current_facility_id());

CREATE POLICY pol_external_systems_fail_closed ON sdis.external_systems
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND organization_id = sdis.current_organization_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND organization_id = sdis.current_organization_id()
    );

CREATE POLICY pol_order_external_references_fail_closed
    ON sdis.order_external_references
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    );

COMMENT ON POLICY pol_external_systems_fail_closed ON sdis.external_systems IS
    'SEC-01: fail-closed facility/org boundary — requires both tenant GUCs; unset context denies all rows';
COMMENT ON POLICY pol_order_external_references_fail_closed
    ON sdis.order_external_references IS
    'SEC-01: fail-closed facility/org boundary — requires both tenant GUCs; unset context denies all rows';

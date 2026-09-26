-- Migration 028: row-level security for patient principal bindings (SEC-02).
--
-- `sdis.patient_principal_bindings` maps an authenticated patient principal
-- (credential userId) to the ONE canonical patient identity it may access.
-- It shipped in migration 019 with grants but WITHOUT row-level security, so
-- the application role could read every principal-to-patient mapping
-- organization-wide. Current code only point-looks-up the caller's own
-- userId, but authorization plumbing must not rely on caller discipline.
--
-- This migration (forward-only, no data change):
--   * enables and forces RLS on the bindings table;
--   * adds a facility isolation policy derived through the bound patient:
--     a binding is visible/writable only when its patient is registered at
--     the current facility. No `IS NULL OR` branch exists, so an unset
--     facility GUC matches nothing (fail-closed);
--   * leaves grants untouched (SELECT/INSERT/UPDATE; no DELETE, no new grant).
--
-- Compatibility: registry reads/writes in application flows always run under
-- the session tenant scope; unscoped pool-role tooling (migrations, seeds,
-- superuser-owned test harnesses) bypasses RLS as before.

SET search_path = sdis, public;

ALTER TABLE sdis.patient_principal_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.patient_principal_bindings FORCE ROW LEVEL SECURITY;

CREATE POLICY pol_patient_bindings_facility_isolation
    ON sdis.patient_principal_bindings
    FOR ALL TO sdis_app
    USING (patient_id IN (
        SELECT p.id FROM sdis.patients p
        WHERE p.registered_at_facility_id = sdis.current_facility_id()
    ))
    WITH CHECK (patient_id IN (
        SELECT p.id FROM sdis.patients p
        WHERE p.registered_at_facility_id = sdis.current_facility_id()
    ));

-- Fail-closed restrictive (014/027 pattern): without both tenant GUCs every
-- row is invisible and every write is denied, whatever permissive policies
-- future migrations add.
CREATE POLICY pol_patient_bindings_fail_closed
    ON sdis.patient_principal_bindings
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND patient_id IN (
            SELECT p.id FROM sdis.patients p
            WHERE p.registered_at_facility_id = sdis.current_facility_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND patient_id IN (
            SELECT p.id FROM sdis.patients p
            WHERE p.registered_at_facility_id = sdis.current_facility_id()
        )
    );

COMMENT ON TABLE sdis.patient_principal_bindings IS
    'Patient principal to canonical patient ownership bindings (Step 22). RLS facility-scoped through the bound patient (SEC-02).';

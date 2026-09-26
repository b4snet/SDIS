-- Migration 029: scope idempotency keys by facility + remove DELETE (SEC-03).
--
-- `sdis.idempotency_keys` carried no tenant/facility scoping at the database
-- layer (isolation came only from facility-composed key strings) and granted
-- DELETE to the application role (any `sdis_app` session could erase keys and
-- force duplicate execution; the expiry-cleanup SQL function has no caller —
-- expiry is enforced by `expires_at` predicates — so the grant buys nothing).
--
-- This migration (forward-only, existing rows untouched):
--   * adds a nullable `facility_id` (legacy rows stay NULL and stay readable;
--     the 24-hour TTL bounds the legacy window — all steady-state rows are
--     written with a facility by the application store);
--   * enables and forces RLS with a facility policy: rows tagged with a
--     facility are visible only to that facility; untagged legacy rows keep
--     the historical visibility until they expire;
--   * revokes the DELETE grant from `sdis_app` (SELECT/INSERT/UPDATE remain).
--
-- Compatibility: the application idempotency store writes `facility_id`
-- parsed from the facility-composed key (`scope:facility:key`); unscoped
-- pool-role tooling bypasses RLS as before.

SET search_path = sdis, public;

ALTER TABLE sdis.idempotency_keys
    ADD COLUMN IF NOT EXISTS facility_id UUID REFERENCES sdis.facilities(id);

CREATE INDEX IF NOT EXISTS idx_idempotency_facility
    ON sdis.idempotency_keys (facility_id);

ALTER TABLE sdis.idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.idempotency_keys FORCE ROW LEVEL SECURITY;

CREATE POLICY pol_idempotency_keys_facility_isolation ON sdis.idempotency_keys
    FOR ALL TO sdis_app
    USING (facility_id IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id IS NULL OR facility_id = sdis.current_facility_id());

-- Fail-closed restrictive: key reads/writes require the facility GUC, so an
-- unscoped application session sees nothing even among untagged legacy rows.
CREATE POLICY pol_idempotency_keys_fail_closed ON sdis.idempotency_keys
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NOT NULL)
    WITH CHECK (sdis.current_facility_id() IS NOT NULL);

REVOKE DELETE ON sdis.idempotency_keys FROM sdis_app;

COMMENT ON TABLE sdis.idempotency_keys IS
    'Durable idempotency keys for retry-safe operations. Facility-tagged rows are RLS-isolated (SEC-03); untagged legacy rows expire within the 24-hour TTL.';

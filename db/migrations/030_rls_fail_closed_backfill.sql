-- Migration 030: fail-closed restrictive backfill for post-014 tables (TEST-01).
--
-- `quality_records` (023) and the notification tables (026) ride permissive
-- org/facility policies that already require the tenant GUCs for any row to
-- be visible — but, unlike the migration-014 set, they carry no RESTRICTIVE
-- policy, so the "restrictive fail-closed on every tenant table" gate cannot
-- cover them and a future permissive-policy mistake would fail open.
--
-- This migration (forward-only, no data change, no visibility change with
-- tenant context set) adds GUC-presence RESTRICTIVE policies: without BOTH
-- tenant GUCs every row is invisible and every write is denied. With context
-- set the policies narrow nothing — facility narrowing on these tables stays
-- a service-layer contract (documented posture).

SET search_path = sdis, public;

CREATE POLICY pol_quality_records_fail_closed ON sdis.quality_records
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    );

CREATE POLICY pol_notification_events_fail_closed ON sdis.notification_events
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    );

CREATE POLICY pol_notification_intents_fail_closed ON sdis.notification_intents
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    );

CREATE POLICY pol_notification_attempts_fail_closed
    ON sdis.notification_delivery_attempts
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
    );

COMMENT ON POLICY pol_quality_records_fail_closed ON sdis.quality_records IS
    'TEST-01: fail-closed backfill — requires both tenant GUCs; unset context denies all rows';
COMMENT ON POLICY pol_notification_events_fail_closed ON sdis.notification_events IS
    'TEST-01: fail-closed backfill — requires both tenant GUCs; unset context denies all rows';

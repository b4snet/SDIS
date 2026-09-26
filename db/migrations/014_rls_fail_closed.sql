-- Migration 014: RLS fail-closed enforcement (RLS-01 fix)
--
-- Closes the fail-open posture introduced by the permissive `*_facility`
-- policies in migrations 006/008/009/010/011/012/013. Those policies admit a
-- row when the facility GUC is unset (`current_facility_id() IS NULL OR ...`),
-- so an `sdis_app` session WITHOUT tenant context sees every row of its
-- organization — and, for terminology, every row of every organization.
--
-- PostgreSQL combines policies as: a row is visible when it satisfies AT
-- LEAST ONE permissive policy AND EVERY restrictive policy. This migration
-- adds one RESTRICTIVE policy per tenant table requiring BOTH GUCs to be set
-- and the row to belong to the current facility. With no GUCs (or partial
-- GUCs), every tenant row is invisible and every insert is denied — the
-- database now fails CLOSED for the application role.
--
-- The application request lifecycle wires both GUCs per request (see
-- `Database.withTenantContext` + `tenant-scope.ts`); migrations, seeds, and
-- ops tooling that use the sdis_app role must set the GUCs explicitly.
--
-- Boundary: this is an isolation posture fix only — no schema, grants,
-- domain, or clinical behavior changes.

SET search_path = sdis, public;

-- ------------------------------------------------------------
-- DIRECT facility-scoped tables (facility_id column present)
-- ------------------------------------------------------------
CREATE POLICY pol_patients_fail_closed ON sdis.patients
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND registered_at_facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND registered_at_facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_encounters_fail_closed ON sdis.encounters
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_orders_fail_closed ON sdis.diagnostic_orders
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_reports_fail_closed ON sdis.reports
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_audit_fail_closed ON sdis.audit_events
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_billable_services_fail_closed ON sdis.billable_services
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_charges_fail_closed ON sdis.charges
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_devices_fail_closed ON sdis.devices
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_device_acquisitions_fail_closed ON sdis.device_acquisitions
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_documents_fail_closed ON sdis.documents
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_inventory_items_fail_closed ON sdis.inventory_items
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

CREATE POLICY pol_setup_config_fail_closed ON sdis.setup_config
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND facility_id = sdis.current_facility_id()
    );

-- ------------------------------------------------------------
-- INDIRECT facility-scoped tables (facility derived by reference)
-- ------------------------------------------------------------
CREATE POLICY pol_specimens_fail_closed ON sdis.specimens
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id = sdis.current_facility_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id = sdis.current_facility_id()
        )
    );

CREATE POLICY pol_observations_fail_closed ON sdis.observations
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id = sdis.current_facility_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id = sdis.current_facility_id()
        )
    );

CREATE POLICY pol_inventory_lots_fail_closed ON sdis.inventory_lots
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND item_id IN (
            SELECT i.id FROM sdis.inventory_items i
            WHERE i.facility_id = sdis.current_facility_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND item_id IN (
            SELECT i.id FROM sdis.inventory_items i
            WHERE i.facility_id = sdis.current_facility_id()
        )
    );

CREATE POLICY pol_stock_movements_fail_closed ON sdis.stock_movements
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND lot_id IN (
            SELECT l.id FROM sdis.inventory_lots l
            JOIN sdis.inventory_items i ON i.id = l.item_id
            WHERE i.facility_id = sdis.current_facility_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND lot_id IN (
            SELECT l.id FROM sdis.inventory_lots l
            JOIN sdis.inventory_items i ON i.id = l.item_id
            WHERE i.facility_id = sdis.current_facility_id()
        )
    );

-- ------------------------------------------------------------
-- NULLABLE-facility table (global rows remain deployment-wide defaults)
-- ------------------------------------------------------------
CREATE POLICY pol_terminology_fail_closed ON sdis.terminology_mappings
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND (facility_id IS NULL OR facility_id = sdis.current_facility_id())
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND sdis.current_facility_id() IS NOT NULL
        AND (facility_id IS NULL OR facility_id = sdis.current_facility_id())
    );

-- ------------------------------------------------------------
-- ORG-scoped tables: require the organization GUC to be present so a
-- partial-context session (no org) sees nothing, uniformly with the
-- facility-scoped tables above.
-- ------------------------------------------------------------
CREATE POLICY pol_organizations_fail_closed ON sdis.organizations
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (sdis.current_organization_id() IS NOT NULL AND id = sdis.current_organization_id())
    WITH CHECK (sdis.current_organization_id() IS NOT NULL AND id = sdis.current_organization_id());

CREATE POLICY pol_facilities_fail_closed ON sdis.facilities
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND organization_id = sdis.current_organization_id()
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND organization_id = sdis.current_organization_id()
    );

CREATE POLICY pol_departments_fail_closed ON sdis.departments
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND facility_id IN (
            SELECT id FROM sdis.facilities
            WHERE organization_id = sdis.current_organization_id()
        )
    );

CREATE POLICY pol_order_items_fail_closed ON sdis.order_items
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND order_id IN (
            SELECT id FROM sdis.diagnostic_orders
            WHERE facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND order_id IN (
            SELECT id FROM sdis.diagnostic_orders
            WHERE facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    );

CREATE POLICY pol_specimen_events_fail_closed ON sdis.specimen_events
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND specimen_id IN (
            SELECT s.id FROM sdis.specimens s
            JOIN sdis.patients p ON p.id = s.patient_id
            WHERE p.registered_at_facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND specimen_id IN (
            SELECT s.id FROM sdis.specimens s
            JOIN sdis.patients p ON p.id = s.patient_id
            WHERE p.registered_at_facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    );

CREATE POLICY pol_interpretations_fail_closed ON sdis.interpretations
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND order_item_id IN (
            SELECT oi.id FROM sdis.order_items oi
            JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
            WHERE o.facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    );

CREATE POLICY pol_report_versions_fail_closed ON sdis.report_versions
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND report_id IN (
            SELECT id FROM sdis.reports
            WHERE facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND report_id IN (
            SELECT id FROM sdis.reports
            WHERE facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    );

CREATE POLICY pol_patient_ext_id_fail_closed ON sdis.patient_external_identifiers
    AS RESTRICTIVE FOR ALL TO sdis_app
    USING (
        sdis.current_organization_id() IS NOT NULL
        AND patient_id IN (
            SELECT p.id FROM sdis.patients p
            WHERE p.registered_at_facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    )
    WITH CHECK (
        sdis.current_organization_id() IS NOT NULL
        AND patient_id IN (
            SELECT p.id FROM sdis.patients p
            WHERE p.registered_at_facility_id IN (
                SELECT id FROM sdis.facilities
                WHERE organization_id = sdis.current_organization_id()
            )
        )
    );

COMMENT ON POLICY pol_patients_fail_closed ON sdis.patients IS
    'RLS-01: fail-closed facility boundary — requires both tenant GUCs; unset context denies all rows';
COMMENT ON POLICY pol_terminology_fail_closed ON sdis.terminology_mappings IS
    'RLS-01: fail-closed facility boundary for terminology (global rows remain deployment-wide)';
COMMENT ON POLICY pol_organizations_fail_closed ON sdis.organizations IS
    'RLS-01: fail-closed org boundary — requires the organization GUC';
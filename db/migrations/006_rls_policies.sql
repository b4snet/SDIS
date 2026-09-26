-- Migration 006: Row Level Security Policies
-- Implements tenant/facility isolation at the database level

SET search_path = sdis, public;

-- ============================================================
-- Create application role
-- ============================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sdis_app') THEN
        CREATE ROLE sdis_app NOLOGIN NOBYPASSRLS;
    END IF;
END
$$;

-- Grant basic permissions to sdis_app
GRANT USAGE ON SCHEMA sdis TO sdis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA sdis TO sdis_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA sdis TO sdis_app;

-- ============================================================
-- Enable RLS on all tenant-scoped tables
-- ============================================================
ALTER TABLE sdis.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.facilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.patients ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.patient_external_identifiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.encounters ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.diagnostic_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.specimens ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.specimen_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.interpretations ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.report_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.audit_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- GUCs for tenant/facility context (set by application per transaction)
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.current_organization_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('sdis.organization_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sdis.current_facility_id() RETURNS UUID AS $$
    SELECT NULLIF(current_setting('sdis.facility_id', true), '')::UUID;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION sdis.current_user_id() RETURNS TEXT AS $$
    SELECT current_setting('sdis.user_id', true);
$$ LANGUAGE sql STABLE;

-- ============================================================
-- RLS Policies - Organization level
-- ============================================================
-- Organizations: users can only see their own organization
CREATE POLICY pol_organizations_tenant_isolation ON sdis.organizations
    FOR ALL TO sdis_app
    USING (id = sdis.current_organization_id())
    WITH CHECK (id = sdis.current_organization_id());

-- ============================================================
-- RLS Policies - Facility level
-- ============================================================
CREATE POLICY pol_facilities_tenant_isolation ON sdis.facilities
    FOR ALL TO sdis_app
    USING (organization_id = sdis.current_organization_id())
    WITH CHECK (organization_id = sdis.current_organization_id());

-- ============================================================
-- RLS Policies - Department level
-- ============================================================
CREATE POLICY pol_departments_tenant_isolation ON sdis.departments
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

-- ============================================================
-- RLS Policies - Patients
-- ============================================================
CREATE POLICY pol_patients_tenant_isolation ON sdis.patients
    FOR ALL TO sdis_app
    USING (registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_patients_facility_isolation ON sdis.patients
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR registered_at_facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR registered_at_facility_id = sdis.current_facility_id());

-- ============================================================
-- RLS Policies - Patient External Identifiers
-- ============================================================
CREATE POLICY pol_patient_ext_id_tenant ON sdis.patient_external_identifiers
    FOR ALL TO sdis_app
    USING (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())))
    WITH CHECK (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())));

-- ============================================================
-- RLS Policies - Encounters
-- ============================================================
CREATE POLICY pol_encounters_tenant ON sdis.encounters
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_encounters_facility ON sdis.encounters
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- ============================================================
-- RLS Policies - Diagnostic Orders
-- ============================================================
CREATE POLICY pol_orders_tenant ON sdis.diagnostic_orders
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_orders_facility ON sdis.diagnostic_orders
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- ============================================================
-- RLS Policies - Order Items
-- ============================================================
CREATE POLICY pol_order_items_tenant ON sdis.order_items
    FOR ALL TO sdis_app
    USING (order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())))
    WITH CHECK (order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())));

-- ============================================================
-- RLS Policies - Specimens
-- ============================================================
CREATE POLICY pol_specimens_tenant ON sdis.specimens
    FOR ALL TO sdis_app
    USING (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())))
    WITH CHECK (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())));

CREATE POLICY pol_specimens_facility ON sdis.specimens
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id = sdis.current_facility_id())))
    WITH CHECK (sdis.current_facility_id() IS NULL OR order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id = sdis.current_facility_id())));

-- ============================================================
-- RLS Policies - Specimen Events
-- ============================================================
CREATE POLICY pol_specimen_events_tenant ON sdis.specimen_events
    FOR ALL TO sdis_app
    USING (specimen_id IN (SELECT id FROM sdis.specimens WHERE patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))))
    WITH CHECK (specimen_id IN (SELECT id FROM sdis.specimens WHERE patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))));

-- ============================================================
-- RLS Policies - Observations
-- ============================================================
CREATE POLICY pol_observations_tenant ON sdis.observations
    FOR ALL TO sdis_app
    USING (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())))
    WITH CHECK (patient_id IN (SELECT id FROM sdis.patients WHERE registered_at_facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())));

CREATE POLICY pol_observations_facility ON sdis.observations
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id = sdis.current_facility_id())))
    WITH CHECK (sdis.current_facility_id() IS NULL OR order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id = sdis.current_facility_id())));

-- ============================================================
-- RLS Policies - Interpretations
-- ============================================================
CREATE POLICY pol_interpretations_tenant ON sdis.interpretations
    FOR ALL TO sdis_app
    USING (order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))))
    WITH CHECK (order_item_id IN (SELECT id FROM sdis.order_items WHERE order_id IN (SELECT id FROM sdis.diagnostic_orders WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))));

-- ============================================================
-- RLS Policies - Reports
-- ============================================================
CREATE POLICY pol_reports_tenant ON sdis.reports
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_reports_facility ON sdis.reports
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- ============================================================
-- RLS Policies - Report Versions
-- ============================================================
CREATE POLICY pol_report_versions_tenant ON sdis.report_versions
    FOR ALL TO sdis_app
    USING (report_id IN (SELECT id FROM sdis.reports WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())))
    WITH CHECK (report_id IN (SELECT id FROM sdis.reports WHERE facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id())));

-- ============================================================
-- RLS Policies - Audit Events
-- ============================================================
CREATE POLICY pol_audit_tenant ON sdis.audit_events
    FOR ALL TO sdis_app
    USING (organization_id = sdis.current_organization_id())
    WITH CHECK (organization_id = sdis.current_organization_id());

CREATE POLICY pol_audit_facility ON sdis.audit_events
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

-- ============================================================
-- Modality table - read-only for app role (seeded data)
-- ============================================================
ALTER TABLE sdis.modalities ENABLE ROW LEVEL SECURITY;
CREATE POLICY pol_modalities_read ON sdis.modalities
    FOR SELECT TO sdis_app
    USING (true);

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON POLICY pol_organizations_tenant_isolation ON sdis.organizations IS 'Users can only access their own organization';
COMMENT ON POLICY pol_patients_facility_isolation ON sdis.patients IS 'Facility-scoped access for patients';
COMMENT ON POLICY pol_orders_facility ON sdis.diagnostic_orders IS 'Facility-scoped access for orders';
COMMENT ON POLICY pol_audit_tenant ON sdis.audit_events IS 'Audit events scoped to organization + facility';
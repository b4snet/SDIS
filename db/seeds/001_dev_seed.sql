-- Seed data for local development and testing
-- This file is executed after migrations to create baseline test data

SET search_path = sdis, public;

-- ============================================================
-- Organization A
-- ============================================================
INSERT INTO sdis.organizations (id, name, code) VALUES
    ('00000000-0000-4000-8000-000000000001', 'Swasthya Health Network', 'SHN')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Facilities for Organization A
-- ============================================================
INSERT INTO sdis.facilities (id, organization_id, name, code, timezone) VALUES
    ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Swasthya Central Lab', 'SCL', 'Asia/Kathmandu'),
    ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000001', 'Swasthya Satellite Clinic', 'SSC', 'Asia/Kathmandu')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Departments for Facility 0011
-- ============================================================
INSERT INTO sdis.departments (id, facility_id, name, code, modalities) VALUES
    ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000011', 'Central Laboratory', 'CLAB', ARRAY['LAB']),
    ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000011', 'Cardiology', 'CARD', ARRAY['ECG','ECHO','TMT'])
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Test Patient
-- ============================================================
INSERT INTO sdis.patients (id, registered_at_facility_id, full_name, sex, birth_date) VALUES
    ('00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000011', 'Test Patient One', 'M', '1990-01-15')
ON CONFLICT (id) DO NOTHING;

-- Patient external reference (Hospital MRN)
INSERT INTO sdis.patient_external_identifiers (patient_id, system, value, facility_id) VALUES
    ('00000000-0000-4000-8000-0000000000e1', 'HOSPITAL_MRN', 'MRN-1001', '00000000-0000-4000-8000-000000000011')
ON CONFLICT (system, value, facility_id) DO NOTHING;

-- ============================================================
-- Test Encounter
-- ============================================================
INSERT INTO sdis.encounters (id, patient_id, facility_id, started_at) VALUES
    ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-0000000000e1', '00000000-0000-4000-8000-000000000011', '2026-09-20 08:00:00+05:45')
ON CONFLICT (id) DO NOTHING;

-- ============================================================
-- Second Organization (for cross-tenant testing)
-- ============================================================
INSERT INTO sdis.organizations (id, name, code) VALUES
    ('00000000-0000-4000-8000-000000000009', 'Other Health System', 'OHS')
ON CONFLICT (id) DO NOTHING;

INSERT INTO sdis.facilities (id, organization_id, name, code, timezone) VALUES
    ('00000000-0000-4000-8000-000000000019', '00000000-0000-4000-8000-000000000009', 'Other Facility', 'OF1', 'Asia/Kathmandu')
ON CONFLICT (id) DO NOTHING;
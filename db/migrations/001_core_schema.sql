-- Migration 001: Core Schema - Organizations, Facilities, Departments
-- This migration creates the core organizational hierarchy

-- Create the sdis schema
CREATE SCHEMA IF NOT EXISTS sdis;

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Set search path
SET search_path = sdis, public;

-- ============================================================
-- ORGANIZATIONS
-- ============================================================
CREATE TABLE sdis.organizations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    code            TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_organizations_code ON sdis.organizations(code);

-- ============================================================
-- FACILITIES
-- ============================================================
CREATE TABLE sdis.facilities (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL REFERENCES sdis.organizations(id) ON DELETE RESTRICT,
    name                TEXT NOT NULL,
    code                TEXT NOT NULL,
    timezone            TEXT NOT NULL DEFAULT 'UTC',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, code)
);

CREATE INDEX idx_facilities_organization ON sdis.facilities(organization_id);
CREATE INDEX idx_facilities_code ON sdis.facilities(organization_id, code);

-- ============================================================
-- DEPARTMENTS / DIAGNOSTIC UNITS
-- ============================================================
CREATE TABLE sdis.departments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    name                TEXT NOT NULL,
    code                TEXT NOT NULL,
    modalities          TEXT[] NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (facility_id, code)
);

CREATE INDEX idx_departments_facility ON sdis.departments(facility_id);

-- ============================================================
-- Updated at trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER trg_organizations_updated_at
    BEFORE UPDATE ON sdis.organizations
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

CREATE TRIGGER trg_facilities_updated_at
    BEFORE UPDATE ON sdis.facilities
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

CREATE TRIGGER trg_departments_updated_at
    BEFORE UPDATE ON sdis.departments
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON SCHEMA sdis IS 'SDIS - Swasthya Diagnostic Information System core schema';
COMMENT ON TABLE sdis.organizations IS 'Legal/supervisory entities owning facilities';
COMMENT ON TABLE sdis.facilities IS 'Physical operating sites (clinics, labs, hospitals)';
COMMENT ON TABLE sdis.departments IS 'Diagnostic units within a facility, each with modality capabilities';
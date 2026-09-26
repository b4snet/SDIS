-- Migration 002: Clinical Schema - Patients, Encounters, External References
-- This migration creates the patient identity and encounter tables

SET search_path = sdis, public;

-- ============================================================
-- PATIENTS
-- ============================================================
CREATE TABLE sdis.patients (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    registered_at_facility_id   UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    full_name                   TEXT NOT NULL,
    sex                         TEXT NOT NULL CHECK (sex IN ('F', 'M', 'OTHER', 'UNKNOWN')),
    birth_date                  DATE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_patients_registered_facility ON sdis.patients(registered_at_facility_id);
CREATE INDEX idx_patients_name ON sdis.patients(full_name);

-- ============================================================
-- PATIENT EXTERNAL IDENTIFIERS (HMS MRN, National ID, Enterprise ID, etc.)
-- ============================================================
CREATE TABLE sdis.patient_external_identifiers (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE CASCADE,
    system              TEXT NOT NULL,  -- 'HOSPITAL_MRN', 'NATIONAL_ID', 'ENTERPRISE', 'EXTERNAL', etc.
    value               TEXT NOT NULL,
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (system, value, facility_id)
);

CREATE INDEX idx_patient_ext_id_patient ON sdis.patient_external_identifiers(patient_id);
CREATE INDEX idx_patient_ext_id_lookup ON sdis.patient_external_identifiers(system, value, facility_id);

-- ============================================================
-- ENCOUNTERS
-- ============================================================
CREATE TABLE sdis.encounters (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    started_at          TIMESTAMPTZ NOT NULL,
    ended_at            TIMESTAMPTZ,
    external_ref_system TEXT,
    external_ref_value  TEXT,
    external_ref_facility_id UUID REFERENCES sdis.facilities(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_encounters_patient ON sdis.encounters(patient_id);
CREATE INDEX idx_encounters_facility ON sdis.encounters(facility_id);
CREATE INDEX idx_encounters_started ON sdis.encounters(started_at);
CREATE INDEX idx_encounters_external_ref ON sdis.encounters(external_ref_system, external_ref_value, external_ref_facility_id);

-- ============================================================
-- Updated at triggers
-- ============================================================
CREATE TRIGGER trg_patients_updated_at
    BEFORE UPDATE ON sdis.patients
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

CREATE TRIGGER trg_encounters_updated_at
    BEFORE UPDATE ON sdis.encounters
    FOR EACH ROW EXECUTE FUNCTION sdis.set_updated_at();

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE sdis.patients IS 'Canonical patient identity - single source of truth';
COMMENT ON TABLE sdis.patient_external_identifiers IS 'External references (HMS MRN, National ID, Enterprise ID) - never a second identity source';
COMMENT ON TABLE sdis.encounters IS 'Patient visit/encounter - standalone or HMS-integrated';
COMMENT ON COLUMN sdis.patients.registered_at_facility_id IS 'Primary affiliation facility where patient was registered';
COMMENT ON COLUMN sdis.encounters.external_ref_system IS 'External HMS encounter reference - never duplicated';
-- Step 22 — Patient access principal.
--
-- The append-only audit schema admits provenance actors of kind
-- USER / PRACTITIONER / SERVICE / SYSTEM. Patient-facing access (Step 22)
-- is a first-class principal: access events must record WHO (the patient
-- principal) without collapsing into an anonymous SYSTEM actor.
--
-- This migration widens the audit actor-kind vocabulary with 'PATIENT'.
-- It changes NO rows, adds NO tables, and touches no clinical data. The
-- append-only guarantee, hash chain, RLS, and all existing kinds are
-- untouched. Forward-only, ASCII-safe.

-- Drop the existing actor_kind CHECK (auto-named by PostgreSQL at creation).
DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    SELECT c.conname INTO constraint_name
    FROM pg_constraint c
    JOIN pg_class t   ON c.conrelid = t.oid
    JOIN pg_namespace n ON t.relnamespace = n.oid
    WHERE c.contype = 'c'
      AND t.relname = 'audit_events'
      AND n.nspname = 'sdis'
      AND pg_get_constraintdef(c.oid) LIKE '%actor_kind%';
    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE sdis.audit_events DROP CONSTRAINT %I', constraint_name);
    END IF;
END $$;

ALTER TABLE sdis.audit_events ADD CONSTRAINT audit_events_actor_kind_check
    CHECK (actor_kind IN ('USER','PRACTITIONER','SERVICE','SYSTEM','PATIENT'));

-- ============================================================
-- PATIENT PRINCIPAL BINDINGS (ownership resolution)
-- ============================================================
-- Binds an authenticated patient principal (the credential userId at the
-- application boundary) to the ONE canonical SDIS patient identity whose
-- records it may access. This is authorization plumbing, NOT a second
-- patient identity system: demographics, external identifiers, and
-- lookup attributes are never ownership proof. Credential material must
-- NEVER be stored here (only the non-secret principal reference).
CREATE TABLE IF NOT EXISTS sdis.patient_principal_bindings (
    user_id             TEXT PRIMARY KEY,
    patient_id          UUID NOT NULL REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patient_bindings_patient
    ON sdis.patient_principal_bindings(patient_id);

-- The application role resolves bindings for authorization only; it can never
-- remove or recreate the binding row beyond the upsert contract above.
GRANT SELECT, INSERT, UPDATE ON sdis.patient_principal_bindings TO sdis_app;

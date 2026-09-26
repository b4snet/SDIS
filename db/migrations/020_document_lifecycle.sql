-- Step 23 — Document lifecycle & patient-visibility columns.
--
-- Extends the Step-13 document metadata table with:
--   status          ACTIVE | RETIRED  (access-removal lifecycle; NO physical
--                   deletion — clinical documents carry retention duties)
--   patient_visible BOOLEAN           (explicit patient-access eligibility;
--                   NOT derived from document type; default FALSE)
--
-- Backfill: pre-existing documents are ACTIVE and NOT patient-visible, which
-- preserves their exact pre-Step-23 behavior. Forward-only, ASCII-safe.

ALTER TABLE sdis.documents
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'RETIRED'));

ALTER TABLE sdis.documents
    ADD COLUMN IF NOT EXISTS patient_visible BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_documents_patient_status
    ON sdis.documents(patient_id, facility_id, status);

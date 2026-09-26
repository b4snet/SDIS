-- Step 27 — Laboratory Workflow Completion: specimen exception & accessioning.
--
-- Forward-only addition to the EXISTING sdis.specimens table (migration 004):
--
-- - accession_number: stable laboratory OPERATIONAL identity assigned exactly
--   once at RECEIVED. GLOBALLY unique (the uniqueness index below is not
--   facility-partitioned — strictly stronger than the earlier facility-scope
--   design note, documented in the audit as BASELINE-04); never a replacement
--   for the global entity id. Nullable: specimens are collected before they
--   are accessioned, and ACQUISITION records (modality acquisitions without a
--   physical specimen) may never be accessioned.
-- - rejection_reason: explicit, vocabulary-bound exception reason recorded
--   when the specimen is REJECTED. History-preserving: rejection is a status
--   transition, never a deletion. Nullable: only REJECTED specimens carry one.
--
-- No destructive change; no existing column is altered or dropped.

ALTER TABLE sdis.specimens
    ADD COLUMN accession_number TEXT;

ALTER TABLE sdis.specimens
    ADD COLUMN rejection_reason TEXT
    CHECK (
        rejection_reason IN (
            'INSUFFICIENT_SPECIMEN',
            'INCORRECT_SPECIMEN_TYPE',
            'DAMAGED_SPECIMEN',
            'LABELING_PROBLEM',
            'PROCESSING_PROBLEM'
        )
    );

-- GLOBAL uniqueness of accession numbers (partial: only accessioned specimens
-- participate). The index is intentionally NOT facility-partitioned — one
-- accession number is unique across every facility (BASELINE-04; strictly
-- stronger than a facility-scoped contract, never weakened). The APPLICATION
-- probe stays facility-scoped: `findByAccessionNumber` joins the specimen to
-- its owning order and filters on that order's facility, so an accessioning
-- desk can never resolve another facility's specimen through the API.
CREATE UNIQUE INDEX IF NOT EXISTS uq_specimens_accession_per_facility
    ON sdis.specimens (accession_number)
    WHERE accession_number IS NOT NULL;

-- Operational lookups: find specimens by accession (accessioning desk) and
-- follow a specimen's rejection state.
CREATE INDEX IF NOT EXISTS ix_specimens_rejection_reason
    ON sdis.specimens (rejection_reason)
    WHERE rejection_reason IS NOT NULL;

-- Rejection reasons are recorded only on rejected specimens (application rule,
-- enforced at the boundary; a soft CHECK keeps the data honest without
-- back-constraining the status machine's transition mechanics).
ALTER TABLE sdis.specimens
    ADD CONSTRAINT ck_specimens_rejection_consistency
    CHECK (
        (status = 'REJECTED' AND rejection_reason IS NOT NULL)
        OR (status <> 'REJECTED' AND rejection_reason IS NULL)
    );

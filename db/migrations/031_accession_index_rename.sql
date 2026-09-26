-- Migration 031: rename the misleading accession uniqueness index (DB-01).
--
-- Migration 022 created `uq_specimens_accession_per_facility`, but the index
-- constrains `(accession_number)` GLOBALLY (intentional per BASELINE-04 —
-- strictly stronger than facility scope). The name claims per-facility scope
-- and has misled readers since. This migration renames it to state the real
-- contract. Forward-only, data-preserving (a pure catalog rename); guarded so
-- replay against an already-renamed database is a no-op.

SET search_path = sdis, public;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_class
        WHERE relname = 'uq_specimens_accession_per_facility'
    ) THEN
        ALTER INDEX sdis.uq_specimens_accession_per_facility
            RENAME TO uq_specimens_accession_global;
    END IF;
END $$;

COMMENT ON INDEX sdis.uq_specimens_accession_global IS
    'DB-01: accession numbers are unique GLOBALLY (partial: only accessioned specimens).';

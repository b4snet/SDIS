-- Step 24 — Department master-data lifecycle.
--
-- Departments are canonical master data (migration 001) already referenced
-- by configuration (013), orders, and seeds. Step 24 adds an explicit
-- ACTIVE/INACTIVE lifecycle WITHOUT deleting anything: deactivation removes
-- the department from active administration while every historical reference
-- stays resolvable. Forward-only, ASCII-safe.

ALTER TABLE sdis.departments
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'INACTIVE'));

-- The Step-15 department-scoped configuration lookup and the Step-24
-- administration listing both resolve by facility.
CREATE INDEX IF NOT EXISTS idx_departments_facility_status
    ON sdis.departments(facility_id, status);

-- Step 27 — Laboratory Workflow Completion: quality records & QC hold.
--
-- The quality domain contract (`src/domain/quality/quality.ts`) existed from
-- Step 1 but had no persistence. This migration adds the canonical storage:
-- facility-scoped quality records (QC/IQC/EQA/CALIBRATION/MAINTENANCE/
-- NONCONFORMITY/... bounded families) plus the OPERATIONAL analytical-hold
-- boundary used by report finalization.
--
-- Strict separation preserved: a hold PAUSES the workflow (operational);
-- it never rewrites patient results and encodes no clinical threshold.
-- Append-oriented: a hold release updates hold columns, never deletes rows.

CREATE TABLE sdis.quality_records (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    facility_id        UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    family             TEXT NOT NULL CHECK (family IN (
                           'SOP','DOCUMENT_CONTROL','TRAINING','COMPETENCY',
                           'CALIBRATION','MAINTENANCE','QC','IQC','EQA',
                           'NONCONFORMITY','CORRECTIVE_ACTION','PREVENTIVE_ACTION',
                           'RISK','INCIDENT','INTERNAL_AUDIT','QUALITY_INDICATOR',
                           'RECORDS_RETENTION')),
    reference_type     TEXT NOT NULL,
    reference_id       TEXT,
    at                 TIMESTAMPTZ NOT NULL,
    provenance         JSONB NOT NULL,
    note               TEXT,
    -- Analytical hold (Step 27): set with a record, released by an authorized
    -- actor. Active = hold_reason set AND hold_released_at NULL.
    hold_reason        TEXT,
    hold_released_at   TIMESTAMPTZ,
    hold_released_by   TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_quality_hold_release_consistency CHECK (
        (hold_released_at IS NULL AND hold_released_by IS NULL)
        OR (hold_released_at IS NOT NULL)
    )
);

-- Tenant/facility RLS consistent with the rest of the schema (fail-closed
-- posture from migration 014: the application role needs the GUCs).
ALTER TABLE sdis.quality_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.quality_records FORCE ROW LEVEL SECURITY;

CREATE POLICY pol_quality_records_tenant_isolation ON sdis.quality_records
    FOR ALL TO sdis_app
    USING (
        facility_id IN (
            SELECT f.id FROM sdis.facilities f
             WHERE f.organization_id = sdis.current_organization_id()
        )
    )
    WITH CHECK (
        facility_id IN (
            SELECT f.id FROM sdis.facilities f
             WHERE f.organization_id = sdis.current_organization_id()
        )
    );

CREATE POLICY pol_quality_records_facility_isolation ON sdis.quality_records
    FOR ALL TO sdis_app
    USING (facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id = sdis.current_facility_id());

-- Application role privileges (append + lifecycle updates; no delete).
GRANT SELECT, INSERT, UPDATE ON sdis.quality_records TO sdis_app;

-- Operational lookups.
CREATE INDEX IF NOT EXISTS ix_quality_records_facility_at
    ON sdis.quality_records (facility_id, at);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_records_active_hold
    ON sdis.quality_records (facility_id)
    WHERE hold_reason IS NOT NULL AND hold_released_at IS NULL;

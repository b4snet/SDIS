-- Migration 005: Audit and Provenance Schema
-- Append-only audit events and provenance tracking

SET search_path = sdis, public;

-- ============================================================
-- AUDIT EVENTS (Append-only)
-- ============================================================
CREATE TABLE sdis.audit_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action              TEXT NOT NULL CHECK (action IN (
        'CREATED','UPDATED','VERIFIED','FINALIZED','AMENDED','REPORTED',
        'CANCELLED','TRANSITIONED','IMPORTED','EXPORTED'
    )),
    object_type         TEXT NOT NULL,
    object_id           UUID NOT NULL,
    at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Tenant/facility context
    organization_id     UUID NOT NULL REFERENCES sdis.organizations(id) ON DELETE RESTRICT,
    facility_id         UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    department_id       UUID REFERENCES sdis.departments(id) ON DELETE SET NULL,
    -- Provenance
    actor_kind          TEXT NOT NULL CHECK (actor_kind IN ('USER','PRACTITIONER','SERVICE','SYSTEM')),
    actor_id            TEXT NOT NULL,
    actor_display_name  TEXT,
    source_kind         TEXT NOT NULL CHECK (source_kind IN ('HUMAN','DEVICE','ALGORITHM','INTEGRATION','SYSTEM')),
    source_label        TEXT NOT NULL,
    source_ref          TEXT,
    -- Optional detail (no PHI)
    detail              TEXT,
    -- Hash chain for integrity
    previous_hash       BYTEA,
    event_hash          BYTEA NOT NULL
);

CREATE INDEX idx_audit_events_object ON sdis.audit_events(object_type, object_id);
CREATE INDEX idx_audit_events_org_facility ON sdis.audit_events(organization_id, facility_id);
CREATE INDEX idx_audit_events_at ON sdis.audit_events(at DESC);
CREATE INDEX idx_audit_events_actor ON sdis.audit_events(actor_id);

-- ============================================================
-- Audit hash chain function
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.compute_audit_hash(
    p_id UUID,
    p_action TEXT,
    p_object_type TEXT,
    p_object_id UUID,
    p_at TIMESTAMPTZ,
    p_organization_id UUID,
    p_facility_id UUID,
    p_department_id UUID,
    p_actor_kind TEXT,
    p_actor_id TEXT,
    p_actor_display_name TEXT,
    p_source_kind TEXT,
    p_source_label TEXT,
    p_source_ref TEXT,
    p_detail TEXT,
    p_previous_hash BYTEA
) RETURNS BYTEA AS $$
DECLARE
    v_hash BYTEA;
BEGIN
    v_hash := digest(
        concat_ws('|',
            p_id::text,
            p_action,
            p_object_type,
            p_object_id::text,
            p_at::text,
            p_organization_id::text,
            COALESCE(p_facility_id::text, ''),
            COALESCE(p_department_id::text, ''),
            p_actor_kind,
            p_actor_id,
            COALESCE(p_actor_display_name, ''),
            p_source_kind,
            p_source_label,
            COALESCE(p_source_ref, ''),
            COALESCE(p_detail, ''),
            COALESCE(encode(p_previous_hash, 'hex'), '')
        ),
        'sha256'
    );
    RETURN v_hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ============================================================
-- Audit insert trigger (enforces append-only, computes hash chain)
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.audit_insert_trigger()
RETURNS TRIGGER AS $$
DECLARE
    v_previous_hash BYTEA;
    v_new_hash BYTEA;
BEGIN
    -- Get previous hash for this organization/facility chain
    SELECT event_hash INTO v_previous_hash
    FROM sdis.audit_events
    WHERE organization_id = NEW.organization_id
      AND facility_id = NEW.facility_id
    ORDER BY at DESC
    LIMIT 1;

    -- Compute new hash
    v_new_hash := sdis.compute_audit_hash(
        NEW.id, NEW.action, NEW.object_type, NEW.object_id, NEW.at,
        NEW.organization_id, NEW.facility_id, NEW.department_id,
        NEW.actor_kind, NEW.actor_id, NEW.actor_display_name,
        NEW.source_kind, NEW.source_label, NEW.source_ref,
        NEW.detail, v_previous_hash
    );

    -- Set the computed hash
    NEW.event_hash := v_new_hash;
    NEW.previous_hash := v_previous_hash;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger
DROP TRIGGER IF EXISTS trg_audit_insert ON sdis.audit_events;
CREATE TRIGGER trg_audit_insert
    BEFORE INSERT ON sdis.audit_events
    FOR EACH ROW EXECUTE FUNCTION sdis.audit_insert_trigger();

-- ============================================================
-- Prevent updates/deletes on audit events
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit events are append-only - % not allowed', TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_no_update ON sdis.audit_events;
CREATE TRIGGER trg_audit_no_update
    BEFORE UPDATE ON sdis.audit_events
    FOR EACH ROW EXECUTE FUNCTION sdis.prevent_audit_modification();

DROP TRIGGER IF EXISTS trg_audit_no_delete ON sdis.audit_events;
CREATE TRIGGER trg_audit_no_delete
    BEFORE DELETE ON sdis.audit_events
    FOR EACH ROW EXECUTE FUNCTION sdis.prevent_audit_modification();

-- ============================================================
-- Audit verification function
-- ============================================================
CREATE OR REPLACE FUNCTION sdis.verify_audit_chain(
    p_organization_id UUID,
    p_facility_id UUID DEFAULT NULL
) RETURNS TABLE (
    event_id UUID,
    expected_hash BYTEA,
    actual_hash BYTEA,
    matches BOOLEAN
) AS $$
DECLARE
    v_row RECORD;
    v_previous_hash BYTEA := NULL;
BEGIN
    FOR v_row IN
        SELECT * FROM sdis.audit_events
        WHERE organization_id = p_organization_id
          AND (p_facility_id IS NULL OR facility_id = p_facility_id)
        ORDER BY at ASC
    LOOP
        -- Verify hash matches
        IF v_row.previous_hash IS DISTINCT FROM v_previous_hash THEN
            RETURN QUERY SELECT v_row.id, v_previous_hash, v_row.previous_hash, FALSE;
        END IF;

        -- Verify event hash
        IF v_row.event_hash IS DISTINCT FROM sdis.compute_audit_hash(
            v_row.id, v_row.action, v_row.object_type, v_row.object_id, v_row.at,
            v_row.organization_id, v_row.facility_id, v_row.department_id,
            v_row.actor_kind, v_row.actor_id, v_row.actor_display_name,
            v_row.source_kind, v_row.source_label, v_row.source_ref,
            v_row.detail, v_previous_hash
        ) THEN
            RETURN QUERY SELECT v_row.id,
                sdis.compute_audit_hash(
                    v_row.id, v_row.action, v_row.object_type, v_row.object_id, v_row.at,
                    v_row.organization_id, v_row.facility_id, v_row.department_id,
                    v_row.actor_kind, v_row.actor_id, v_row.actor_display_name,
                    v_row.source_kind, v_row.source_label, v_row.source_ref,
                    v_row.detail, v_previous_hash
                ),
                v_row.event_hash, FALSE;
        END IF;

        v_previous_hash := v_row.event_hash;
    END LOOP;

    RETURN QUERY SELECT NULL::UUID, NULL::BYTEA, NULL::BYTEA, TRUE
    WHERE NOT EXISTS (
        SELECT 1 FROM sdis.audit_events
        WHERE organization_id = p_organization_id
          AND (p_facility_id IS NULL OR facility_id = p_facility_id)
    );
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Comments
-- ============================================================
COMMENT ON TABLE sdis.audit_events IS 'Append-only audit trail with cryptographic hash chain';
COMMENT ON COLUMN sdis.audit_events.previous_hash IS 'Hash of previous event in the chain';
COMMENT ON COLUMN sdis.audit_events.event_hash IS 'SHA-256 hash of this event including previous hash';
COMMENT ON FUNCTION sdis.verify_audit_chain IS 'Verify audit chain integrity for an organization/facility';
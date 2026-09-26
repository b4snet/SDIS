-- Migration 016: Audit hash-chain serialization + explicit verification marker (AUDIT-01)
--
-- Defects closed:
--
-- 1. Chain FORK on concurrent inserts. The BEFORE INSERT trigger read the chain
--    head with `ORDER BY at DESC LIMIT 1`; two concurrent transactions could
--    read the SAME head and both link to it, producing two events with the
--    same previous_hash and a verification FALSE for the loser. The trigger now
--    takes a transaction-scoped advisory lock keyed on the (organization,
--    facility) chain, so head selection is serialized per chain; the second
--    writer blocks until the first commits and then links to the true head.
--
-- 2. Head selection is now APPEND-ORDER, not wall-clock order. With the old
--    max(at) head, chains still forked whenever two events committed with the
--    same `at` millisecond or out of at-order (concurrent writers, backdated
--    event timestamps): two later inserts could both select the same max(at)
--    head. The trigger now links to the current *unreferenced* event of the
--    chain (the true append head), which is unique under the advisory lock and
--    independent of `at` values.
--
-- 3. Verification contract. `verify_audit_chain` returned ZERO rows for a
--    healthy chain and a TRUE row only when no events existed; it also walked
--    events by `at`, so an intact append-order chain that was merely out of
--    at-order (or tie-timestamped) reported FALSE. It now walks the stored
--    previous_hash POINTERS from each chain root, so the chain is defined by
--    its links, not by timestamps. It always returns exactly one explicit TRUE
--    marker row when healthy, mismatch rows when broken, and FALSE for any
--    event not reachable from a root; a positive resultset is unambiguous.
--
-- Boundary: no schema changes; append-only triggers and the hash function are
-- preserved.

SET search_path = sdis, public;

-- ------------------------------------------------------------
-- 1. Serialized, append-ordered hash-chain insertion
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION sdis.audit_insert_trigger()
RETURNS TRIGGER AS $$
DECLARE
    v_previous_hash BYTEA;
    v_new_hash BYTEA;
BEGIN
    -- Serialize head selection per (organization, facility) chain: concurrent
    -- transactions for the same chain take this lock in order, so each reads
    -- the true committed head and the chain never forks.
    PERFORM pg_advisory_xact_lock(
        hashtextextended(NEW.organization_id::text || ':' || NEW.facility_id::text, 0)
    );

    -- Append-order head: the event whose hash NO OTHER event references. This
    -- is the last-appended event regardless of `at` (same-millisecond events or
    -- out-of-at-order commits can never fork). A broken chain may expose
    -- several unreferenced events; the deterministic tie-break still selects
    -- one head, and verification flags the break.
    SELECT e.event_hash INTO v_previous_hash
    FROM sdis.audit_events e
    WHERE e.organization_id = NEW.organization_id
      AND e.facility_id = NEW.facility_id
      AND NOT EXISTS (
          SELECT 1 FROM sdis.audit_events x
          WHERE x.organization_id = e.organization_id
            AND x.facility_id = e.facility_id
            AND x.previous_hash = e.event_hash
      )
    ORDER BY e.at DESC, e.id DESC
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

-- ------------------------------------------------------------
-- 2. Unambiguous, pointer-walk verification (explicit healthy marker)
-- ------------------------------------------------------------
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
    v_emitted BOOLEAN := FALSE;
    v_scope_total INT;
    v_walk_total INT;
BEGIN
    -- Walk the stored previous_hash pointers from each chain root. Every new
    -- root restarts the walk context, so multiple roots (a forked genesis) and
    -- multiple facilities are handled per chain.
    FOR v_row IN
        WITH RECURSIVE chain AS (
            SELECT e.* FROM sdis.audit_events e
            WHERE e.organization_id = p_organization_id
              AND (p_facility_id IS NULL OR e.facility_id = p_facility_id)
              AND e.previous_hash IS NULL
            UNION ALL
            SELECT e.* FROM sdis.audit_events e
            JOIN chain c ON e.previous_hash = c.event_hash
              AND e.organization_id = c.organization_id
              AND e.facility_id = c.facility_id
        )
        SELECT * FROM chain
    LOOP
        IF v_row.previous_hash IS NULL THEN
            -- A chain root: starts a fresh walk context; nothing to compare.
            v_previous_hash := NULL;
        ELSIF v_row.previous_hash IS DISTINCT FROM v_previous_hash THEN
            -- Pointer integrity: this event must follow the previously walked
            -- event. Fires for forks (two events sharing one predecessor) and
            -- for events out of sequence.
            v_emitted := TRUE;
            RETURN QUERY SELECT v_row.id, v_previous_hash, v_row.previous_hash, FALSE;
        END IF;

        -- Hash integrity: recompute from the stored fields + previous hash.
        IF v_row.event_hash IS DISTINCT FROM sdis.compute_audit_hash(
            v_row.id, v_row.action, v_row.object_type, v_row.object_id, v_row.at,
            v_row.organization_id, v_row.facility_id, v_row.department_id,
            v_row.actor_kind, v_row.actor_id, v_row.actor_display_name,
            v_row.source_kind, v_row.source_label, v_row.source_ref,
            v_row.detail, v_previous_hash
        ) THEN
            v_emitted := TRUE;
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

    -- Orphan check: any event not reachable from a root (tampering, or a
    -- self/closed loop) must surface as broken, never be silently ignored.
    -- A closed loop raises a stack-depth error instead, which fails loud.
    SELECT count(*) INTO v_scope_total
    FROM sdis.audit_events e
    WHERE e.organization_id = p_organization_id
      AND (p_facility_id IS NULL OR e.facility_id = p_facility_id);
    SELECT count(*) INTO v_walk_total
    FROM (
        WITH RECURSIVE chain AS (
            SELECT e.* FROM sdis.audit_events e
            WHERE e.organization_id = p_organization_id
              AND (p_facility_id IS NULL OR e.facility_id = p_facility_id)
              AND e.previous_hash IS NULL
            UNION ALL
            SELECT e.* FROM sdis.audit_events e
            JOIN chain c ON e.previous_hash = c.event_hash
              AND e.organization_id = c.organization_id
              AND e.facility_id = c.facility_id
        )
        SELECT * FROM chain
    ) w;
    IF v_scope_total <> v_walk_total THEN
        v_emitted := TRUE;
        RETURN QUERY SELECT NULL::UUID, NULL::BYTEA, NULL::BYTEA, FALSE;
    END IF;

    -- Healthy chain (events exist and match, or no events at all): exactly one
    -- explicit TRUE marker row. A caller can now rely on a positive resultset
    -- with no matches = FALSE row meaning "verified".
    IF NOT v_emitted THEN
        RETURN QUERY SELECT NULL::UUID, NULL::BYTEA, NULL::BYTEA, TRUE;
    END IF;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION sdis.verify_audit_chain IS
    'Verify audit chain integrity: one TRUE marker row when healthy, mismatch rows when broken (AUDIT-01)';
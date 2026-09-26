-- Step 19 — Notifications & Event Delivery Foundation: durable schema.
--
-- Durable event/notification persistence for the delivery foundation:
--   * sdis.notification_events             -- append-only domain events (facts)
--   * sdis.notification_intents            -- per-channel delivery intents with
--                                            the explicit delivery state machine
--   * sdis.notification_delivery_attempts  -- append-only attempt ledger
--
-- Design rules (docs/DATA_INTEGRITY.md section 8):
--   * Events/intents are tenant- and facility-scoped and ride the RLS posture
--     of migration 014: ROW LEVEL SECURITY + FORCE, with the application role
--     running with both tenant GUCs set (permissive org + facility policies).
--   * Deterministic idempotency at the database layer:
--       duplicate event    -> UNIQUE (event_key)
--       duplicate queueing -> UNIQUE (event_id, channel)
--       duplicate worker   -> UNIQUE (intent_id, attempt_number)
--   * Bounded vocabularies are CHECK-enforced (event type, channel, status,
--     priority, attempt outcome/failure category) - no free-text state.
--   * Payload columns carry only the bounded, non-PHI metadata the event
--     contract allows (never clinical values, never credentials) and the
--     delivery lifecycle fields. No DELETE grant and no delete path.

CREATE TABLE sdis.notification_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_key       TEXT NOT NULL,
    event_type      TEXT NOT NULL CHECK (event_type IN (
                       'patient.registered','order.created','specimen.state_changed',
                       'observation.available','report.finalized','report.amended',
                       'charge.created','device.acquisition_received',
                       'inventory.low_stock','setup.config_changed')),
    schema_version  TEXT NOT NULL CHECK (schema_version IN ('1')),
    aggregate_type  TEXT NOT NULL,
    aggregate_id    TEXT NOT NULL,
    organization_id UUID NOT NULL REFERENCES sdis.organizations(id) ON DELETE RESTRICT,
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    correlation_id  TEXT NOT NULL,
    occurred_at     TIMESTAMPTZ NOT NULL,
    source_kind     TEXT NOT NULL CHECK (source_kind IN (
                       'HUMAN','DEVICE','ALGORITHM','INTEGRATION','SYSTEM')),
    source_label    TEXT NOT NULL,
    metadata        JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_notification_events_key UNIQUE (event_key)
);

CREATE TABLE sdis.notification_intents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id        UUID NOT NULL REFERENCES sdis.notification_events(id) ON DELETE RESTRICT,
    -- Denormalized at enqueue so read models need no payload joins (bounded).
    event_type      TEXT NOT NULL CHECK (event_type IN (
                       'patient.registered','order.created','specimen.state_changed',
                       'observation.available','report.finalized','report.amended',
                       'charge.created','device.acquisition_received',
                       'inventory.low_stock','setup.config_changed')),
    correlation_id  TEXT NOT NULL,
    channel         TEXT NOT NULL CHECK (channel IN (
                       'IN_MEMORY','IN_APP','EMAIL','SMS','WEBHOOK')),
    status          TEXT NOT NULL CHECK (status IN (
                       'PENDING','PROCESSING','DELIVERED','FAILED','RETRYING',
                       'PERMANENTLY_FAILED','CANCELLED')),
    priority        TEXT NOT NULL DEFAULT 'ROUTINE' CHECK (priority IN ('ROUTINE','HIGH')),
    recipient_scope TEXT NOT NULL,
    recipient_ref   TEXT,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    max_attempts    INTEGER NOT NULL DEFAULT 5,
    last_attempt_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    failed_at       TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,
    failure_reason  TEXT,
    organization_id UUID NOT NULL REFERENCES sdis.organizations(id) ON DELETE RESTRICT,
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_notification_intent_attempt_bounds CHECK (
        max_attempts >= 1 AND attempt_count >= 0 AND attempt_count <= max_attempts
    ),
    CONSTRAINT uq_notification_intents_event_channel UNIQUE (event_id, channel)
);

CREATE TABLE sdis.notification_delivery_attempts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    intent_id        UUID NOT NULL REFERENCES sdis.notification_intents(id) ON DELETE RESTRICT,
    attempt_number   INTEGER NOT NULL,
    attempted_at     TIMESTAMPTZ NOT NULL,
    outcome          TEXT NOT NULL CHECK (outcome IN ('SUCCESS','FAILED')),
    failure_category TEXT CHECK (failure_category IN (
                       'TEMPORARY_FAILURE','PERMANENT_FAILURE',
                       'UNSUPPORTED_CHANNEL','INVALID_DESTINATION')),
    failure_reason   TEXT,
    CONSTRAINT uq_notification_attempts_intent_number UNIQUE (intent_id, attempt_number)
);

-- Tenant/facility RLS consistent with the rest of the schema (fail-closed
-- posture from migration 014: the application role needs the GUCs).
ALTER TABLE sdis.notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.notification_events FORCE ROW LEVEL SECURITY;
ALTER TABLE sdis.notification_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.notification_intents FORCE ROW LEVEL SECURITY;
ALTER TABLE sdis.notification_delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sdis.notification_delivery_attempts FORCE ROW LEVEL SECURITY;

CREATE POLICY pol_notification_events_tenant_isolation
    ON sdis.notification_events FOR ALL TO sdis_app
    USING (organization_id = sdis.current_organization_id())
    WITH CHECK (organization_id = sdis.current_organization_id());

CREATE POLICY pol_notification_events_facility_isolation
    ON sdis.notification_events FOR ALL TO sdis_app
    USING (facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id = sdis.current_facility_id());

CREATE POLICY pol_notification_intents_tenant_isolation
    ON sdis.notification_intents FOR ALL TO sdis_app
    USING (organization_id = sdis.current_organization_id())
    WITH CHECK (organization_id = sdis.current_organization_id());

CREATE POLICY pol_notification_intents_facility_isolation
    ON sdis.notification_intents FOR ALL TO sdis_app
    USING (facility_id = sdis.current_facility_id())
    WITH CHECK (facility_id = sdis.current_facility_id());

CREATE POLICY pol_notification_attempts_tenant_isolation
    ON sdis.notification_delivery_attempts FOR ALL TO sdis_app
    USING (intent_id IN (
        SELECT i.id FROM sdis.notification_intents i
         WHERE i.organization_id = sdis.current_organization_id()
    ))
    WITH CHECK (intent_id IN (
        SELECT i.id FROM sdis.notification_intents i
         WHERE i.organization_id = sdis.current_organization_id()
    ));

CREATE POLICY pol_notification_attempts_facility_isolation
    ON sdis.notification_delivery_attempts FOR ALL TO sdis_app
    USING (intent_id IN (
        SELECT i.id FROM sdis.notification_intents i
         WHERE i.facility_id = sdis.current_facility_id()
    ))
    WITH CHECK (intent_id IN (
        SELECT i.id FROM sdis.notification_intents i
         WHERE i.facility_id = sdis.current_facility_id()
    ));

-- Application role privileges (append + lifecycle updates; no delete).
GRANT SELECT, INSERT, UPDATE ON sdis.notification_events TO sdis_app;
GRANT SELECT, INSERT, UPDATE ON sdis.notification_intents TO sdis_app;
GRANT SELECT, INSERT, UPDATE ON sdis.notification_delivery_attempts TO sdis_app;

-- Operational lookups: event history, keyset list, and the due-claim queue.
CREATE INDEX IF NOT EXISTS ix_notification_events_facility_at
    ON sdis.notification_events (facility_id, occurred_at);

CREATE INDEX IF NOT EXISTS ix_notification_intents_facility_created
    ON sdis.notification_intents (facility_id, created_at, id);

CREATE INDEX IF NOT EXISTS ix_notification_intents_due
    ON sdis.notification_intents (facility_id, status, next_attempt_at)
    WHERE status IN ('PENDING','FAILED','RETRYING') AND attempt_count < max_attempts;

COMMENT ON TABLE sdis.notification_events IS
    'Append-only durable domain events (Step 19 event delivery foundation).';
COMMENT ON TABLE sdis.notification_intents IS
    'Per-channel delivery intents with the explicit delivery state machine.';
COMMENT ON TABLE sdis.notification_delivery_attempts IS
    'Append-only delivery attempt ledger; one row per intent+attempt number.';
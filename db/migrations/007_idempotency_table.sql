-- Migration 007: Idempotency Keys Table
-- For durable idempotency across restarts

SET search_path = sdis, public;

CREATE TABLE sdis.idempotency_keys (
    key         TEXT PRIMARY KEY,
    value       JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_idempotency_expires ON sdis.idempotency_keys(expires_at);

-- IDEM-01/RLS-01: every schema migration since 006 grants its own tables to the
-- application role. 007 predates that pattern, so `idempotency_keys` was never
-- granted — under the tenant-scoped path (`SET ROLE sdis_app`) every idempotent
-- operation failed with `permission denied for table idempotency_keys`.
GRANT SELECT, INSERT, UPDATE, DELETE ON sdis.idempotency_keys TO sdis_app;

-- Cleanup function for expired keys
CREATE OR REPLACE FUNCTION sdis.cleanup_expired_idempotency_keys()
RETURNS INTEGER AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM sdis.idempotency_keys WHERE expires_at < now();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE sdis.idempotency_keys IS 'Durable idempotency keys for retry-safe operations';
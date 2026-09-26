-- Step 28 — Result verification, finalization & amendment governance.
--
-- The domain aggregate (src/domain/ordering/diagnostic-order.ts) now carries
-- verification attribution (verifiedByRef / verifiedAt) set by the server from
-- the SESSION actor on the RESULT_ENTERED -> VERIFIED transition. This migration
-- adds the durable columns; repositories persist and reload them.

ALTER TABLE sdis.diagnostic_orders
    ADD COLUMN verified_by_ref TEXT,
    ADD COLUMN verified_at     TIMESTAMPTZ;

-- Attribution is present only in the VERIFIED-or-later states, and never
-- appears on a cancelled order. A CHECK keeps the DB consistent with the
-- domain invariant (fail-closed: NULL elsewhere, NOT NULL once verified).
ALTER TABLE sdis.diagnostic_orders
    ADD CONSTRAINT ck_orders_verification_attribution
    CHECK (
        (verified_by_ref IS NULL) = (verified_at IS NULL)
        AND (
            verified_by_ref IS NULL
            OR status IN ('VERIFIED', 'FINALIZED', 'REPORTED')
        )
    );

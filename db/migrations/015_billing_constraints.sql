-- Migration 015: charges — one charge per (order_item, service) uniqueness (BILL-01)
--
-- The application-side duplicate guard (billing-service.ts createWithAudit)
-- is check-then-insert; two concurrent keyed/unkeyed requests can both pass
-- the read and both persist. The schema already enforces idempotency-key
-- uniqueness; this index closes the business rule at the database level so the
-- loser surfaces as the existing 23505 -> ConflictError contract (ASCII-safe:
-- the embedded test PostgreSQL initializes with WIN1252 encoding on Windows,
-- which cannot represent the arrow U+2192).
--
-- Boundary: schema-level invariants only — no pricing, tax, or workflow
-- policy changes.

SET search_path = sdis, public;

CREATE UNIQUE INDEX uq_charges_order_item_service
    ON sdis.charges (order_item_id, service_id);

COMMENT ON INDEX sdis.uq_charges_order_item_service IS
    'One charge per order item per billable service (database-enforced, BILL-01)';
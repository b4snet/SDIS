-- Migration 018: Diagnostic order workflow priority (Step 21)
--
-- Adds OPERATIONAL workflow priority to the existing diagnostic order. The
-- vocabulary is bounded (ROUTINE / URGENT / EMERGENCY) and every order has a
-- value: unstated means ROUTINE (the existing rows and the existing default
-- workflow are unchanged). Priority is an expediting attribute of the WORK —
-- it is NOT a diagnosis, a result, a critical-value determination, or a
-- recommendation, and it never alters clinical records. Critical RESULTS are
-- a separate, clinically-defined policy domain that this migration does not
-- model.
--
-- One denormalization-free change: priority lives ONLY on the order and is
-- DERIVED downstream through the existing order -> item -> specimen ->
-- observation -> interpretation -> report ownership chain. No downstream
-- table is modified (documents the Step-21 propagation decision: derive, do
-- not copy).
--
-- Conventions mirror migrations 003/013: forward-only, constrained values,
-- RLS already enforced at table level (006/014) and unchanged here.

ALTER TABLE sdis.diagnostic_orders
    ADD COLUMN priority TEXT NOT NULL DEFAULT 'ROUTINE'
    CONSTRAINT diagnostic_orders_priority_check
        CHECK (priority IN ('ROUTINE', 'URGENT', 'EMERGENCY'));

COMMENT ON COLUMN sdis.diagnostic_orders.priority IS
    'Operational workflow priority (Step 21). Expedites the WORK; never a clinical attribute. Critical results are a separate policy domain.';

-- The worklist query orders by priority rank, then received time. A composite
-- partial index covering the non-routine expedited work keeps the queue scan
-- bounded; within one priority the existing ordered_at index applies.
CREATE INDEX idx_diagnostic_orders_priority
    ON sdis.diagnostic_orders (priority, ordered_at)
    WHERE status NOT IN ('CANCELLED', 'REPORTED');

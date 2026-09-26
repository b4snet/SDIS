# SDIS Data Integrity, Concurrency & Transaction Model

Canonical integrity boundary (Step 33). Status: **complete for the shipped
foundation** — the model below is enforced, regression-tested, and documented;
code wins over this document on conflict.

## 1. The integrity chain

```text
Validated Command
  → Authorization (assertPermission, server-derived scope — Step 32)
  → Idempotency gate (runIdempotent — replay & payload-mismatch protection)
  → Domain invariants (state machines, bounded vocabularies)
  → Persistence constraints (FKs, unique/CHECK constraints, version CAS)
  → Committed State
  → Audit (hash-chained, append-only) + notification events (receipted)
```

No important mutation is partial: multi-row writes run inside a single
PostgreSQL transaction (`Database.transaction`, migration-safe RLS stamping);
side effects that must never be lost (audit) are written in the same
transactional unit or through the receipted notification boundary.

## 2. Transaction architecture (as discovered, Step 33 audit)

| Layer                       | Mechanism                                                                                                                                        | Location                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Connection/transactions     | Pool + `BEGIN`/`COMMIT`/`ROLLBACK` with role/GUC stamping (`sdis_app`, RLS GUCs transaction-local)                                               | `src/infrastructure/database/database.ts`            |
| Optimistic concurrency      | Version CAS: `UPDATE … WHERE id = $1 AND version = $N`; loser → `ConflictError` (LAB-02) on orders and specimens (PG **and** in-memory adapters) | `repositories.ts`, `in-memory.ts`                    |
| Cross-process single flight | `IdempotencyStore.withExclusive` — `pg_advisory_xact_lock` per key (PG), per-key promise chain (in-memory)                                       | `repositories.ts`, `in-memory.ts`                    |
| Stock floor                 | Conditional INSERT: the ledger SUM must cover the quantity in one statement; negative stock impossible at the persistence boundary               | `inventory-repository.ts` (`applyDepletingMovement`) |
| Billing uniqueness          | One charge per `(order_item, service)` — DB unique index (BILL-01, migration 015) + application conflict                                         | migration 015                                        |
| Audit chain                 | Per-chain advisory serialization, `verify_audit_chain` tamper detection                                                                          | migration 016                                        |
| Quality holds               | One active hold per facility (`uq_quality_records_active_hold`) blocks report finalization                                                       | migration 023                                        |

## 3. Idempotency semantics (§7–§11)

- Records are **facility-scoped**: `scope:facilityId:key` (SEC-32) — a retry
  can neither read nor plant another facility's memoized result.
- `runIdempotent` serializes same-key callers through `withExclusive`; only
  one authoritative `create` runs, both callers receive the same result.
- **Same-key/different-payload protection (INT-33 §10)**: session-keyed
  operations record a SHA-256 **fingerprint of the logical request shape**
  under the derived key `…:fp` (hex digest only — payloads are never stored).
  A replay whose logical operation differs is rejected with
  `IDEMPOTENCY_CONFLICT` instead of being memoized as the original. A retry
  that regenerates a client timestamp remains a replay (timestamps are not
  part of a logical operation's identity — codified by the Step-18 recovery
  drill). Wired into `order.create` (patient/encounter/modality/priority/
  items/source); other scopes keep pure replay semantics.
- First request / identical retry / different payload / concurrent same-key /
  failed create (nothing recorded; key reusable) are all specified and tested.

## 4. State-machine integrity (§20)

Transitions are domain-enumerated (order lifecycle, specimen lifecycle,
report versioning, lot lifecycle, quality holds); arbitrary status patching
does not exist — every mutation path routes through a transition guard that
preserves actor/provenance/timestamps. Finalized results and finalized report
versions are immutable; corrections are amendments with preserved lineage.

## 5. Concurrency rules (§13–§19, §34–§35)

- **No read-check-write on unique facts**: uniqueness is enforced by
  constraints; the application maps `23505` → `ConflictError` (409) so a lost
  create-race is a deterministic client outcome, never a raw constraint error.
- **CAS everywhere state was read**: stale versions conflict (409), callers
  re-read. The in-memory adapters implement the SAME CAS as PostgreSQL so
  tests cannot pass on a weaker double (§37).
- **Stock floor**: per-lot serialized depletion (PG: `SELECT … FOR UPDATE`
  on the lot row inside one transaction, then coverage check, then append;
  in-memory: synchronous snapshot+append); concurrent overdraw is impossible
  (CON-01 remediation — a bare conditional single-statement append does NOT
  serialize under READ COMMITTED).
- **Lock discipline**: transactions are short (persist-only), no network or
  file I/O inside them; advisory locks are per-key; lock ordering follows the
  single aggregate row — no cross-aggregate lock fan-out exists in the
  shipped boundary.

## 6. Historical immutability (§23)

Audit events (hash-chained, append-only), report versions, amendments,
inventory movement ledger, billing history, and QC records are never
rewritten; corrections append. `ON DELETE RESTRICT` protects clinical
lineage; no destructive cascades into clinical/audit tables.

## 7. Remaining integrity debt (documented, not hidden)

- Remediation hardening (migrations 027–031, all forward-only, no data
  changes): 027 closes the 017 fail-open `IS NULL OR` branches and adds
  RESTRICTIVE + FORCE on the integration tables (global NULL-facility registry
  rows keep in-org visibility); 028 enables/forces RLS on
  `patient_principal_bindings` (facility derived through the bound patient);
  029 tags `idempotency_keys` with the session facility, RLS-isolates tagged
  rows, and revokes the application DELETE grant; 030 backfills GUC-presence
  RESTRICTIVE policies on `quality_records` and the notification tables
  (no visibility change with context set); 031 renames the misleading
  accession index to `uq_specimens_accession_global`.

- Fingerprint coverage is currently `order.create`; other idempotent scopes
  remain pure-replay (safe: scoped + single-flight; payload substitution is
  only possible for same-principal same-facility keys, and the logical
  result is derived from the recorded operation).
- Replay-window decision (documented, deliberate — BASELINE-07): the 24 h TTL
  bounds the idempotency MEMO, not replay safety. A keyed replay after expiry
  never duplicates state: state-changing scopes re-derive the SAME logical
  result under `withExclusive` single-flight — for `charge.create` the result
  is read back from the persisted charge row (BILL-04) — and facility-scoped
  keys (SEC-32) make a foreign reclaim of the key impossible. An explicit
  "key reuse beyond window" rejection policy is intentionally NOT part of the
  Foundation contract.
- Accession-number uniqueness is GLOBAL (`uq_specimens_accession_global`
  indexes `accession_number` without a facility partition — strictly stronger
  than facility scope; renamed from the misleading per-facility name in
  migration 031, DB-01).
- Token-expiry refresh of idempotency records (24 h TTL) follows IDEM-01
  semantics (first-result-wins via `withExclusive`).

## 8. Notification & event delivery integrity (Step 19)

The durable event/notification boundary persists through the outbox chain
`notification_events` → `notification_intents` → `notification_delivery_attempts`
(migration 026):

- **Transactional emit**: an event and its per-channel intents are enqueued in
  ONE transaction. If any intent violates a bound (channel/status/priority
  vocabulary, attempt budget), the whole enqueue rolls back — no orphan events,
  no partial fan-out.
- **DB-layer idempotency** (deterministic, constraint-enforced):
  - duplicate event → `UNIQUE (event_key)` — a replay returns the canonical row;
  - duplicate queueing → `UNIQUE (event_id, channel)` — one intent per event+channel;
  - duplicate worker → `UNIQUE (intent_id, attempt_number)` + CAS settles — a
    re-executed attempt cannot double-deliver.
- **Explicit delivery state machine** (PENDING → PROCESSING → DELIVERED |
  FAILED | RETRYING | PERMANENTLY_FAILED | CANCELLED): transitions are
  domain-enumerated (reject-invalid), and every worker step is a conditional
  claim/settle (CAS on `status`), so concurrent dispatchers are single-winner
  and a stale settle is refused (`false`, never an overwrite).
- **Bounded deterministic retries**: `max_attempts` (default 5, CHECK-capped);
  the backoff schedule is a pure function of the attempt count (1 s base, 60 s
  cap) timestamped server-side; exhausted intents finalize to
  `PERMANENTLY_FAILED` — no unbounded or uncontrolled re-delivery.
- **Failure accounting**: every delivery outcome records an append-only attempt
  row in the same transaction as the status CAS — outcome and state cannot
  diverge.
- **RLS isolation**: the three tables carry the schema's permissive org +
  facility policies under `sdis_app` (valid org↔facility sessions only;
  `SCOPE_MISMATCH` rejected in-app) plus explicit `facility_id` filters on
  every statement; migration 030 adds GUC-presence RESTRICTIVE backstops so an
  unscoped session sees nothing; no `DELETE` grant — the delivery ledger is
  append-only.
- **Audit & no-delete**: lifecycle transitions (retry, cancel, dispatcher
  delivery/retry/finalization) are audited with a SYSTEM actor and never embed
  notification payloads; the delivery history is immutable (corrections are
  new intents/attempts, never rewrites).

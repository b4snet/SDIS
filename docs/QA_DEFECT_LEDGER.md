# SDIS QA Defect Ledger

Independent verification records (QA lane). Every entry is reproduced against
real behavior — disposable PostgreSQL or the application/HTTP layers — with
evidence, a verified fix specification, and the regression-test requirement.

Operating rule (per operator): QA/inspection mode — verify, record evidence,
**hold fixes**. Architecture/contract findings are decisions for the
architecture lane; straightforward defects keep a verified fix spec and
regression-test requirement but are NOT applied until FIX MODE is ordered.
While Freebuff is continuing the roadmap, billing code and the shared
`src/transport/validate.ts` id-parsers stay untouched.

**Fix Mode (audit order):** the Foundation Steps 1–18 defect entries below were
audited, fixed, and closed with regression tests (see **Closure record – Steps
1–18**). Step 19 (notifications) is Freebuff's parallel lane and is
out of scope here. Step 16 (report content/DTO versioning) was addressed at the
contract level only — documented as contract-only PARTIAL.

Status legend: `VERIFIED` observed · `HELD` fix spec ready, not applied ·
`FIXED` applied with passing regression test · `OPEN` awaiting
decision/scheduling.

---

## Closure record – Steps 1–18 (Fix Mode)

Closed 2026-09-22. Every entry below was fixed, has a regression test, and
passes in the post-fix gate. Regression files: see the individual entry
sections and the audit report.

| ID       | Fix applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Regression proof                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| LAB-01   | `finalizeReport`/`amendReport` wrapped in `runIdempotent` (finalizeOnce/amendOnce)                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | report-service tests + PG lab flow                                  |
| LAB-02   | Version-CAS on order/specimen PG saves (UPDATE … WHERE version; loser → ConflictError)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `tests/infrastructure/lab02-concurrency.test.ts`                    |
| IDEM-01  | `IdempotencyStore.withExclusive` port seam — PG advisory xact lock; in-memory single-flight                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/infrastructure/idempotency-concurrency.test.ts`              |
| AUDIT-01 | Audit insert serialized per chain (`pg_advisory_xact_lock`) with APPEND-ORDER head selection (the unreferenced event — same-ms or out-of-at-order commits cannot fork); `verify_audit_chain` walks the previous_hash pointers from each root (at-independent), flags orphans, and returns exactly one TRUE marker row when healthy                                                                                                                                                                                                                             | audit-persistence tests                                             |
| TERM-01  | `getMapping` resolves global mappings for facility sessions; facility overrides stay scoped                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | terminology tests                                                   |
| TERM-02  | Router forwards `global: true` → service 422                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | terminology HTTP tests                                              |
| TERM-03  | Shared `parseUuidPath` — all path ids validated as UUID v4 → 422                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | terminology/HTTP contract tests                                     |
| BILL-01  | Unique `(order_item, service)` index (migration 015) → ConflictError                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | billing-postgres tests                                              |
| BILL-02  | `save()` rowCount 0 → NotFoundError                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | billing-postgres tests                                              |
| BILL-03  | Shared `parseUuidPath` + router casts removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | HTTP contract tests                                                 |
| BILL-04  | Keyed replay served from persisted idempotency key (survives TTL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | billing-postgres tests                                              |
| BILL-05  | Dead port surface replaced by keyed replay path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | billing-postgres tests                                              |
| DEV-01   | Acquisition-first + deterministic per-observation sub-keys; port returns persisted acquisition id                                                                                                                                                                                                                                                                                                                                                                                                                                                              | device-ingestion tests                                              |
| DEV-02   | Order modality === device modality or ValidationError                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | device-ingestion tests                                              |
| DEV-03   | `rawPayload` required when orderItemId linked (422); `toObservationValue` number/string/null only                                                                                                                                                                                                                                                                                                                                                                                                                                                              | device-ingestion tests                                              |
| RLS-01   | Fail-closed RESTRICTIVE policies (migration 014) + missing `sdis_app` grant added on `idempotency_keys` (migration 007 — the one table 006's ALL-TABLES grant predated); tenant-scope stamped in `Database.query`/`transaction` (`SET ROLE sdis_app` + tenant GUCs), reset in `finally`; routes wrapped in `runWithTenantScope`; session-facility validation moved BEFORE tenant-scoped reads and the facility directory read outside tenant scope at the PG composition edge (403/`SCOPE_MISMATCH` forged-session contract preserved; registry metadata only) | rls-policies tests; http-postgres tenancy + idempotency tests (5/5) |
| AUTH-01  | Neutral 401 message (`Authentication is required`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | auth transport tests                                                |
| AUTH-02  | `SDIS_API_TOKENS` env → token directory → default session resolver; fail-closed when unset                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | auth transport tests                                                |

Residuals documented (out of scope for this pass): `db.connect()` / unscoped
queries run as the pool role (RLS-01 residual — including the deliberate
facility-directory scope-escape used for session validation); AUTH-03/AUTH-04
remain observations; facility-granular fail-closed data means an app-level
cross-FACILITY read of another facility's row now returns 404 (fail-closed, no
existence oracle) over PostgreSQL while in-memory adapters keep 403; Step 16
report-content versioning is contract-only.

---

## Billing (Step 8) — audited 2026-09-21

| ID      | Severity   | Status | Lane                  | Summary                                                                                     |
| ------- | ---------- | ------ | --------------------- | ------------------------------------------------------------------------------------------- |
| BILL-01 | MEDIUM     | FIXED  | Architecture decision | TOCTOU double-charge window — app duplicate guard without a DB unique constraint            |
| BILL-02 | LOW        | FIXED  | Fixable               | `PostgresChargeRepository.save` silently "succeeds" on a non-existent order item (0 rows)   |
| BILL-03 | LOW-MEDIUM | FIXED  | Fixable (shared)      | Unchecked path-id casts → 500 (PG) vs 404 (in-memory); body ids 422                         |
| BILL-04 | LOW        | FIXED  | Architecture decision | Keyed replay after idempotency-store expiry (24 h) returns 409, not the stored first result |
| BILL-05 | LOW        | FIXED  | Architecture decision | `findByIdempotencyKey` dead port surface (intended replay source)                           |

### BILL-01 — TOCTOU double-charge window

- **Severity:** MEDIUM (financial ledger; requires concurrent requests to manifest).
- **Reproduction (verified):** two INSERTs of the same `(order_item_id, service_id)`
  with different idempotency keys both persist → 2 rows. Schema has only
  `UNIQUE (idempotency_key)` (migration 009); the app guard in
  `billing-service.ts` `createWithAudit` (L172-177) is check-then-insert with no
  transaction or constraint. Two concurrent requests with distinct (or absent,
  `charge:<uuid>`-generated) keys both pass the empty `listByOrderItem` check.
  Evidence: `qa-billing-repro.cjs [A]` → `rows = 2`.
- **Decision required (architecture lane):** one charge per item per service is an
  app rule the schema does not enforce.
- **Fix spec:** follow-up migration adding `UNIQUE (order_item_id, service_id)`
  (23505 → existing ConflictError mapping), or an explicit multi-charge semantic
  decision that removes the app guard.
- **Regression test:** concurrent dual-create (two keys, same item+service) must
  yield exactly one row and one ConflictError.

### BILL-02 — `save()` silently persists nothing

- **Severity:** LOW (latent today — the service validates item membership first).
- **Reproduction (verified):** `save()` for a non-existent order item resolved
  _without error_, persisted 0 rows, and returned the charge object.
  `INSERT … SELECT … WHERE oi.id = $2` (billing-repository.ts L56-72) never
  checks the affected-row count. Evidence: `qa-billing-repro.cjs [B]`.
- **Fix spec:** require an affected-row result and throw `NotFoundError` on 0.
- **Regression test (PG):** `save()` with an unknown `orderItemId` throws and writes
  nothing.

### BILL-03 — unchecked path-id casts (shared across GET-by-id routes)

- **Severity:** LOW-MEDIUM (malformed input → 500 instead of 422/404; adapter
  asymmetry).
- **Reproduction (verified):** `getCharge('not-a-uuid')` → raw `DatabaseError
22P02` (→ 500 INTERNAL collapse, errors.ts L103); the in-memory adapter returns
  404 NotFoundError. `parseXxxId` in `validate.ts` (L167-172) are plain `as`
  casts; all GET-by-id routes pass raw path segments (`router.ts`,
  e.g. L291 `second as never`), while POST bodies validate via `requiredUuid`
  (422). Evidence: `qa-billing-repro.cjs [C]`.
- **Fix spec:** id-parsers UUID-validate and throw `ValidationError` (422),
  aligning path/body handling. **Not applied — shared parser, Freebuff still
  editing routes; also verify no gate test pins the current behavior first.**
- **Regression test:** malformed ids on representative GET routes (`/charges/`,
  `/reports/`, `/devices/{id}/acquisitions`) → same status across both adapters.

### BILL-04 — post-TTL keyed replay returns CONFLICT

- **Severity:** LOW (ledger stays safe — no duplicate row; wire behavior varies
  with time).
- **Reproduction (verified):** expire the store row → identical keyed replay →
  `ConflictError('already charged')` instead of 200 + stored result. Store
  `get` filters `expires_at > now()` (24 h TTL, repositories.ts L800/L812-819).
  Evidence: `qa-billing-repro.cjs [D]`.
- **Decision required (architecture lane):** document the 24 h window in
  `docs/API_CONTRACTS.md`, or serve post-expiry replays from
  `sdis.charges.idempotency_key` (never expires — see BILL-05).
- **Regression test:** expired store row + same-key replay → stored result (or
  documented 409) with no new rows.

### BILL-05 — dead `findByIdempotencyKey` port surface

- Implemented in both adapters (billing-repository.ts L105, in-memory-billing.ts
  L46), declared on the port (billing-service.ts L53), zero call sites. Design
  hint: replays were intended to be served from the ledger row itself, which
  would eliminate BILL-04's expiry window. Fold into the BILL-04 decision.

---

## Device Ingestion (Step 9) — audited 2026-09-21

| ID     | Severity   | Status | Lane                  | Summary                                                                                                                         |
| ------ | ---------- | ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| DEV-01 | MEDIUM     | FIXED  | Architecture decision | Non-atomic side-effect ordering: observations written BEFORE the acquisition row; partial-failure retry duplicates observations |
| DEV-02 | LOW-MEDIUM | FIXED  | Architecture decision | No modality coherence between device and order at the linked-ingestion boundary                                                 |
| DEV-03 | LOW        | FIXED  | Fixable               | Linked ingest with omitted `rawPayload` → raw adapter TypeError → 500 (not 422); `toObservationValue(undefined)` footgun        |

### DEV-01 — observations before the acquisition row (the acquisition is the replay unit)

- **Severity:** MEDIUM (breaks the documented retry contract: "a replay repeats
  NO side effect (no duplicate acquisition, observations, or audit events)" —
  device-ingestion-service.ts L130-132).
- **Reproduction (verified):** with `saveAcquisition` made to throw after
  observations are entered, the first call leaves **1 orphaned observation, 0
  acquisition rows**; the same-key retry (idempotency store never recorded the
  failed result) succeeds but leaves **2 observation rows** for the item and one
  acquisition row. Evidence: `qa-devices-repro.cjs [F1]`.
  Cause: `ingestOnce` (L203-221) enters observations via `enterObservation`
  BEFORE `saveAcquisition` (L225-236), with no transaction across the two.
- **Decision required (architecture lane).** Fix spec (two viable options):
  1. **Acquisition-first + replay derivation:** persist the acquisition row
     first; on a 23505 key-collision during a retry, treat it as a replay and
     regenerate observations from the stored `raw_payload` via the (deterministic)
     adapter instead of re-running `enterObservation`.
  2. **Unit-of-work transaction** spanning acquisition + observations (+ audit) —
     requires a transaction seam the current ports do not expose.
- **Regression test:** simulated partial failure (acquisition save throws) then a
  same-key retry → exactly one observation set, one acquisition row, one audit
  event.

### DEV-02 — modality coherence gap at the ingestion boundary

- **Severity:** LOW-MEDIUM (cross-modality observations can enter the clinical
  record; structural, not clinical).
- **Reproduction (verified):** a LAB device ingests observations onto an **ECG**
  order item without any rejection (1 observation row). `ingestOnce` checks
  facility scope and adapter source kind only; `enterObservation` is structural
  (scope/patient/fields) with no modality check (observation-service.ts L62-66,
  "NO clinical validation"). Evidence: `qa-devices-repro.cjs [F2]`.
- **Decision required (architecture lane):** should a linked acquisition reject
  `device.modality !== order.modality` at the boundary?
- **Fix spec (if accepted):** validate order modality against device modality in
  `ingestOnce` when `orderItemId` is supplied.
- **Regression test:** LAB device + ECG order item → 4xx, no observation rows.

### DEV-03 — omitted `rawPayload` on linked ingest → 500 TypeError

- **Severity:** LOW (malformed-input robustness; same family as BILL-03).
- **Reproduction (verified):** with the production test-adapter shape
  (`a.rawPayload.glucoseMgDl`, devices-postgres.test.ts L62), a linked ingest
  with `rawPayload: undefined` (router L258 passes
  `obj['rawPayload'] ?? undefined`) throws a raw `TypeError` — not an AppError →
  router collapses to 500 INTERNAL instead of a 4xx. Evidence:
  `qa-devices-f3.cjs`.
- **Fix spec:** the route requires `rawPayload` when `orderItemId` is present
  (422 through `requiredObject`/format validation), and/or the service rejects
  `rawPayload === undefined` for linked ingests. Additionally
  `toObservationValue` (device-ingestion-service.ts L272-282) maps a
  contract-violating `undefined` to TEXT `"undefined"` instead of rejecting —
  tighten to number | string | null only.
- **Regression test:** linked POST without `rawPayload` → 422 (not 500), on both
  adapters.

---

## Authentication Foundation (Step 10) — audited 2026-09-21

| ID      | Severity   | Status | Lane                  | Summary                                                                                               |
| ------- | ---------- | ------ | --------------------- | ----------------------------------------------------------------------------------------------------- |
| AUTH-01 | LOW        | FIXED  | Fixable               | 401 wire message claims "authentication boundary is not yet integrated" while the boundary IS shipped |
| AUTH-02 | LOW-MEDIUM | FIXED  | Architecture decision | Auth foundation has no production wiring; "external configuration / startup validation" unimplemented |
| AUTH-03 | LOW        | FIXED  | Fixable               | "Constant time" is per-comparison; directory iteration leaks configured-token lengths/order           |
| AUTH-04 | —          | FIXED  | Fixable               | 401 carries no `WWW-Authenticate: Bearer` — documented intent in SECURITY §7 (RFC 6750 best practice) |

### AUTH-01 — stale 401 wire message ("boundary is not yet integrated")

- **Severity:** LOW (message accuracy on the wire; not a security break).
- **Reproduction (verified):** with the Step-10 credential boundary wired exactly
  as `tests/transport/auth.test.ts` does (`credentialSessionResolver` over
  `constantTimeDirectory`), every 401 body reads:
  `"Authentication is required (authentication boundary is not yet integrated)"` —
  for absent, malformed, AND unknown credentials. The boundary IS integrated
  (valid token → 201, actor recorded). Evidence: `qa-auth-repro.cjs`.
  Cause: `requireResolvedSession` (session.ts L34-39) carries the pre-Step-10
  message; `serializeError` puts `error.message` on the wire (errors.ts L93-97).
- **Fix spec:** neutral message (`'Authentication is required'`) that does not
  distinguish absent vs invalid vs unknown credentials; update the regression
  assertion (no 401 body may claim the boundary "is not yet integrated").
- **Lane:** fixable, but session.ts message is shared transport surface —
  HELD while Freebuff is editing routes.

### AUTH-02 — auth foundation is test-wired only; "external configuration" has no mechanism

- **Severity:** LOW-MEDIUM (docs overpromise an operational capability; every
  real deployment still 401s with no code path to authenticate).
- **Reproduction (verified):** `credentialSessionResolver` has zero call sites
  outside `src/transport/auth.ts` and tests; `createSdisHttpServer` defaults to
  `unauthenticatedSessionResolver` (server.ts L42). The only credential source is
  the in-memory `constantTimeDirectory(credentials[])` factory — no env/file/
  secret-store loader exists anywhere in `src/` (`process.env` only drives PG
  defaults in database.ts). `docs/SECURITY.md` §6 and `docs/API_CONTRACTS.md` §9
  state "credential bindings are external configuration (docs/DEPLOYMENT.md §3)";
  DEPLOYMENT §3 additionally claims "all configuration is validated at startup
  (contract), fail-fast" — no startup configuration validation exists in code.
- **Decision required (architecture lane):** ship an operational
  `CredentialDirectory` adapter (e.g. `SDIS_API_TOKENS` env) + startup
  validation, or sharpen the docs to state the binding mechanism is the
  injection seam and requires wiring (local/testing only, as §6 already claims).

### AUTH-03 — "constant time" is per-comparison only — **FIXED (Step 32)**

- **Fix:** `constantTimeDirectory` now hashes every configured token to a
  fixed-length SHA-256 commitment and compares the presented digest against
  EVERY entry with no early exit (`src/transport/auth.ts`). Lookup work is
  uniform in the directory size and independent of any token's length or
  position; the digest is a one-way commitment, so it is not token material.
- **Regression test:** `tests/app/security-hardening.test.ts` —
  position-independence (reversed directory resolves identically) and
  unknown-token rejection at any length.

- **Reproduction (structural):** `tokenMatches` burns once then
  length-pre-checks; `constantTimeDirectory` iterates with `.find` early exit
  (auth.ts L72-89). Timing discloses each configured token's LENGTH and the
  relative position of a matching-length entry; total directory time scales with
  credential count. Fail-closed behavior stands (unknown → undefined).
- **Fix spec (if tightened later):** compare against a hash/commitment of each
  token over the full list with no early exit, or single-blob compare.
- **Lane:** SECURITY.md §6 "Token comparison is constant time" is technically
  true per comparison — add scope precision when the ledger is next edited.

### AUTH-04 — no `WWW-Authenticate` header on 401 — **FIXED (Step 32)**

- **Fix:** every 401 now carries `WWW-Authenticate: Bearer` (scheme only, no
  realm/scope detail) via `serializeError` + `src/transport/server.ts`; 403
  responses never carry the header, so authentication and authorization
  failures stay wire-distinguishable.
- **Regression test:** `tests/app/security-hardening.test.ts` proves the
  header on the REAL server (401 with challenge, 403 without) plus `nosniff`
  on both.

- Documented intent (SECURITY.md §7: "no `WWW-Authenticate` scheme is claimed");
  RFC 6750 §3 suggests `WWW-Authenticate: Bearer` for bearer 401s. Verified
  absent on the wire (`qa-auth-repro.cjs`). Observation for the architecture
  lane; no defect recorded because the docs are explicit.

---

## Data Integrity, Concurrency & Idempotency (Step 33) — fixed 2026-09-25

Foundation-completion hardening pass (Step 33). The Step-33 audit confirmed the
integrity architecture was already mature — PG `Database.transaction` with RLS
role/GUC stamping, version-CAS on order/specimen PG saves (LAB-02),
`IdempotencyStore.withExclusive` single-flight (IDEM-01), the atomic stock-floor
conditional insert, the serialized audit hash chain (AUDIT-01), and strong
unique constraints across migrations 001–023. Four genuine residuals plus one
scope residual were found and fixed; no new transaction framework, lock
service, or event system was added.

| ID      | Fix applied                                                                                                                                                                                                                                                                                                                                                                                                                | Regression proof                        |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| INT-33a | Same-key/different-payload guard: `runIdempotent` records a SHA-256 fingerprint (stable key-sorted JSON) of the LOGICAL operation as a separate `:fp` record; replay with a different payload — including a racing loser served by the store's pre-get — raises `RequestFingerprintMismatchError` (`IDEMPOTENCY_CONFLICT`). Wired into `order.create` with a logical fingerprint that excludes the regenerated `orderedAt` | `tests/app/integrity-hardening.test.ts` |
| INT-33b | In-memory order/specimen `save()` now enforce version CAS (LAB-02 parity with PG): a stale version throws `ConflictError` instead of silently overwriting; insert stores the caller's version, update advances it                                                                                                                                                                                                          | `tests/app/integrity-hardening.test.ts` |
| INT-33c | PG order/specimen saves map SQLSTATE 23505 (exported `isUniqueViolation`) to `ConflictError` — constraint races surface as 409 CONFLICT, never 500 INTERNAL                                                                                                                                                                                                                                                                | `tests/app/integrity-hardening.test.ts` |
| INT-33d | In-memory `applyDepletingMovement` race closed: movement snapshot, stock-floor check, and append run synchronously with no interleaving `await` — two concurrent consumers can no longer both pass the check against the same stale balance (overdraw window)                                                                                                                                                              | `tests/app/integrity-hardening.test.ts` |
| INT-33e | IDEM-SCOPE-RESIDUAL: `SetupConfigService.updateConfig` — the one remaining `runIdempotent` call site (of 26) missing the `session` argument — now passes it, so SETUP_CONFIG_UPDATE replays are facility-scoped like every other scope                                                                                                                                                                                     | `tests/app/integrity-hardening.test.ts` |

### INT-33a — idempotency keys were replay-safe but not payload-safe — **FIXED (Step 33)**

- **Severity:** MEDIUM (a retried request that reused a key with a DIFFERENT
  logical payload was silently served the first request's stored result).
- **Fix:** `requestFingerprintOf` hashes the stable (key-sorted) JSON of the
  logical operation; the fingerprint is stored under a derived `<key>:fp`
  record (plain hex digest — no request payload is persisted) and asserted
  both before `withExclusive` (settled replays) and after it returns (a racing
  loser served by the store's internal pre-get never re-runs the callback).
  Mismatch → `RequestFingerprintMismatchError`, HTTP 409 `IDEMPOTENCY_CONFLICT`.
  The fingerprint covers the LOGICAL operation, not the raw wire payload: the
  Step-18 recovery drill legitimately regenerates `orderedAt`, so `order.create`
  fingerprints `{patientId, encounterId, modality, priority, items, source}` —
  the drill still passes 6/6.
- **Regression:** `tests/app/integrity-hardening.test.ts` — different-payload
  rejection (error type + stable code), regenerated-timestamp replay succeeds,
  the fingerprint record is a hex digest containing no payload fragment and is
  deterministic, concurrent same-key same-payload → one create/same id,
  concurrent same-key different-payload → exactly one fulfilled + one
  `RequestFingerprintMismatchError`.

### INT-33b / INT-33c — in-memory CAS parity + 23505 mapping — **FIXED (Step 33)**

- **Severity:** LOW-MEDIUM (adapter asymmetry: PG rejects stale order/specimen
  writes (LAB-02) while the in-memory adapters accepted them; and a PG
  constraint race on an order/specimen save collapsed to 500 INTERNAL).
- **Fix (INT-33b):** `InMemoryOrderRepository.save` and
  `InMemorySpecimenRepository.save` throw `ConflictError` ("modified
  concurrently … re-read and retry") when the stored aggregate's version
  differs from the incoming one; inserts store the caller's version, updates
  advance it.
- **Fix (INT-33c):** the order/specimen PG save catch blocks map
  `isUniqueViolation` (SQLSTATE 23505) to `ConflictError`, so a lost
  constraint race (e.g. accession uniqueness) is a 409 on the wire.
- **Regression:** CAS tests advance an order and a specimen to v2, prove a
  stale v1 write conflicts and a current v2 write succeeds (→ v3) on the
  in-memory adapters (same semantics as `lab02-concurrency` on PG).

### INT-33d — in-memory stock depletion interleave window — **FIXED (Step 33)**

- **Severity:** LOW-MEDIUM (in-memory adapter only; the PG path was already
  atomic via a conditional INSERT, so the ledger could not overdraw there).
- **Reproduction (structural):** `applyDepletingMovement` awaited
  `listMovementsByBatch(...)` before the balance check; two interleaved
  consumers of the same batch could both pass the stock-floor check against
  the same snapshot and both append a movement — negative balance.
- **Fix:** a synchronous `listMovementsByBatchSync()` snapshot, the floor
  check, and the append now run with no `await` between them.
- **Regression:** 10 units in stock, two concurrent 7-unit consumers → exactly
  one fulfilled, one `ValidationError`, balance 3, never negative.

### INT-33e — setup-config replay scope residual — **FIXED (Step 33)**

- **Severity:** LOW (last unscoped call site; the Step-32 sweep had converted
  25 of 26).
- **Fix:** `SetupConfigService.updateConfig` passes `session` to
  `runIdempotent`, so `SETUP_CONFIG_UPDATE` records are facility-scoped like
  every other idempotent scope (facility A replaying facility B's key can no
  longer read or plant a memoized result).
- **Regression:** the same update key under facilities A and B updates each
  facility's own record — different ids, each facility's value applied once.

---

## Terminology Persistence (Step 7) — audited 2026-09-21

| ID      | Severity | Status | Lane    | Summary                                                                                                                |
| ------- | -------- | ------ | ------- | ---------------------------------------------------------------------------------------------------------------------- |
| TERM-01 | LOW      | FIXED  | Fixable | `getMapping` 404s GLOBAL mappings (`facility_id IS NULL`) that `resolveMappings` returns — inconsistent read semantics |
| TERM-02 | LOW      | FIXED  | Fixable | HTTP silently drops `"global": true` — the service's scope-escalation guard (422) is unreachable over the wire         |
| TERM-03 | LOW      | FIXED  | Fixable | `GET /terminology/mappings/{id}` uses `third as never` — malformed id → PG 22P02 → 500 (in-memory adapter → 404)       |

### TERM-01 — global mappings are unreadable by id but visible via resolve

- **Severity:** LOW (latent: global rows cannot be created over HTTP, only via
  SQL/ops seeding — which the migration comment explicitly supports).
- **Reproduction (verified):** seeded a global mapping
  (`facility_id NULL`, HBA1C→loinc) via SQL on disposable PG, then from ONE
  facility session: `resolveMappings` returns it (`[TERM-01a] includes global:
true`) while `getMapping(same id)` throws `NotFoundError` (`[TERM-01b]`) —
  `terminology-service.ts` getMapping L214: `mapping.facilityId !==
session.facilityId` treats `undefined` (global) as out-of-scope, while
  resolveMappings L242 explicitly keeps global rows (`facilityId ===
undefined`).
- **Fix spec:** `if (!mapping || (mapping.facilityId !== undefined &&
mapping.facilityId !== session.facilityId))` — align `getMapping` with the
  resolve filter; add a regression test seeding a global mapping and reading it
  back by id (both adapters).

### TERM-02 — `"global": true` silently dropped at the router

- **Severity:** LOW (contract inconsistency; not exploitable — mapping lands at
  the session facility, DTO exposes the real `facilityId`).
- **Reproduction (verified):** over HTTP, POST `/api/v1/terminology/mappings`
  with `{"global": true, ...}` returns `201` with `facilityId` = session
  facility — the flag is never forwarded (router.ts L207-212 forwards only
  canonicalCode/externalSystem/externalCode/validated/idempotencyKey), so the
  service's documented scope-escalation guard (terminology-service.ts L147-154,
  `global: true → ValidationError`) is unreachable over HTTP. Evidence:
  `qa-terminology-rls.cjs`.
- **Fix spec:** forward `global` to the service and let the guard 422, or
  explicitly 422 unknown/unsupported fields — pick one; regression test POST
  `global:true` → 422 (not silent 201).

### TERM-03 — malformed mapping id: PG 22P02 → 500 (in-memory → 404)

- **Severity:** LOW. Same shared-cast family as BILL-03 (router `third as
never`); adapter-divergent status for identical input.
- **Reproduction (verified):** `service.getMapping(session, 'not-a-uuid')` over
  PG throws raw pg `DatabaseError code=22P02 "invalid input syntax for type
uuid"` (not an AppError → would serialize to `500 INTERNAL`); the in-memory
  adapter returns `undefined` → 404 for the same id. No transport validation on
  the mapping-id path segment (router.ts L222). Evidence:
  `qa-terminology-rls.cjs`.
- **Fix spec:** shared parse/validate for the mapping-id segment (422
  `VALIDATION_FAILED` for malformed, matching in-memory 404-vs-422 contract);
  regression: malformed mapping id over PG-backed HTTP → 422, both adapters
  agree; fold into the BILL-03 path-cast fix when that lands.

---

## Row-Level Security enforcement (cross-cutting, migrations 006/008/009/010) — audited 2026-09-21

| ID     | Severity | Status | Lane                  | Summary                                                                                                                              |
| ------ | -------- | ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| RLS-01 | HIGH     | FIXED  | Architecture decision | Database-level tenant isolation is INERT in every shipped configuration: tests bypass, runtime never sets GUCs, policy OR fails open |

### RLS-01 — RLS is never enforced: tests bypass, runtime never wires the tenant GUC, policies fail open

- **Severity:** HIGH — the repository's documented multi-tenancy guarantee
  ("RLS remains the database-level guarantee", terminology-repository.ts L8;
  SECURITY.md/DATABASE.md RLS claims) provides **zero database-level isolation
  in any current configuration**. API-layer filters still hold today (isolated,
  verified at the service level), so this is a defense-in-depth/integrity gap —
  but a future adapter, ops query, or any path around the service filter has no
  DB backstop.
- **Reproduction (verified, disposable PG 55451):**
  - `[1]` The pool used by EVERY PG suite and the shipped `getDatabase()`
    default connects as `postgres` (superuser) → **RLS bypassed**; all rows
    visible (test-db.ts L74-83; all suite isolation behavior runs this way).
  - `[2]` `SET ROLE sdis_app` with **no tenant GUC** (the documented app role;
    the runtime never sets GUCs) → sees all 3/3 rows including **cross-tenant**
    (Org B) rows — **fail-open read**.
  - `[3]` Same session can **INSERT** a row for another org's facility —
    **fail-open write**.
  - `[4]` Only `sdis_app` + GUCs set (a configuration nothing in the app or
    tests exercises) segregates correctly (own-facility + global rows only).
  - Evidence: `qa-rls-failopen.cjs`, `qa-rls-diag.cjs`, `qa-terminology-rls.cjs`.
- **Root causes (three independent gaps):**
  1. **No GUC wiring:** `Database.withTenantContext` (database.ts L74-91 —
     `SET LOCAL sdis.organization_id/facility_id/user_id`) has **zero call
     sites**; dead since creation. Request lifecycle never sets the tenant.
  2. **Permissive-policy OR:** `pol_terminology_tenant` and
     `pol_terminology_facility` are BOTH permissive → combined with OR. With
     `sdis.facility_id` unset, the facility policy's `current_facility_id() IS
NULL` branch is vacuously true and re-opens every row the tenant policy
     denies (same shape across 008/009/010; 006's facility policies share the
     vacuous branch). RLS fails OPEN when the caller omits the GUC — there is
     no fail-closed posture at the DB.
  3. **Nothing exercises enforcement:** all PG suites run as superuser
     (bypass); `tests/infrastructure/rls-policies.test.ts` asserts only
     `pg_policy` metadata existence with the self-admitted comment "This test
     would need to run as sdis_app role with GUCs set" — the suite's header
     claims "proves isolation" but no isolation behavior is ever executed.
- **Decision required (architecture lane):** (a) wire the tenant context into
  the request/query lifecycle (compose `withTenantContext` at the session →
  transaction boundary, or pool-level GUC per tenant); (b) make isolation
  fail-closed (fold the tenant predicate into the facility policy, or use one
  RESTRICTIVE policy for the tenant boundary); (c) add integration tests that
  connect as `sdis_app` with GUCs AND negative tests asserting no-GUC sessions
  see zero rows / are denied inserts. Until then, treat every "enforced at the
  database level" claim as aspirational.

---

## Laboratory Core Flow + Idempotency/Audit Infrastructure (Steps 1–6) — audited 2026-09-21

| ID       | Severity   | Status | Lane                  | Summary                                                                                                                                           |
| -------- | ---------- | ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| LAB-01   | MEDIUM     | FIXED  | Fixable               | `finalizeReport`/`amendReport` carry NO idempotency key — retried finalize hard-409s; retried amend duplicates a superseding version              |
| LAB-02   | LOW-MEDIUM | FIXED  | Architecture decision | Order/specimen transitions are lost-update-prone — PG saves overwrite status unconditionally (no CAS, version never checked)                      |
| IDEM-01  | MEDIUM     | FIXED  | Architecture decision | Idempotency unit is not atomic with side effects — write-once put silently drops the losing result; cross-process same-key creates duplicate rows |
| AUDIT-01 | MEDIUM     | FIXED  | Architecture decision | Audit hash chain forks under concurrent inserts → `verify_audit_chain` reports FALSE on legitimate data; healthy chains return zero rows          |

### LAB-01 — report finalize/amend have no retry-safe (idempotent) path

- **Severity:** MEDIUM (report version history is the clinical communication
  artifact; a retried amendment creates a duplicate superseding version that no
  client can distinguish from an intentional one).
- **Reproduction (verified, disposable PG 55454, PG runtime):**
  - `createReport` with a key: replay returns the **same** report id
    (`[CREATE] replay with same key -> same report id=true`) — the platform
    convention works for create.
  - `finalizeReport(session, id, ...)` twice: first call → head `v1
FINALIZED`; the retry throws `ConflictError("Report is already finalized —
no silent overwrite")` instead of returning the already-finalized report —
    a timed-out client retry (no key exists to dedupe on) gets a 409 even though
    the operation SUCCEEDED.
  - `amendReport` twice with identical content: head is `v2` then a duplicate
    `v3` with the same content (`[AMEND] call#1 -> 2 versions | call#2 (retry)
-> 3 versions`, `distinct version ids=3`, `distinct contents=2`). Cause:
    `AmendedReportInput` (report-service.ts L51-57) has no `idempotencyKey`;
    `amendReport` L165-197 always mints a fresh `newVersionId` and saves
    version+1. `FinalizeReportInput` likewise (L134-159, positional args).
  - Evidence: `qa-lab-retry-safety.cjs`.
- **Fix spec:** add `idempotencyKey?` to amend (scope `report.amend`, new scope
  constant; replay returns the stored amended report without a new version) and
  to finalize (scope `report.finalize`; replay returns the finalized report
  instead of 409). Wire both through the router's existing
  `idempotencyKeyOf` header/body plumbing.
- **Regression test:** (a) amend retry with the same key → **one** new version,
  one audit event; (b) finalize retry with the same key → 200 + finalized report,
  no new audit event, no error.

### LAB-02 — order/specimen transitions are lost-update-prone (no CAS, unconditional status overwrite)

- **Severity:** LOW-MEDIUM (requires two concurrent transition writers; when it
  fires, a stale snapshot can REGRESS the order status — e.g. PROCESSING is
  overwritten back to ACQUIRED, or a REPORTED order regresses — because the
  domain state machine is validated against a per-call read snapshot).
- **Reproduction (structural, verified on the SQL):** `PostgresOrderRepository.save`
  (repositories.ts L410-457) upserts with
  `ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status` — no `WHERE status =`
  guard and no compare on the pre-save status; `version` is incremented but
  **never read for optimistic locking** (`order.items.length > 0 ? 1 : 1` —
  "version handling simplified", L433). `PostgresSpecimenRepository.save`
  (L510-534) is the same unconditional pattern. Two concurrent
  `transitionOrder`/`transitionSpecimen` calls that both read `ORDERED` both
  validate against their stale snapshot, and both succeed; the last write wins.
  Evidence: SQL + domain transition table (`src/domain/ordering/diagnostic-order.ts`,
  `src/domain/specimen/specimen.ts`) + L410-457/L510-534.
- **Decision required (architecture lane):** add optimistic concurrency — save
  with `WHERE version = $prev` (or a CAS on `(status, value in transition)`),
  surfacing `ConflictError` on staleness — and/or serialize per-resource
  transitions. The in-memory adapter shares the read-modify-write shape.
- **Regression test:** two interleaved transitions from the same starting state
  → exactly one applies; status is monotonic (never regresses); loser gets
  CONFLICT, never a silent overwrite.

### IDEM-01 — idempotency write is not atomic with its side effects (orphaned duplicates)

- **Severity:** MEDIUM (cross-cutting: all nine keyed scopes —
  order/specimen/observation/interpretation/report/patient/terminology/charge/
  device. Within ONE process the race window is narrow and empirically masked;
  across PROCESSES sharing the PG idempotency store it is a guaranteed
  duplicate.)
- **Reproduction (verified, disposable PG):**
  - Store-level: `put(k, {n:1})` then `put(k, {n:2})` → the store still holds
    `{n:1}` — the second put is silently DROPPED (`[STORE] ... DROPPED (holds
1)`). The write-once conditional
    (`ON CONFLICT (key) DO UPDATE ... WHERE expires_at <= now()`,
    repositories.ts L807-820) makes losing an identical `create` walk invisible.
  - Service shape: `runIdempotent` is `get → create() (multiple independent DB
writes: domain row + audit event) → put()` (idempotency.ts L40-53,
    patient-service.ts L172-216) — no transaction spans the writes and the put,
    no advisory lock, no in-process single-flight map. Two concurrent same-key
    requests across instances both `get undefined`, both persist their domain
    rows; one `put` lands, the loser's row is ORPHANED (its owner received an
    id that replay will never return), and the losing put is dropped.
  - In-process control: `Promise.all` same-key patient registrations on ONE
    runtime resolved to a single patient row (qa-idem-race.cjs) — the window is
    timing-dependent in one process, which is precisely why this must be closed
    at the store/atomicity layer, not by hoping the interleave never fires.
  - Evidence: `qa-idem-concurrent.cjs`, `qa-idem-race.cjs`.
- **Same family as:** DEV-01 (non-atomic side-effect ordering) and BILL-01
  (check-then-act without a constraint). This entry generalizes them to the
  store contract: the idempotency KEY record must commit atomically with the
  side effects that it names.
- **Decision required (architecture lane):** (a) persist the key row in the same
  transaction as the domain write (natural on PG: INSERT … ON CONFLICT within
  the same unit), exposing a transaction seam per scope; and/or (b) a
  per-key advisory lock (`pg_advisory_xact_lock`) around get→create→put.
- **Regression test:** two processes (or two pool clients) racing the same key
  → exactly one domain row, one audit event, one idempotency row; both callers
  receive the same result.

### AUDIT-01 — audit hash chain forks under concurrent inserts; verify is ambiguous

- **Severity:** MEDIUM (the chain is the platform's tamper-evidence feature; in
  normal concurrent operation `verify_audit_chain` reports FALSE on entirely
  legitimate events — false alarms that drown out real tamper signals).
- **Reproduction (verified, disposable PG 55452, migration 005):**
  - Append-only triggers work: UPDATE and DELETE on `sdis.audit_events` both
    raise `"Audit events are append-only"` for every role including superuser.
  - The trigger computes `previous_hash` from the last committed event per
    org/facility (`ORDER BY at DESC LIMIT 1`, 005 L100-105). Two transactions
    that insert BEFORE either commits both read the SAME head (each sees only
    committed rows) → both chain off it → **fork**.
  - Proof: empty chain — tx1 inserts event A (`previous_hash NULL`), tx2 inserts
    event B (`previous_hash NULL`, A invisible) — after both commit,
    `verify_audit_chain` returns **2 mismatch rows** on legitimate data
    (`[FORK] mismatches reported on legitimate data: 2`).
  - Secondary: a HEALTHY non-empty chain returns **zero rows** — identical to an
    EMPTY chain (the final `RETURN QUERY ... WHERE NOT EXISTS` only fires when
    no data matches). A caller cannot distinguish "verified" from "no events".
  - Evidence: `qa-audit-chain.cjs`.
- **Decision required (architecture lane):** serialize per-chain head selection
  (e.g. `pg_advisory_xact_lock(org_facility_key)` at trigger start, or a
  per-chain sequence/head table updated under lock); make the ordering
  deterministic (`ORDER BY at DESC, id DESC` is not enough — the lock is the
  fix); and change verification to return an explicit healthy marker (e.g. a
  single `(NULL, NULL, NULL, TRUE)` row for every healthy chain, not only empty
  ones).
- **Same family as:** RLS-01 messaging — DB-level guarantees exist but are not
  exercised under realistic concurrency; the integration tests must insert
  events concurrently and assert the chain verifies.
- **Closed:** migration 016 implements the advisory xact lock, switches head
  selection to the APPEND-ORDER head (the chain's unreferenced event) so
  same-`at`/out-of-`at`-order commits cannot fork, and rewrites verification to
  walk the stored `previous_hash` pointers from each root (at-independent) with
  an orphan check and exactly one explicit TRUE marker when healthy. Regression:
  `audit-persistence.test.ts` — a marker test on an owned FAC_A2 chain and a
  12-way three-writer concurrent-insert test asserting one root, no shared
  predecessor, no orphans, and a healthy end-to-end `verify_audit_chain`.

---

## Observations (not defects)

- **Billing:** no creation API for `billable_services` (read-only catalog,
  ops-seeded SQL by design per migration 009 "no pricing policy engine").
- **Devices:** `device_acquisitions` are write-only via API (single POST route;
  no GET) — raw payloads stay opaque; observations are the readable
  interpretation. Consistent with the "ingestion boundary" design, but worth
  confirming the ops/audit needs a read path later.
- **Patient identity (Step 6, audited — no defect):** duplicate-reference
  rejection is DB-backed — `UNIQUE (system, value, facility_id)` on
  `patient_external_identifiers` (002_clinical_schema.sql L32), with 23505 →
  `ConflictError` mapping in the PG repo (repositories.ts L278-281, L299-302);
  the app probe is scope-fixed to the session facility, and the CONFLICT
  envelope surfaces over HTTP. Identity values are intentionally NOT normalized
  (no fuzzy/case-fold merge — documented CLINICAL_SAFETY posture).
- **Transport (audited — solid):** 405/415/400/413/404 ordering sound; session
  resolution precedes routing so unknown paths 404 without route-surface
  leakage; correlation IDs sanitized (bounded printable-ASCII token or fresh
  UUID, transport/context.ts L15-28) — no header injection; error bodies are
  serialized exclusively through the public mapping.
- **Secrets sweep (audited — honest):** `secrets-sweep.test.ts` walks the actual
  repository (excluding node_modules/.git/dist/coverage), scans real file
  contents for key/token patterns, and asserts zero hits — a genuine scan.
- **RBAC in-flight (not audited as a phase):** Freebuff is wiring
  `authz/rbac.ts` (fail-closed, roles `viewer/operator/manager`, permission
  surface over existing routes) into the PG runtime and services (~07:34–07:41
  - dist rebuild 07:49). Its claims (enforcement order, no route gaps) and the
    AUTH-02 "no production wiring" gap are re-audited when the phase lands
    (postgres-runtime.ts now resolves credentials/roles).

---

## Evidence scripts (uncommitted, temp)

- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-billing-repro.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-devices-repro.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-devices-f3.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-auth-repro.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-terminology-rls.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-rls-diag.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-rls-failopen.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-audit-chain.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-idem-concurrent.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-idem-race.cjs`
- `C:\Users\dipso\AppData\Local\Temp\opencode\qa-lab-retry-safety.cjs`

Key assertion outputs are quoted inline in each entry above.

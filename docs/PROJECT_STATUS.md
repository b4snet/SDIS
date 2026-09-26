# SDIS Project Status

Updated: **Step 35 — Foundation Completion Gate: FOUNDATION COMPLETE,
independently re-audited and remediated.**
Steps 1–34 audited as one integrated system (821/821 tests, 0 fail, 0
vulnerabilities; no code blocker found; two documentation drifts fixed).
Decision, 35-area status matrix, remaining debt, and the honest boundary of
the claim: **docs/FOUNDATION_GATE.md**. An independent re-audit
(**docs/SDIS_FULL_AUDIT_STEPS_1_35.md**) found one HIGH and six MEDIUM
findings; all were remediated with regression tests
(**docs/SDIS_STEPS_1_35_REMEDIATION_REPORT.md**, final gate **894/894 tests,
233 suites, 0 fail** across 31 migrations, 27 permissions).
Foundation "complete" means a tested, coherent base — NOT production-ready
(see PRODUCTION_READINESS.md).

Prior: end of Step 34 (observability, backup/recovery & operational readiness: process lifecycle — fail-fast startup validation + bounded graceful shutdown, readiness/pool-failure metrics + `GET /metrics`, backup atomic finalize + readability gate, operator CLI (`backup`/`verify-restore`/`ops-check`), §39 smoke chain over real HTTP+PostgreSQL, runbooks + readiness checklist + RPO/RTO/DR boundaries in docs/OPERATIONS.md). Prior: Step 33 (data integrity, concurrency, idempotency & transaction hardening: same-key/different-payload fingerprint guard on idempotent replays — `IDEMPOTENCY_CONFLICT` 409, in-memory version-CAS parity for orders/specimens, SQLSTATE 23505 → ConflictError mapping on PG constraint races, race-free in-memory stock depletion, facility-scoped setup-config replays; canonical integrity model in docs/DATA_INTEGRITY.md). Prior: Step 32 (security/authorization/tenancy hardening: facility-
scoped idempotency, WWW-Authenticate challenges, timing-uniform credential
lookup, nosniff; canonical RBAC matrix in docs/RBAC.md). Prior: Step 31
inventory/reagent/consumable lifecycle completion; earlier: Step 29 result
governance + diagnostic worklists;
Step 23 document foundation - ACTIVE/RETIRED lifecycle without physical
deletion, real content-integrity verification, explicit patient visibility
with patient document access through the Step-22 ownership gate). Step 22
remains the latest patient-access state:
foundation - PATIENT principal with ownership binding, finalized-report-only
patient views, patient-safe DTO, audited access events). Step 21 remains the
latest workflow state:
foundation — bounded ROUTINE/URGENT/EMERGENCY order priority, deterministic
worklist ordering, audited idempotent priority changes, emergency ≠ critical
result boundary). Step 20 remains the latest integration state:
foundation — external-system registry with fail-closed gateway enforcement,
append-only order external-reference correlation with outbound ORDER_EXISTS
resolution, INBOUND_RESULT canonical observation boundary, integration.manage
RBAC — layered over the Step-19 notifications foundation and the existing
laboratory/registration/terminology/billing/device/documents/inventory/
observability/recovery/PostgreSQL/HTTP/RBAC architecture).

## Validation status legend

- **Contract** — types/interfaces define the boundary; behavior verified by tests.
- **Architecture-ready** — designed and documented; not implemented.
- **Deferred** — reserved; not started.
- **Implemented** — behaviorally present in this repository.

## Module matrix

| Module                                          | Step-2 status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity & Access                               | Contract (RBAC types; enforcement deferred)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Organization / Facility / Department            | Contract + tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Patient & Registration                          | **Implemented** (registration/intake application service + HTTP + PostgreSQL; existing single identity contract preserved)                                                                                                                                                                                                                                                                                                                                                                        |
| Investigation / Diagnostic Orders               | **Implemented** (in-process order service + lifecycle)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Laboratory                                      | **Implemented** (order→specimen→accession→result→verification→finalization→report; Step-28 governance: manager-tier attributed verification, verification gate on finalization, reason-bound amendments with append-only lineage; Step-29 typed worklist views with keyset pagination over authoritative state; specimen rejection reasons, globally-unique accession numbers, QC hold boundary; no analyzer connection)                                                                          |     |
| Specimen Management                             | **Implemented** (collection + lifecycle service)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Results (Observation / Interpretation / Report) | **Implemented** (entry services + report versioning)                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Reports                                         | **Implemented** (draft/finalize/amend; no artifact rendering)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Billing                                         | **Implemented (diagnostic charge slice)** (Charge application service + HTTP + PostgreSQL over the existing domain contract; invoices/payments remain contract-only)                                                                                                                                                                                                                                                                                                                              |     | Documents | **Implemented (foundation slice)** (document metadata + storage boundary + resource links + HTTP + PostgreSQL; no OCR/document AI/PACS/DICOM, no standards conformance claimed) |
| Emergency                                       | Deferred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Laboratory Medical Inventory                    | **Implemented (Step 31 lifecycle completion)** (items + active lifecycle, lot lifecycle AVAILABLE/QUARANTINED/RELEASED/RETIRED, append-only movement ledger with required reason + operationRef traceability, derived balance, derived three-state expiry, bounded expiring query, read-only FEFO selection, atomic negative-stock protection, keyed idempotency, HTTP + PostgreSQL/RLS; no procurement/accounting/supplier management/reservations)                                              |
| Analytics                                       | Contract boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| HMIS Reports                                    | Contract boundary (report categories)                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Daily Reports                                   | Contract boundary (first-class reporting domain)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Master Setup                                    | **Implemented (FACILITY + DEPARTMENT families + department master data)** (scoped, versioned configuration with append-only history, bounded key registry with typed validation + deterministic defaults, config-driven worklist paging/history, department lifecycle administration over the canonical table, HTTP, PostgreSQL/RLS; clinical/financial/admin families deliberately not implemented)                                                                                              |
| Terminology                                     | **Implemented (persistence)** (mapping store: application service + HTTP + PostgreSQL; internal↔external code mapping with facility overrides)                                                                                                                                                                                                                                                                                                                                                    |
| Devices & Diagnostic Equipment                  | Contract + tests (registry/adapter; no hardware)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Interoperability (FHIR/HL7/DICOM/IHE)           | Deferred (boundaries documented; **no conformance claimed**)                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Audit & Provenance                              | Contract + tests (append-only; service-emitted events)                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Quality Management                              | Contract boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Notifications                                   | **Implemented (Step 19 durable delivery foundation)** (schema-versioned event model, per-channel delivery intents with an explicit 7-state delivery machine, append-only attempt ledger, PostgreSQL outbox + dispatcher with bounded deterministic retries, DB-layer idempotency (event/queueing/worker keys), facility/tenant RLS fail-closed, audited lifecycle, `items`+`nextCursor` HTTP read model + manager-tier retry/cancel; IN_MEMORY channel real, EMAIL/SMS/WEBHOOK adapters deferred) |
| Integration Gateway                             | **Implemented (boundary foundation + Step-20 interoperability)** (adapter port + canonical commands + gateway over existing services; `INTEGRATION` provenance; IMPORTED/EXPORTED audit; external-system registry fail-closed; persisted order external references with ORDER_EXISTS correlation; INBOUND_RESULT → canonical observation; one reference synthetic adapter; ZERO systems registered by default)                                                                                    |
| Application runtime (`src/app/`)                | **Implemented** (services, DTOs, ports, in-memory + PostgreSQL wiring)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| HTTP/API transport (`src/transport/`)           | **Implemented locally** (node:http routes over /api/v1; contract-tested incl. disposable PostgreSQL; fail-closed deferred authentication; not deployed)                                                                                                                                                                                                                                                                                                                                           |
| PostgreSQL persistence / RLS                    | **Implemented locally** (repositories, runtime wiring, migrations, RLS)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Authentication                                  | **Implemented (credential foundation, local)** (bearer credentials behind the SessionResolver seam; fail-closed; scope from principal binding; no RBAC/OAuth/sessions)                                                                                                                                                                                                                                                                                                                            |
| Authorization (RBAC)                            | **Implemented (foundation)** (27 permissions, 4 capability-tier roles, fail-closed `AuthorizationService` wired into every capability service + PG runtime; clinical acts use dedicated manager-tier permissions (`order.verify`, `report.amend`, `quality.manage`) and `terminology.manage`; scope independent of role; no persistence)                                                                                                                                                          |
| Observability                                   | **Implemented (operational foundation)** (structured JSON logs with allowlist redaction, bounded metrics, `/healthz` + `/readyz` with PostgreSQL readiness probe; opt-in at composition; no exporter/tracing)                                                                                                                                                                                                                                                                                     |

## Verification results (Step 17, this machine)

Recorded after the full gate run (`npm run verify`):

- Build: **pass** (tsc, strict mode, no errors)
- Type check: **pass** (tsc --noEmit)
- Lint: **pass** — eslint 0 errors / 0 warnings (max-warnings 0)
- Format: **pass** — prettier --check (src, tests, docs)
- Tests: **527 pass / 0 fail / 0 cancelled** (122 suites, node --test)
- New Step-17 tests: 36 — integration boundary over the existing services
  (external reference resolution/registration/attachment, inbound order
  submission through the existing lifecycle, order status, outbound report
  bundle keeping Observation → Interpretation → Report distinct, INTEGRATION
  provenance never collapsed into HUMAN/SYSTEM, adapter refusing non-integration
  provenance, unregistered system fail-closed, keyed replay with no duplicate
  resource or audit event, scope/RBAC enforcement), HTTP contract (200/201/403/
  422/401/404, no internal leakage), and disposable PostgreSQL (reference rows,
  order + items, audit provenance columns, EXPORTED audit, isolation).
- `npm audit`: **0 vulnerabilities** · `git diff --check`: clean · secret sweep: clean
- New Step-15 tests: 33 — scoped/versioned configuration records (supported-family
  allowlist, secret-bearing key refusal, value bounds, department reference
  validation, append-only history, stale-version guard, RBAC manager tier,
  idempotent replay, audit without values), HTTP contract (201/200/409/422/401/
  403/404, no internal leakage), and disposable PostgreSQL (migration 013 from an
  empty database, RLS + append-only grants, version history preserved,
  scope-unique constraint, department reference against the owning facility,
  facility isolation, durable idempotency replay).
- New Step-14 tests: 34 — inventory item/lot registration, append-only movement
  ledger with derived balance, expiry status as operational information.
- New Step-13 tests: 30 — document metadata, storage port, resource links.
- Prior baselines preserved: all Step-1..12 tests still passing.

## Earlier verification results (Step 12, this machine)

- Tests at the time: **394 pass / 0 fail / 0 cancelled** (89 suites)
- New Step-12 tests: 32 — logging (safe-shape, allowlist redaction incl.
  credential/PHI keys, level filtering, null logger), metrics (status-class
  vocabulary, method/class series, duration buckets, bounded operation
  vocabulary, dependency failures, null registry), health (liveness
  process-local, readiness ok/throwing/hung-probe/timeout, no error leakage),
  HTTP (health endpoints outside /api/v1 and session-free, correlation ID
  preserved/minted, one structured access-log line per request with no body
  content, error-code logging without stacks/credentials, metrics series over
  real requests, 401/403/201 semantics unchanged, no banned tokens in health
  bodies), and disposable PostgreSQL (readiness ok through the existing pool,
  unavailable against a dead endpoint with zero leakage, repeated probes
  without connection churn).
- Prior baselines preserved: all Step-1..11 tests still passing (RBAC
  Step-11 residue closed first: disposable-PG test sessions now declare role
  claims, matching production credential bindings; 31 runtime tests restored,
  then verified green before Step-12 work began).

## Verification results (Step 10, this machine)

Recorded after the full gate run (`npm run verify`):

- Build: **pass** (tsc, strict mode, no errors)
- Type check: **pass** (tsc --noEmit)
- Lint: **pass** — eslint 0 errors / 0 warnings (max-warnings 0)
- Format: **pass** — prettier --check (src, tests, docs)
- Tests: **347 pass / 0 fail / 0 cancelled** (79 suites, node --test)
- Step-9 baseline preserved: all 333 prior tests still passing
- New Step-10 tests: 14 — bearer-token extraction (well-formed, absent,
  malformed, wrong scheme, control chars, absurd length), credential →
  `ApplicationSession` resolution, unknown-credential fail-closed resolution,
  constant-time matching (including the length-mismatch burn path), shipped
  unauthenticated resolver regression, scope-from-binding-not-request
  separation, and HTTP integration (401 without credentials, 401 malformed,
  401 unknown, 201 with valid credentials and the principal recorded as the
  actor, 403 for an authenticated principal whose bound scope differs, and no
  credential/auth-internals leakage in error bodies)
  at the recorded price, item/order mismatch rejection, unknown service,
  duplicate CONFLICT, fail-closed auth, forged tenant, cross-facility denial,
  scoped retrieval, order-linked listing, audit emission, keyed replay without
  duplicate audit or rows), 9 disposable-PostgreSQL proofs (migration 009 from
  empty DB with RLS policies, persistence with real order linkage, schema-level
  idempotency-key uniqueness 23505, duplicate CONFLICT, facility/tenant
  boundaries, audit persistence, durable replay, unknown service), and 10 HTTP
  contract tests (201+DTO shape, 401, 403 forged tenant, 403 cross-facility,
  409 duplicate, 422, 404 stable code, order charge list, idempotent replay,
  leakage)
- Security sweep test: **pass** (repository secret sweep)
- npm audit: **0 vulnerabilities**
- `git diff --check`: **clean**

Repair note (Step 4 start, superseded): the Step-3 baseline was measured at
158/159 — the architecture dependency-direction test failed because
`src/app/laboratory/postgres-runtime.ts` imported infrastructure from the
application layer. The composition root was relocated to
`src/infrastructure/runtime/postgres-runtime.ts` (no rule weakened, no behavior
changed) and the Step-3 baseline was restored to 159/159 before transport work
began. Three docs files carried pre-existing prettier drift and were formatted.

Backup/restore and migration replay were previously proven with disposable
PostgreSQL and remain regression-covered; no production or staging database was
used.

Step 18 hardened this into an operational capability: `createBackup` /
`restoreBackup` / `verifyRecovery` in
`src/infrastructure/database/backup-restore.ts`, proven end-to-end by
`tests/infrastructure/recovery.test.ts` (backup → restore into a destroyed
database → verify schema/constraints/RLS/migrations/audit-chain/tenancy/
idempotency → application reuse with idempotent replay and finalized-report
immutability → explicit failure handling and tamper detection). Isolated
restore targets only; protected databases require an explicit confirmation
token. This remains a locally verified recovery foundation — not production
DR, no RPO/RTO, PITR, replication, or failover claims.

## Environment

- Repo: `b4snet/SDIS` — public.
- Clone HEAD: `75dd525` ("Initial commit").
- Stack: Node 24 LTS + TypeScript (forkless standard library testing).
- Tools installed locally for this step: Git 2.55, Node 24.19 (portable), npm 11.17.

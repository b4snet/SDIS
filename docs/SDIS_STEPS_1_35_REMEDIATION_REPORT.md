# SDIS Steps 1–35 — Audit Remediation Report

**Date:** 2026-09-27 · **Type:** remediation (fixes + regression tests + validation)
**Baseline:** `main` @ `75dd525` ("Initial commit"), all Steps 1–35 work
uncommitted (16 working-tree entries, preserved throughout — no reset, revert,
stash, or destructive git command used).
**Audit input:** `docs/SDIS_FULL_AUDIT_STEPS_1_35.md` (every finding re-verified
against current code before action; DOC-07 did not reproduce).
**Scope rule:** remediation only — no Step 36, no new features, no unrelated
refactoring. All changes are additive permission enforcement, concurrency
hardening, RLS migrations, tests, and documentation.

## 1. Initial baseline (pre-remediation, measured)

- Full suite: **873 tests / 229 suites / 0 fail**; build / typecheck / lint /
  format / `npm audit` (0 vulns) / `git diff --check` clean.
- 26 migrations, 94 source files, 97 test files, 23 permissions, 4 roles.

## 2. Findings by severity (audit IDs)

- HIGH (1): AUD-01 order-transition authorization bypass.
- MEDIUM (6): CON-01 inventory write-skew; SEC-01 017 fail-open RLS;
  SEC-02 bindings without RLS; SEC-03 idempotency keys without RLS + DELETE
  grant; AUD-02 clinical acts on `SETUP_MANAGE`; AUTH-01 dead
  `INTEGRATION_MANAGE`.
- LOW (8): TEST-01 RLS-gate coverage; AUTH-02 optional-`authz`; DB-01 index
  name; DB-02 runner checksums; DB-03 default password; OPS-01 tool stderr;
  OBS-01 log message; API-01 tail cursor.
- Documentation drift (10 items, DOC-01–DOC-10).
- Adjacent same-pattern defects found during remediation: terminology mapping
  creation and patient identifier attach without capability checks.

## 3. Findings fixed

### AUD-01 (HIGH) — order lifecycle authorization — FIXED

- Verified: `OrderService.transitionOrder` asserted a permission only for
  `VERIFIED`; all other transitions (and `cancelOrder` by delegation)
  required authentication alone. Reproduced by role-less/viewer sessions
  succeeding at `ACQUIRED`/`FINALIZED`/`CANCELLED` through the service and
  through `POST /diagnostic-orders/{id}/transitions`.
- Fix: `ORDER_CREATE` (operator tier, matching the specimen-transition bar)
  asserted on every transition at the service boundary; `VERIFIED` additionally
  requires the new manager-only `ORDER_VERIFY` (a dedicated clinical
  permission — no unrelated permission borrowed).
- Adjacent paths swept: specimen transitions already gated; `lab-flow` is an
  unrouted orchestrator delegating to gated services; terminology mapping
  creation and patient identifier attach had the same defect pattern and were
  fixed too (`terminology.manage` manager-only, reads intentionally open;
  attach now requires `patient.create`).
- Files: `src/app/authz/rbac.ts`, `src/app/laboratory/order-service.ts`,
  `src/app/terminology/terminology-service.ts`,
  `src/app/patients/patient-service.ts`,
  `src/infrastructure/runtime/postgres-runtime.ts` (terminology `authz`
  wiring).
- Tests: viewer-403 for every transition target + operator-VERIFIED-403 +
  no-state-change/no-audit-on-denial (service + HTTP, incl. positive
  operator/manager controls); terminology viewer/operator-403 + manager-allow
  - reads-open (service + HTTP); attach viewer-403 + operator-allow. One
    existing test (`security-scope`: cross-facility transition) was aligned to
    the layered order (operator session → `ScopeMismatchError` preserved; the
    sibling finalize test already used this shape) — no assertion weakened.

### CON-01 (MEDIUM) — concurrent inventory depletion — FIXED

- Verified root cause: `INSERT … SELECT WHERE SUM(…) >= qty` takes no row
  locks under READ COMMITTED (write-skew); the per-key advisory lock only
  serializes same-key replays.
- Fix: `SELECT … FOR UPDATE` on the lot row inside one transaction, then
  coverage check, then append (`inventory-repository.ts`); misleading comment
  corrected to state the real mechanism.
- Proof: real database-backed 4-racer distinct-key test asserting exactly one
  winner, all losers `Insufficient stock`, receipt + single issue ledger rows,
  running balance never negative, final balance 0 — green across 7
  consecutive runs plus in-memory parity suites.

### SEC-01 (MEDIUM) — migration 017 fail-open RLS — FIXED

- Verified: `IS NULL OR` facility branches + no RESTRICTIVE/FORCE = unscoped
  `sdis_app` sessions see all rows (currently unreachable via production
  paths, which always stamp both GUCs — latent).
- Fix (migration 027, forward-only, no data change): strict facility
  policies (global NULL-facility registry rows preserved), RESTRICTIVE
  fail-closed policies, FORCE on both tables. In-org visibility with context
  set is unchanged.
- Tests: no-GUC read/write denial probe, global-row in-org visibility,
  pre-existing foreign-tenant test still green; RLS gate extended.

### SEC-02 (MEDIUM) — bindings without RLS — FIXED

- Fix (migration 028): ENABLE+FORCE, facility-via-patient policies +
  RESTRICTIVE, grants untouched.
- Tests: owning-facility resolves, other-facility gets undefined, no-GUC
  sees zero rows.

### SEC-03 (MEDIUM) — idempotency keys hardening — FIXED

- Fix (migration 029): nullable `facility_id` written from the
  facility-composed key by the PG store, RLS + RESTRICTIVE, DELETE revoked
  from `sdis_app` (the expiry function has no caller; expiry stays
  predicate-based). `DATABASE.md` risk statement rewritten.
- Tests: tag written, same-facility replay works, cross-facility read finds
  nothing, app-role DELETE denied, row survives for the owner.
- Residual risk (explicit): memoized values remain full operation DTOs —
  confidentiality rests on key secrecy (facility-composed, TTL-bounded) plus
  RLS. Value minimization is future work.

### AUD-02 (MEDIUM) — clinical acts on `SETUP_MANAGE` — FIXED

- New manager-only permissions `ORDER_VERIFY`, `REPORT_AMEND`,
  `QUALITY_MANAGE` replace `SETUP_MANAGE` on order VERIFIED, report amend, QC
  record/release, and the worklist verification/exception views. Tiers
  unchanged (manager-only before and after); names now state the real
  authority. `RBAC.md` matrix updated.
- Tests: RBAC tiering tests; all existing manager-role suites green.

### AUTH-01 (MEDIUM) — dead `INTEGRATION_MANAGE` — INTENTIONAL / DOCUMENTED

- Verified: no HTTP registration route exists; registry writes are
  ops/seed-only, so no enforcement point can exist without inventing an
  endpoint (out of scope). The permission stays manager-assigned with a
  reservation contract in code + docs + a tiering test: the future endpoint
  MUST assert it.

## 4. LOW findings — all closed

| ID      | Disposition              | Change                                                                                                        |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| TEST-01 | FIXED                    | RLS gate covers all 34 tenant tables; migrations-table list extended                                          |
| AUTH-02 | INTENTIONAL / DOCUMENTED | Composition contract in `rbac.ts`; verified 19/20 runtime services wired, gateway delegates to gated services |
| DB-01   | FIXED                    | Migration 031 renames index to `uq_specimens_accession_global` (+ COMMENT); test + docs updated               |
| DB-02   | FIXED                    | `verifyAppliedChecksums()` + `MigrationChecksumMismatchError`; forward-only docstring; tamper test            |
| DB-03   | FIXED                    | Production fail-fast without `PGPASSWORD`/explicit config; new `database-config.test.ts`                      |
| OPS-01  | FIXED                    | `TOOL_FAILURE` surfaces stable `tool exited (status …)` shape only                                            |
| OBS-01  | FIXED                    | 200-char message cap + caller contract; cap test                                                              |
| API-01  | FIXED                    | limit+1 lookahead; tail-null assertion                                                                        |

## 5. Documentation drift — closed

- `API_CONTRACTS.md`: devices/acquisitions row added; duplicate
  specimen-transitions and amendments rows consolidated; auth notes corrected
  (transitions, amendments, terminology, identifier-attach, quality).
- `TENANCY.md`: cross-facility reads 404 (not 403); `src/types/tenant.ts`
  path corrected.
- `RBAC.md`: 4 new permissions + corrected `report.create` note +
  reservation note + transition table + manager-role intent.
- `DATA_INTEGRITY.md`: CON-01 mechanism, 027–031 hardening note,
  notification RLS backstop, accession index rename.
- `DATABASE.md`: idempotency-keys section rewritten for facility tagging.
- `ROADMAP.md`, `PROJECT_STATUS.md`, `preview/index.html`: counts refreshed
  to the post-remediation gate (below).
- `FOUNDATION_GATE.md` / `BASELINE_AUDIT_1-35.md`: dated gate/audit records
  preserved deliberately (rewriting another run's measurements would falsify
  history); superseding numbers live here and in the audit report §23.
- DOC-07 (mojibake): NOT REPRODUCED — byte scan proves all flagged files are
  valid UTF-8 (em-dash U+2014, § U+00A7, middle dot U+00B7); no file touched.
- DOC-08/09/10: fixed in code + docs as listed above.

## 6. Files changed

Source (13): `app/authz/rbac.ts`, `app/laboratory/order-service.ts`,
`app/laboratory/worklist-service.ts`, `app/laboratory/report-service.ts`,
`app/quality/quality-service.ts`, `app/terminology/terminology-service.ts`,
`app/patients/patient-service.ts`,
`infrastructure/database/repositories.ts`,
`infrastructure/database/inventory-repository.ts`,
`infrastructure/database/database.ts`,
`infrastructure/database/migrations.ts`,
`infrastructure/database/backup-restore.ts`,
`infrastructure/runtime/postgres-runtime.ts`,
`core/observability/logger.ts` (14 with logger).

Migrations added (5, all forward-only, no data changes): 027 (017 RLS),
028 (bindings RLS), 029 (idempotency scoping), 030 (RLS backfill),
031 (index rename).

Tests (16 files touched + 1 new): rbac, order-service, laboratory-lifecycle-http,
terminology-service, terminology-http, patient-service, patients-http
(harness untouched — gate is service-level), security-scope (layer alignment),
inventory-postgres, integration-postgres, patient-access-postgres,
idempotency-concurrency, migrations, database-config (new),
observability, laboratory-lifecycle-postgres, worklist-views, rls-policies.

Docs: audit report §23 (dispositions), this report, RBAC, API_CONTRACTS,
TENANCY, DATABASE, DATA_INTEGRITY, ROADMAP, PROJECT_STATUS, preview.

## 7. Migrations added or changed

Added 027–031 (listed above). No existing migration modified. Replay safety:
027 uses `DROP POLICY IF EXISTS` + `CREATE`; 028/029/030 use plain `CREATE`
(all guarded by `IF NOT EXISTS` where re-runnable objects are concerned);
031 renames inside an existence-guarded `DO` block. The migrations suite
replays 001–031 from empty.

## 8. Regression tests (added: 21 tests + 1 file + strengthened gates)

- Authorization: viewer-403 per order-transition target, operator-VERIFIED
  denial, no-side-effects assertions, HTTP 403 + positive controls;
  terminology viewer/operator denial + manager allowance + reads-open;
  identifier-attach viewer denial + operator allowance; RBAC tiering +
  reservation tests.
- Concurrency: 4-racer distinct-key depletion with ledger invariants.
- Security: 017 no-GUC denial + global-row visibility; bindings
  facility/no-GUC isolation; idempotency tag/replay/isolation/DELETE-denial.
- Integrity/ops: migration tamper rejection; production password fail-fast;
  log-message cap; tail-cursor null.
- Gates strengthened: RLS restrictive-policy list (26 → 34 tables),
  migrations RLS-table list, accession index name.

## 9. Security and concurrency results (final review)

- Order-transition authorization: every transition requires `ORDER_CREATE`;
  VERIFIED additionally requires `ORDER_VERIFY`; cancel flows through the
  same gate; denials emit no state change and no audit; successes audited per
  existing conventions. Adjacent mutation paths swept (specimen gated;
  terminology/attach fixed; lab-flow delegates to gated services).
- Inventory: per-lot serialization proven under the repo's READ COMMITTED
  behavior; ledger never negative; idempotent replays intact; over-issue
  still rejected without partial rows.
- Tenant/facility isolation + RLS/FORCE: extended gate green (34 tables);
  no-GUC probes green on 017/bindings/idempotency/notification paths;
  cross-tenant/cross-facility negatives green; service-layer facility
  enforcement intact (404 oracle-free).
- RBAC: 27 permissions / 4 roles, fail-closed engine unchanged; every served
  composition wires `authz` (19/20 services + delegating gateway).
- Patient ownership, transaction boundaries, clinical lifecycle gates
  (verification, QC hold, amendments, finalization), audit integrity, and
  integration boundaries: unchanged except as listed; respective suites green.
- Secrets/PHI: no new logging; logger message capped with caller contract;
  backup errors scrubbed; sweep suite green.
- No HIGH finding remains; MEDIUM residuals are SEC-03 DTO values
  (documented) and AUTH-01 reservation (documented). No regression
  introduced (two interim failures, both from new remediation code and both
  fixed without weakening: a test asserting the pre-fix layer order,
  realigned to the documented authenticated → permission → scope → resource
  order; and an unused helper parameter tripping `max-warnings 0`).

## 10. Final quality-gate results

| Gate                           | Result                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Targeted suites (per group)    | PASS throughout (106 auth/lifecycle; 49 integrity/ops; 22 migrations+RLS; 11 integration; 10 access+idempotency; repeated inventory runs) |
| Full suite `npm test`          | **PASS — 894 tests / 233 suites / 894 pass / 0 fail / 0 cancelled / 0 skipped / 132.3 s / exit 0**                                        |
| `npm run build`                | PASS (exit 0)                                                                                                                             |
| `npm run typecheck`            | PASS (exit 0)                                                                                                                             |
| `npm run lint`                 | PASS (exit 0, 0/0)                                                                                                                        |
| `npm run format:check`         | PASS                                                                                                                                      |
| `npm audit --audit-level=high` | 0 vulnerabilities                                                                                                                         |
| `git diff --check`             | clean                                                                                                                                     |

## 11. Residual risks

1. SEC-03 DTO values remain full operation records (documented boundary).
2. Fingerprint coverage stays `order.create`-only (pre-existing, documented).
3. Facility DB-isolation on permissive-policy tables stays service-layer
   (documented posture; 027–030 add fail-closed backstops, not narrowing).
4. Legacy NULL-facility idempotency rows stay visible until 24 h TTL expiry.
5. `withTenantContext` (partial-GUC API) has no production callers; kept for
   tests.
6. SDIS is a tested foundation, NOT production-ready (HA/PITR/IdP/tracing/
   live integrations remain deferred per PRODUCTION_READINESS.md).

## 12. Process ownership and cleanup

- No process killed; no gate interrupted. Two full-suite runs owned by this
  session: an interim run (894 tests, 1 failure — the layer-order test,
  fixed) and the final authoritative run (below). No duplicate parallel
  gates. All embedded-PG instances are test-owned and torn down by the
  suites. Working tree: uncommitted work preserved; only remediation files
  added/modified; nothing reset, reverted, stashed, or force-pushed.

## 13. Final Steps 1–35 status

With AUD-01 and CON-01 fixed and proven, all other findings closed or
documented, and the full gate green, Steps 1–35 are **COMPLETE as a tested
foundation** subject to the residuals above. "Complete" does not mean
production-ready. STOP — no Step 36 work started.

# SDIS Foundation Completion Gate (Step 35)

Audited 2026-09-25 against the actual repository (main @ `75dd525`, all work
uncommitted by operator rule). This is the evidence-based boundary between
**SDIS FOUNDATION** and **POST-FOUNDATION DEVELOPMENT**.

## 1. Gate decision

> **FOUNDATION COMPLETE**

No unresolved Foundation-blocking defect remains: security boundaries are
coherent, tenant/facility isolation is enforced and negatively tested, the
patient→report laboratory lifecycle is coherent, result governance holds,
data integrity and concurrency/idempotency are protected at three layers,
migrations replay deterministically, the operational chain is implemented and
tested, backup/recovery is honestly bounded, documentation matches the
implementation after two drift fixes, and the complete quality gate passes.

"Complete" means the FOUNDATION is complete — a coherent, tested,
honestly-documented base. It does NOT mean production-ready (see
PRODUCTION_READINESS.md: HA, PITR, tracing, scheduled-backup policy, and
live standards integrations are deliberately not implemented and are not
claimed).

## 2. Evidence baseline

| Item                  | Value                                                                                                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / HEAD         | `main` @ `75dd525` ("Initial commit"); all Step 1–34 work uncommitted (16 untracked/modified entries)                                                                                                                                                                                                                                             |
| Full gate             | `npm run verify` EXIT=0 — **821 tests, 821 pass, 0 fail, 0 skipped; build/typecheck/lint/Prettier clean; `npm audit` found 0 vulnerabilities**                                                                                                                                                                                                    |
| Scale                 | 25 migrations; 93 test files; 31 route-head branches over GET/POST only; 26 `runIdempotent` call sites; 15 domain aggregates                                                                                                                                                                                                                      |
| Audit probes executed | destructive-SQL scan (0 hits in src), SQL-interpolation scan (column-constant only), scope-trust grep (no body-supplied facility/role), route-method scan (no PATCH/PUT), worklist-bounds read, QC/patient-result separation read, priority-vocabulary read, index coverage read, notification/document/patient-access/integration boundary reads |

## 3. Foundation status matrix

Status: **PASS** (implemented + regression-tested), **PARTIAL** (real,
non-blocking gaps — cited), **FAIL** (none remain). Evidence = code +
tests, verified this session; test names are the regression proof.

| Area                      | Status             | Evidence (code + tests)                                                                                                                                                                                              | Blocking issue   | Fixed?  | Remaining work                                                 |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------- | -------------------------------------------------------------- |
| Architecture              | **PASS**           | 4-ring dependency direction; `core`→types only; transport→infra ban; console ban; `process.env` allowlist — `tests/architecture/*` enforced                                                                          | —                | —       | —                                                              |
| Domain boundaries         | **PASS**           | 15 bounded aggregates (`src/domain/*`), no cross-domain imports, no HTTP/DB deps in domain                                                                                                                           | —                | —       | —                                                              |
| Patient/Encounter         | **PASS**           | Registration + identity uniqueness (002), intake service + HTTP; smoke chain                                                                                                                                         | —                | —       | merge/dedup is post-foundation                                 |
| Orders                    | **PASS**           | State machine (ORDERED→…→FINALIZED), CAS saves, priority vocab bounded, `runIdempotent` create; `lab02-concurrency`, `integrity-hardening`                                                                           | —                | —       | —                                                              |
| Specimens                 | **PASS**           | Collect/reject reasons, facility-unique accession (022), 23505→409; lifecycle suites                                                                                                                                 | —                | —       | accession scope is GLOBAL (documented debt)                    |
| Laboratory workflow       | **PASS**           | order→specimen→accession→result→verify→finalize over PG + HTTP; `e2e-pg-lab-flow`, smoke chain                                                                                                                       | —                | —       | —                                                              |
| Results                   | **PASS**           | Entry + device ingestion with modality coherence; append-only observations; `postgres-repositories`, `devices` suites                                                                                                | —                | —       | —                                                              |
| Verification/Finalization | **PASS**           | Manager-tier attribution (024), verification gate on finalize, QC-hold gate; `result-governance-http`                                                                                                                | —                | —       | —                                                              |
| Amendments                | **PASS**           | Reason-bound (422 vocabulary), manager-tier, append-only lineage, supersedes link survives restore; recovery tests                                                                                                   | —                | —       | —                                                              |
| Worklists                 | **PASS**           | Views over authoritative state, keyset pagination + bounded page size, deterministic order, per-view RBAC; `worklist-views-http`                                                                                     | —                | —       | PG worklist reads scan the facility index set (debt)           |
| Billing                   | **PASS**           | Charge slice + `(order_item, service)` unique (015), keyed replay from ledger; billing suites                                                                                                                        | —                | —       | invoices/payments contract-only (deferred)                     |
| Inventory                 | **PASS**           | Append-only ledger, derived balances, conditional-INSERT stock floor, lot lifecycle, FEFO, reason-bound ops; inventory + smoke suites                                                                                | —                | —       | traceability fields exist; QC-consumption linking is partial   |
| Quality/QC                | **PASS**           | Families IQC/EQA/… separate from patient results; hold gates finalization (409), release restores; QC never rewrites results; `laboratory-lifecycle-http`                                                            | —                | —       | QC-hold scope is facility-wide (debt)                          |
| Authentication            | **PASS**           | Fail-closed bearer 401 + `WWW-Authenticate`, timing-uniform lookup, startup-validated env dir; `auth`, `security-hardening`                                                                                          | —                | —       | external IdP = post-foundation                                 |
| Authorization/RBAC        | **PASS**           | viewer/operator/manager fail-closed matrix in 18 services; per-view worklist permission; `rbac` suites                                                                                                               | —                | —       | per-resource ACLs = post-foundation                            |
| Tenant isolation          | **PASS**           | RESTRICTIVE RLS (014) + GUC stamping; negative no-GUC probes; tenant-leak probe re-proven post-restore                                                                                                               | —                | —       | RLS residual: unscoped pool-role reads (documented)            |
| Facility isolation        | **PARTIAL**        | Service-layer enforcement everywhere (403/404 negative tests); DB-level facility policy OR-shape masks within org (documented in backup-restore.ts)                                                                  | —                | —       | fold facility predicate into DB policy (debt)                  |
| Audit/Provenance          | **PASS**           | Hash-chained append-only ledger (005/016), serialized heads, verify function, actor/source provenance; `audit-persistence`                                                                                           | —                | —       | —                                                              |
| Documents                 | **PASS**           | sha256 integrity proofs, lifecycle without deletion, resource links; document suites                                                                                                                                 | —                | —       | —                                                              |
| Patient access            | **PASS**           | PATIENT principal, ownership binding, FINALIZED-only views, safe DTO; `patient-report-access`, smoke                                                                                                                 | —                | —       | —                                                              |
| Devices                   | **PASS**           | Acquisition-first replay derivation, modality coherence, raw-payload boundary; device suites                                                                                                                         | —                | —       | live analyzer protocols = advanced integrations                |
| Integrations              | **PASS**           | Fail-closed registry, append-only external refs, inbound canonical boundary; `integration` suites                                                                                                                    | —                | —       | —                                                              |
| Notifications/Events      | **PASS**           | Per-event delivery receipts (dedup identity), failures recorded never swallowed; notification suites                                                                                                                 | —                | —       | —                                                              |
| Emergency/Priority        | **PASS**           | Bounded ROUTINE/URGENT/EMERGENCY, deterministic priority worklist, audited changes, emergency ≠ critical boundary; Step-21/29 suites                                                                                 | —                | —       | —                                                              |
| Idempotency               | **PASS**           | 26 scoped call sites, `withExclusive` single-flight (advisory lock), same-key/different-payload fingerprint guard → 409 `IDEMPOTENCY_CONFLICT`; `integrity-hardening`, `idempotency-concurrency`                     | —                | —       | fingerprint wired on order.create (others plain replay — debt) |
| Concurrency               | **PASS**           | Version-CAS order/specimen on PG AND in-memory, 23505→409 mapping, race-free in-memory depletion; lab02/integrity suites                                                                                             | —                | —       | —                                                              |
| Transactions              | **PASS**           | Single `Database.transaction` unit with RLS stamping; rollback tests; no distributed machinery                                                                                                                       | —                | —       | —                                                              |
| Database/Migrations       | **PASS**           | 25 ordered forward-only migrations, replay proof, checksums, no destructive SQL in src; `migrations`, backup suites                                                                                                  | —                | —       | —                                                              |
| API Contracts             | **PASS**           | Explicit verbs (collect/receive/verify/finalize/amend/transition), GET/POST only, 400/401/403/404/405/409/413/415/422 taxonomy, correlation echo, stable error envelope; http-contract suite                         | —                | —       | pagination is keyset-in-body (cursor headers = debt)           |
| Observability             | **PASS**           | Allowlisted JSON logs, correlation IDs, bounded metrics + `/metrics`, readiness series, pool-failure series, `/healthz`+`/readyz`, startup validation, bounded graceful shutdown; process/observability/smoke suites | —                | —       | tracing not implemented (deferred)                             |
| Backup/Restore            | **PASS**           | Atomic-finalize checksummed backups, readability gate, protected-target refusal, `verifyRecovery` incl. post-restore RLS/audit probes, CLI drill; backup/ops-cli/recovery suites                                     | —                | —       | scheduling/retention/encryption = deployment policy            |
| Operational readiness     | **PASS**           | OPERATIONS/RUNBOOKS/PRODUCTION_READINESS docs; RPO/RTO placeholders; honest DR/HA boundary                                                                                                                           | —                | —       | HA/PITR/replication not implemented (deferred)                 |
| Documentation             | **PARTIAL → PASS** | 20+ docs matched implementation; two drifts found and fixed this gate (README status stale at "Step 4"; `.env.example` documented keys no code reads)                                                                | README/env drift | **Yes** | —                                                              |
| Standards boundaries      | **PASS**           | Compliance language enforced; HL7/FHIR/DICOM reserved-boundary wording with explicit "no claim" statements; no false live-integration claims                                                                         | —                | —       | live integrations = advanced integrations                      |
| Test/Quality gates        | **PASS**           | 821/821 across unit/integration/architecture/security/PG/HTTP/recovery/smoke; build/typecheck/lint/format/audit clean                                                                                                | —                | —       | —                                                              |

## 4. Blockers found and fixed

| #   | Finding                                                                                                                                                                                                                                                                                                                                   | Severity        | Fix                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------- |
| 1   | `README.md` declared "STEP 4 — HTTP TRANSPORT BOUNDARY" while the repository has Steps 1–34 implemented — a documentation-vs-reality contradiction on the front page (§17: docs must not understate/overstate reality).                                                                                                                   | LOW (doc drift) | Status header updated to the Step-35 gate state pointing at PROJECT_STATUS + this document. |
| 2   | `.env.example` documented `PORT`, `LOG_LEVEL`, `LOG_FORMAT`, `DATABASE_URL` — none are read by any code (real contract: `PG*`, `SDIS_API_TOKENS`, `SDIS_PG_CLIENT_DIR`, `NODE_ENV`). A new operator following the template would configure phantom keys; an unknown `SDIS_*` key now fails startup, so template accuracy is load-bearing. | LOW (doc drift) | Template rewritten to the actual contract with fail-closed semantics noted.                 |

No code blocker was found: every security, integrity, concurrency,
lifecycle, migration, and operational invariant checked this session is
enforced and regression-tested. No test was weakened and no failure was
suppressed; zero production code lines changed in this gate.

## 5. Remaining Foundation debt (non-blocking, carried to post-foundation)

1. **Facility isolation at the DB layer** — within one organization the
   permissive tenant policy OR-shape masks the facility policy; facility
   isolation is enforced at the service layer (negatively tested). Fold the
   facility predicate into a RESTRICTIVE DB policy.
2. **Fingerprint coverage** — the same-key/different-payload guard is wired
   on `order.create`; other idempotent scopes keep plain replay semantics
   (keys remain facility-scoped).
3. **Accession uniqueness scope** — GLOBAL, strictly stronger than the 022
   migration comment claims.
4. **RLS residual** — unscoped pool-role reads (migrations/ops tooling) run
   as the pool role by design; the facility-directory scope-escape for
   session validation is deliberate.
5. **Worklist PG reads** — bounded but scan indexed facility/status sets
   in-memory for filtering; fine at foundation scale, worth SQL-pushdown
   later.
6. **IDEMP-01 replay window** — 24 h TTL keyed-replay semantics (BILL-04
   decision) remain open.
7. **QC hold scope** — facility-wide analytical hold; lot-level linking of
   QC consumption to inventory usage is partial.
8. **Cursor headers** — worklist pagination is keyset-in-body; RFC-5988
   cursor headers not exposed.

## 6. Deferred product work (outside this gate)

Invoices/payments; patient merge/dedup; external IdP federation; per-resource
ACLs; distributed tracing; advanced alerting consumption; scheduled backup
policy automation; report artifact rendering; multi-facility org-wide views.

## 7. Advanced integrations (post-foundation)

HL7 v2 / FHIR R4 / DICOM / DICOMweb / IHE profiles; SMART on FHIR; live
analyzer protocols (ASTM/POCT); external HMS interoperability contracts. All
boundaries reserved and documented with explicit no-claim language
(docs/STANDARDS.md, docs/COMPLIANCE_REGISTER.md).

## 8. Advanced modalities (post-foundation)

ECG/EEG/PFT/TMT/Echo/Ultrasound workflows beyond the modality-vocabulary
extension point (`tests/architecture/modality-extensibility.test.ts`); PACS;
imaging storage.

## 9. Future platform work

HA/replication/failover; PITR/WAL archiving; multi-region; scaling and
SQL-pushdown work; enterprise SSO/audit sinks; container/orchestration
posture.

## 10. Gate execution record

- Baseline full gate launched first, audit probes executed in parallel, gate
  result collected before the decision: EXIT=0, 821/821, 0 vulnerabilities.
- Documentation drifts fixed (README, `.env.example`) — text-only; no test
  surface touched; gate result unaffected.
- Operator rule honored: nothing committed, nothing reset, all Step 1–34
  work preserved.

**This document is the Foundation boundary. Post-foundation development
(Step 36+) builds ON this base; it does not reopen the gate.**

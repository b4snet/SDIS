# SDIS Production Readiness Checklist (Step 34)

Factual per-area classification. Statuses: **Implemented** (behaviorally
present and regression-tested in this repository), **Partially Implemented**,
**Deployment Dependent** (the repository provides the mechanism; the
deployment must configure it), **Not Implemented**. This checklist deliberately
does NOT label SDIS "production-ready" as a whole — the Foundation Completion
Gate decides that.

## 1. Security

| Area                                                           | Status                                                                                                          | Evidence                                                              |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Authentication (bearer, fail-closed 401 + challenge)           | **Implemented**                                                                                                 | Step 10/32; security-hardening tests; `WWW-Authenticate` on every 401 |
| Authorization (RBAC, fail-closed, 18 services)                 | **Implemented**                                                                                                 | Step 32; docs/RBAC.md                                                 |
| Tenant isolation (RESTRICTIVE RLS + GUC stamping)              | **Implemented**                                                                                                 | migration 014; tenant-isolation probes incl. post-restore             |
| Facility isolation                                             | **Implemented** (service layer) / **Partially Implemented** (DB-level OR-shape documented in backup-restore.ts) | Step 32; service-layer proofs                                         |
| Secret handling (no secrets in source; env-only)               | **Implemented**                                                                                                 | secret sweep tests; process.env allowlist architecture test           |
| Credential lookup timing uniformity                            | **Implemented**                                                                                                 | AUTH-03 fix; security-hardening tests                                 |
| Transport hardening (413/415/400/405, nosniff, error envelope) | **Implemented**                                                                                                 | http-contract + security suites                                       |
| TLS termination                                                | **Deployment Dependent**                                                                                        | proxy/load-balancer territory; repository is TLS-agnostic             |

## 2. Data

| Area                                                           | Status                   | Evidence                                                         |
| -------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Migrations (ordered, forward-only, tracked)                    | **Implemented**          | `MigrationRunner`; migration-replay tests (25 migrations)        |
| Backup (consistent, checksummed, atomic finalize)              | **Implemented**          | `createBackup`; backup-restore + ops-cli tests                   |
| Backup scheduling / retention / encryption / off-host shipping | **Deployment Dependent** | OPERATIONS.md §7; CLI is scheduler-safe                          |
| Restore (isolated, readability-gated, checksum-verified)       | **Implemented**          | `restoreBackup`; protected-target refusal before any side effect |
| Restore verification (schema/RLS/migrations/audit/tenant)      | **Implemented**          | `verifyRecovery` + `verify-restore` drill                        |
| Recovery drill (automatable, synthetic data)                   | **Implemented**          | `tests/infrastructure/recovery.test.ts`, ops-cli drill test      |
| Integrity checks (read-only diagnostics)                       | **Implemented**          | `npm run ops-check`; schema/audit/ledger/accession probes        |
| Point-in-time recovery / WAL archiving                         | **Not Implemented**      | explicitly deferred (§45)                                        |
| Replication / HA / failover                                    | **Not Implemented**      | explicitly deferred (§45)                                        |

## 3. Runtime

| Area                                                        | Status                   | Evidence                                              |
| ----------------------------------------------------------- | ------------------------ | ----------------------------------------------------- |
| Startup validation (fail-fast config gate)                  | **Implemented**          | `validateStartupConfig`; process.test.ts              |
| Liveness (`/healthz`, dependency-free)                      | **Implemented**          | observability-http tests                              |
| Readiness (`/readyz`, bounded probes, 503 semantics)        | **Implemented**          | observability-http + smoke tests                      |
| Graceful shutdown (SIGTERM/SIGINT, bounded, pool drain)     | **Implemented**          | `shutdown`/`installShutdownHandlers`; process.test.ts |
| Connection pool management (bounded, released in `finally`) | **Implemented**          | `Database` (max 20 / 30 s idle / 5 s connect)         |
| Process supervision / restart policies                      | **Deployment Dependent** | orchestrator responsibility                           |
| Non-root container execution                                | **Deployment Dependent** | no container image is shipped by this repository      |
| Writable directories / filesystem assumptions               | **Deployment Dependent** | backup dir + pg client dir are env-configured         |

## 4. Observability

| Area                                                     | Status                   | Evidence                                                                                                                           |
| -------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Structured logs (allowlist redaction, correlation ids)   | **Implemented**          | `createLogger`/`redact`; observability suites                                                                                      |
| Sensitive-data protection in logs                        | **Implemented**          | `redact` allowlist; boundary-hardening console ban                                                                                 |
| Metrics (bounded, cardinality-controlled)                | **Implemented**          | `createMetricsRegistry`; fixed vocabularies; unknown labels rejected                                                               |
| `/metrics` exposure (unauthenticated, bounded labels)    | **Implemented**          | gated by `exposeMetrics`; smoke + process tests                                                                                    |
| Request latency (method × status class × bucket)         | **Implemented**          | `observeRequestDuration`; access-log `durationMs`                                                                                  |
| Database failure signals (pool errors, readiness series) | **Implemented**          | `observeDependencyFailure`/`observeDependencyProbe` wiring                                                                         |
| Worker metrics (queue depth, retries)                    | **Not Implemented**      | no background worker exists (§45 scope)                                                                                            |
| Distributed tracing                                      | **Not Implemented**      | future work (documented since Step 12)                                                                                             |
| Alerting platform                                        | **Deployment Dependent** | stable signals are exported (`sdis_readiness_probes_total`, `sdis_dependency_failures_total`, exit codes); consumption is external |

## 5. Operations

| Area                                           | Status                    | Evidence                                                                                  |
| ---------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| Runbooks (10 failure procedures)               | **Implemented**           | docs/RUNBOOKS.md                                                                          |
| Operator CLI (backup / verify-restore / check) | **Implemented**           | `scripts/sdis-admin.mjs` + npm scripts; ops-cli tests                                     |
| Smoke test chain (§39, synthetic data)         | **Implemented**           | `tests/app/smoke.test.ts` over real HTTP + PostgreSQL                                     |
| Audit vs operational-log separation            | **Implemented**           | append-only audit triggers; console-ban architecture test                                 |
| Deployment automation / CI execution           | **Partially Implemented** | CI template exists (never executed — Step-1 contract); no deploy pipeline by design       |
| RPO/RTO measurement                            | **Deployment Dependent**  | drill measures restore time; targets must be configured per deployment (OPERATIONS.md §8) |
| Disaster recovery (site loss)                  | **Not Implemented**       | backup ≠ DR (OPERATIONS.md §9)                                                            |

## 6. Summary

- Implemented: the complete operational chain — Runtime → Health → Logs →
  Metrics → Audit → Backup → Restore → Recovery → Smoke Test.
- Deployment-dependent: retention/encryption/scheduling, TLS, supervision,
  container posture, RPO/RTO configuration, alerting consumption.
- Not implemented (deliberately, §45): PITR/WAL, replication/HA/failover,
  distributed tracing, background-worker fleet, enterprise alerting.

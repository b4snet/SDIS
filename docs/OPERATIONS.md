# SDIS Operations — Observability, Recovery & Runtime (Step 34)

Canonical operational model. Status: **implemented for the shipped foundation,
verified by tests, honest about boundaries** — code wins over this document on
conflict. Companion docs: RUNBOOKS.md (failure procedures),
PRODUCTION_READINESS.md (per-area classification), DEPLOYMENT.md §5 (recovery
detail), SECURITY.md (redaction policy), DATA_INTEGRITY.md (integrity model).

## 1. The operational chain

```text
Runtime → Health → Logs → Metrics → Audit → Backup → Restore → Recovery → Smoke Test
```

Every link is implemented and regression-tested:

- **Runtime** — composition edge (`src/index.ts`, `postgresServerOptions`)
  assembles transport + PostgreSQL runtime; process lifecycle
  (`src/runtime/process.ts`) validates configuration before binding and
  shuts down gracefully.
- **Health** — `GET /healthz` (liveness, process-local) and `GET /readyz`
  (readiness, injected probes, 2 s bounded), `src/core/observability/health.ts`.
- **Logs** — allowlisted single-line JSON (`src/core/observability/logger.ts`);
  PHI and credentials have no path into a log line (`redact`).
- **Metrics** — bounded counters (`src/core/observability/metrics.ts`);
  exposed unauthenticated by design at `GET /metrics` (bounded labels only),
  gated by `TransportConfig.exposeMetrics`.
- **Audit** — the hash-chained append-only ledger (AUDIT_PROVENANCE.md) is
  the WHO-DID-WHAT record; operational logs never replace it and audit
  tables are never used as debug logs.
- **Backup / Restore / Recovery** — `src/infrastructure/database/backup-restore.ts`
  - `scripts/sdis-admin.mjs` + npm scripts (`backup`, `verify-restore`,
    `ops-check`), driven by the repository's own tooling — no second
    implementation.
- **Smoke test** — `tests/app/smoke.test.ts` proves the §39 chain end-to-end
  over real HTTP + PostgreSQL with synthetic data.

## 2. Health and readiness semantics

| Question                         | Endpoint   | Depends on                        | Failure behavior                                                    |
| -------------------------------- | ---------- | --------------------------------- | ------------------------------------------------------------------- |
| Is the process alive?            | `/healthz` | Nothing                           | Always `200 {status:"ok"}` while the event loop runs                |
| Can this instance serve traffic? | `/readyz`  | Injected probes (e.g. PostgreSQL) | `503 {status:"unavailable", dependencies:{postgres:"unavailable"}}` |

- Liveness NEVER queries a dependency — a hung database cannot crash-loop a
  healthy process out of an orchestrator.
- Readiness probes are hard-bounded (2 s per probe); a health check never
  hangs.
- Dependency status is reported by bounded NAME only — no connection strings,
  no SQL, no infrastructure topology.
- Every readiness outcome feeds the bounded
  `sdis_readiness_probes_total|<dependency>|<ok|unavailable>` series — the
  alertable signal that fires when a dependency goes down, without waiting
  for a request to fail.

## 3. Process lifecycle

### Startup validation (fail-fast, before binding)

`validateStartupConfig` (`src/runtime/process.ts`) rejects:

- unknown `SDIS_*` environment keys (typo protection — `SDIS_API_TOKEN` must
  never silently disable authentication while the operator believes it is on);
- a malformed `SDIS_API_TOKENS` credential directory (parsed exactly as the
  server will parse it);
- unknown `NODE_ENV` values and a non-integer `PGPORT`;
- invalid transport configuration (body limit, metrics flag).

Absent optional configuration is VALID: local development keeps working and
an unconfigured credential directory stays fail-closed (all requests 401),
never insecurely permissive.

### Graceful shutdown (bounded)

`shutdown` / `installShutdownHandlers` (SIGTERM/SIGINT):

1. stop accepting new requests (`server.close`) and close idle keep-alive
   sockets;
2. let in-flight requests finish within a budget
   (`DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000`);
3. run the caller's drain step (e.g. `db.close()` — pool connections close,
   no active transaction is killed mid-flight by the shutdown itself);
4. observe `sdis_shutdowns_total|graceful` (or `|forced`).

A wedged shutdown (budget exceeded) is reported `forced`, logged, and the
process exits non-zero so the orchestrator sees it. A repeated signal
force-exits immediately — an operator can always stop the process.

## 4. Metrics (bounded, cardinality-controlled)

| Series                                      | Labels                                         | Meaning                        |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| `sdis_http_requests_total`                  | method, status class (2xx/4xx/5xx/other)       | request volume by outcome      |
| `sdis_http_request_duration_seconds_bucket` | method, coarse bucket (≤5 ms … ≤5000 ms, +Inf) | latency distribution           |
| `sdis_operation_total`                      | bounded operation vocabulary, success/failure  | application operation outcomes |
| `sdis_dependency_failures_total`            | dependency (`postgres`, `storage`)             | pool/connect-level failures    |
| `sdis_readiness_probes_total`               | dependency, ok/unavailable                     | readiness probe outcomes       |
| `sdis_shutdowns_total`                      | graceful/forced                                | process lifecycle events       |

Cardinality controls: labels come ONLY from fixed vocabularies (methods,
status classes, bounded operations, dependency names, route skeletons such as
`/api/v1/patients`, never resource ids, never free text, never error
messages). Unknown operations are rejected at the registry (not recorded), so
series cannot grow unbounded. Clinical values and patient data have no
representation in metrics at all.

## 5. Database observability

- **Pool failures** — the pool `error` event increments
  `sdis_dependency_failures_total|postgres` (inject the registry via
  `setDatabaseMetrics`) and logs the provider message WITHOUT credentials.
- **Readiness** — the PostgreSQL probe reuses the existing pool
  (`SELECT 1`); no second pool, no connection churn.
- **Transactions** — failures surface through the typed error taxonomy
  (ConflictError/…) and the request access log's `errorCode` field;
  connection lifecycle is bounded (pool `max: 20`, 30 s idle timeout, 5 s
  connect timeout, clients always released in `finally`).
- Raw SQL and bind parameters are never exposed to monitoring — probes,
  metrics, and error bodies carry status/category only.

## 6. Backup & restore operations

Operator entry points (all credentials via `PG*` environment variables;
nothing is logged or persisted; nothing is uploaded anywhere):

| Task                            | Command                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Consistent snapshot             | `npm run backup` (or `node scripts/sdis-admin.mjs backup --out-dir DIR`)       |
| Full restore drill              | `npm run verify-restore -- --artifact FILE --sha256 HEX --database SCRATCH_DB` |
| Read-only integrity diagnostics | `npm run ops-check`                                                            |

Behavior guarantees (all regression-tested):

- **Atomic finalize** — the dump is written to `<name>.partial`, the artifact
  must pass a readability check (`pg_restore --list`, no database touched),
  and only then is it renamed into place. A failed backup can never occupy
  the deterministic name; no failure path reports success.
- **Refuses destructive defaults** — restore targets `postgres`, `sdis`,
  `sdis_dev` only with the explicit `CONFIRM-IN-PLACE-RESTORE` token; the
  refusal fires before any other check.
- **Readability before restore** — a corrupt artifact is rejected before any
  restore side effect (no half-restored target).
- **Verification** — `verifyRecovery` proves schema completeness, constraint/
  index/RLS-object counts, migration state, the audit hash chain
  (`sdis.verify_audit_chain` per chain), tenant isolation under application
  role GUCs, finalized-report immutability, amendment linkage, and persisted
  idempotency records.
- **Read-only diagnostics** — `ops-check` runs the same verification against
  the LIVE database plus derived inventory-balance and accession-identity
  probes. It never repairs anything.

## 7. Backup security, retention & scheduling (deployment policy)

Backups contain the entire clinical record. The repository implements
artifact creation and verification; a deployment MUST decide:

- **Storage location & permissions** — an operator-readable directory with
  restricted permissions; the artifact is never served by the application
  and never committed to version control.
- **Encryption at rest** — encrypt artifacts at the storage layer (or via
  the destination volume); SDIS does not encrypt the dump itself.
- **Credential separation** — backup credentials (dump role) should be
  narrower than application credentials; they are supplied via environment
  only.
- **Retention** — deployment-configurable (e.g. N daily + M weekly + K
  monthly artifacts, with a defined deletion policy). Healthcare retention
  obligations vary by jurisdiction; no single period is hard-coded here.
  Deletion of expired artifacts is operator policy, not repository code.
- **Access auditing** — artifact access happens outside the application;
  audit it at the storage layer.
- **Scheduling** — the CLI is deterministic and exit-code-safe for any
  scheduler (cron/Task Manager/orchestrator CronJob). No scheduler is
  installed by the repository.

## 8. RPO / RTO (deployment-configurable placeholders)

SDIS does NOT ship enterprise guarantees; each deployment must configure and
measure its own targets:

| Target                      | Placeholder         | What determines it here                                                                                                      |
| --------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **RPO** (max data loss)     | deployment-specific | backup schedule frequency — everything since the last artifact can be lost (no WAL archiving/PITR)                           |
| **RTO** (max recovery time) | deployment-specific | restore duration + verification + application start; the `verify-restore` drill measures this end-to-end on scratch hardware |

Record the configured RPO/RTO, the measured drill duration, and the artifact
schedule in the deployment's own operations documentation.

## 9. Recovery boundary (honest)

- **Backup** — consistent physical snapshot of one PostgreSQL database
  (implemented, verified).
- **Recovery** — deterministic restore + verification of a disposable
  database, including security posture (implemented, verified).
- **Disaster recovery** — NOT claimed: no off-host replication, no site-loss
  procedure, no PITR/WAL archiving, no cross-region story.
- **High availability** — NOT claimed: single instance, no failover, no
  replication; backups do not provide HA.

## 10. Audit vs operational logs

- **Audit** (`sdis.audit_events`, hash-chained): who did what to which
  business resource, with actor + source provenance. Written by the
  application in the same transactional boundary as the mutation.
- **Operational logs/metrics**: what the software/runtime did (requests,
  latencies, failures, shutdowns). Allowlisted fields only.
- Neither substitutes for the other; the boundary is enforced by the
  architecture tests (application/transport cannot write raw console output;
  audit inserts are append-only triggers).

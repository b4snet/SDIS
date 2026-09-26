# SDIS Deployment & Environments

Status: Step 1 — **strategy only. Nothing is deployed.**

## 1. Environment model

| Environment | Purpose                                                                     | Access                                         |
| ----------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| Local       | Development; synthetic fixtures                                             | Developer machine                              |
| CI          | Quality gates on every change (future; template provided, not yet executed) | GitHub Actions (when enabled)                  |
| Staging     | Pre-production validation (future)                                          | Restricted                                     |
| Production  | Live operation (future)                                                     | Restricted; never touched from this repository |

## 2. Deployment target (planned)

- Containerized application (Docker) behind a TLS-terminating proxy.
- PostgreSQL as the primary store (see DATABASE.md).
- Object storage abstraction for documents (see Documents boundary).
- Secrets via a managed secret store (environment variables only for local dev).

## 3. Configuration

- `.env.example` is the committed template. Real values are never committed.
- `NODE_ENV=production` never implies insecure defaults.
- All configuration is validated at startup (contract), fail-fast.

## 4. Observability (Step 12 foundation — provider-neutral, opt-in)

Implemented as a small operational edge (`src/core/observability/` + server
options); no logging framework, no exporter, no monitoring SaaS dependency:

- **Structured logs** — single-line JSON (`ts`, `level`, `message` + safe
  fields) via `createLogger`. Field access is an ALLOWLIST (correlation id,
  route, method, status, duration, error code, scope ids, safe resource
  kind/id); credential-bearing keys are always dropped, unknown keys are
  dropped, free text is truncated. Raw bodies, PHI, and tokens have no path
  into a log line.
- **Correlation** — the existing edge-minted/reused correlation ID is on every
  response header and error body (unchanged contract) and on every access-log
  line.
- **Metrics** — bounded, in-process counters (`createMetricsRegistry`):
  request totals by method × status class, coarse duration buckets, operation
  outcomes, dependency failures. Labels come from fixed vocabularies (no
  resource ids, no free text) so series cannot grow unbounded. Snapshots are
  plain objects; export format is deliberately unspecified.
- **Metrics exposure (Step 34)** — `GET /metrics` serves the bounded snapshot
  unauthenticated BY DESIGN (counters only; no identifiers, credentials, or
  free text can enter a label). Gate it off with
  `TransportConfig.exposeMetrics = false` when a deployment terminates metrics
  collection elsewhere.
- **Readiness signals (Step 34)** — every readiness probe outcome feeds the
  bounded `sdis_readiness_probes_total|<dependency>|<ok|unavailable>` series
  (the alertable dependency-down signal), pool errors increment
  `sdis_dependency_failures_total|postgres` (inject via `setDatabaseMetrics`),
  and process shutdowns record `sdis_shutdowns_total|graceful|forced`.
- **Health** — `GET /healthz` (liveness: process-local, never queries a
  dependency) and `GET /readyz` (readiness: injected dependency probes with a
  2s per-probe timeout; failures map to `503` + `status: "unavailable"` with
  status-only bodies — no SQL, no stack traces, no endpoints/secrets exposed).
  The PostgreSQL probe (`createPostgresReadinessProbe`) runs `SELECT 1`
  through the EXISTING pool — no second pool, no new schema.
- Instrumentation is opt-in per composition (`logger`/`metrics`/
  `readinessProbes` server options default to silent no-ops). Nothing clinical
  is measured; no diagnostics/accuracy/outcome metrics exist.
- Tracing remains future work.

## 5. Disaster recovery — backup / restore (IMPLEMENTED, VERIFIED LOCALLY)

Step 18 establishes a **local recovery foundation** (`src/infrastructure/database/backup-restore.ts`,
proven by `tests/infrastructure/recovery.test.ts`). It is NOT production disaster recovery.

### Backup (IMPLEMENTED)

- `createBackup` runs `pg_dump --format=custom` against an explicit target and
  writes a deterministic artifact name chosen by the caller (e.g.
  `sdis_YYYYMMDDTHHMMSSZ.dump`) into the requested directory.
- The artifact's SHA-256 is computed and returned; integrity is verifiable at
  any time via `sha256File` (recomputed checksum must match the recorded one).
- A second backup under the same deterministic name is REFUSED — no silent
  overwrite, no silent partial success (empty artifact → error).
- Failure exits with a typed `RecoveryError` (`TOOL_FAILURE`, `UNAVAILABLE`);
  the process fails loudly, nothing is swallowed.
- Credentials come only from the caller's environment (PGPASSWORD pattern used
  by the whole suite); no credential appears in source, logs, or this doc.

### Restore (IMPLEMENTED)

- `restoreBackup` validates the artifact (existence + optional SHA-256) BEFORE
  invoking `pg_restore --exit-on-error`; a checksum mismatch aborts before any
  restore side effect.
- The default and only non-confirmed target is an **isolated disposable**
  database. Protected databases (`sdis`, `sdis_dev`, `postgres`) are refused
  unless the explicit `CONFIRM-IN-PLACE-RESTORE` token is passed — restoring
  over the current database is never a default behavior.
- A failed restore (e.g. corrupt artifact) leaves no usable `sdis` schema
  behind (`--exit-on-error`), and the error surfaces as a typed failure.
- ACLs are preserved in the artifact (`--no-privileges` is deliberately NOT
  used) so the restored database keeps the `sdis_app` grants RLS depends on.

### Recovery verification (IMPLEMENTED)

`verifyRecovery` proves, on any database (restored or live):

- schema: every authoritative `sdis` table present (organizations, facilities,
  departments, patients, external identifiers, encounters, modalities, orders,
  order items, specimens, observations, interpretations, reports + versions,
  audit, idempotency, terminology, billing, devices/acquisitions, documents,
  inventory, setup config, migrations);
- constraints/indexes/RLS objects: foreign keys, unique constraints, indexes,
  RLS-enabled tables and policies counted and compared against the source;
- migration state: applied-migration count equals `db/migrations`, zero
  pending migrations after restore (forward-only policy intact);
- audit integrity: `sdis.verify_audit_chain` is executed for every
  (organization, facility) chain — a tampered row is detected;
- tenant isolation: under an application-role session with org/facility GUCs
  set exactly as the application sets them, foreign-tenant rows are invisible;
- idempotency: a persisted idempotency record survives restore and replays
  correctly through a real application service (no duplicate order);
- clinical integrity: FINALIZED report versions remain FINALIZED and refuse
  re-finalization through the service; amendments keep their supersedes link;
- application usability: the full runtime composes against the restored
  database and can both read recovered state and create new orders.

### Status boundaries (honest)

- **IMPLEMENTED / VERIFIED LOCALLY**: physical backup, checksum-verified
  isolated restore, recovery verification, tamper detection, application
  reuse of a restored database.
- **ARCHITECTURE-READY**: scheduled backups, off-host artifact shipping,
  retention policy (the module is deterministic and scriptable; no scheduler
  is installed here).
- **DEFERRED / NOT IMPLEMENTED**: point-in-time recovery, WAL archiving,
  streaming replication, high availability, automated failover, cross-region
  recovery, encrypted/versioned off-site storage, RPO/RTO guarantees. No
  production disaster-recovery claim is made.

## 6. Process lifecycle (Step 34)

- **Startup validation** — `validateStartupConfig`
  (`src/runtime/process.ts`) fails the process before binding on: unknown
  `SDIS_*` environment keys (typo protection), a malformed
  `SDIS_API_TOKENS` directory, unknown `NODE_ENV`, a non-integer `PGPORT`,
  and invalid transport configuration. Absent optional configuration is
  valid — local development keeps working and unconfigured auth stays
  fail-closed (401), never insecure.
- **Graceful shutdown** — SIGTERM/SIGINT close the listener, let in-flight
  requests finish (idle keep-alive sockets close immediately) within a
  bounded budget (10 s default), run the caller's drain step (e.g.
  `db.close()`), and record `sdis_shutdowns_total`. A wedged shutdown is
  reported `forced` and exits non-zero; a repeated signal force-exits.

## 7. Operator tooling (Step 34)

`scripts/sdis-admin.mjs` (npm scripts `backup`, `verify-restore`,
`ops-check`) drives the repository's own recovery module — backup with
atomic finalize + readability gate, the full restore drill into a disposable
database, and read-only integrity diagnostics. Credentials come only from
`PG*` environment variables; nothing is uploaded, logged, or hard-coded.
Retention, encryption, scheduling, and artifact shipping are deployment
policy (docs/OPERATIONS.md §7). Recovery detail remains in §5 above; runbooks
in docs/RUNBOOKS.md; per-area classification in
docs/PRODUCTION_READINESS.md.

## 8. Honest status

No deployment, no staging, no production infrastructure. Nothing here has been run
in any environment other than this developer machine.

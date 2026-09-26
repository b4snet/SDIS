# SDIS Runbooks (Step 34)

Concise procedures for the failure modes an operator actually meets. Every
diagnosis works without exposing credentials or patient data. Commands assume
repository root, `npm run build` completed, and PG* environment variables set
(PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD), with `SDIS_PG_CLIENT_DIR`
pointing at the pg client `bin` directory when using recovery tooling.

## 1. Startup failure

Symptom: process exits before serving; `stderr` shows `SDIS configuration is
invalid: …` (StartupConfigError).

Inspect, in order:

1. The listed failures name the exact problem — unknown `SDIS_*` key (typo),
   malformed `SDIS_API_TOKENS` JSON, bad `NODE_ENV`/`PGPORT`, or an invalid
   transport setting.
2. Fix the environment; absent optional configuration is valid, so removing
   a broken key restores local-development defaults (fail-closed 401s).
3. If configuration is correct but the process still dies, check that the
   configured transport values are integers/booleans and that `npm run build`
   produced `dist/`.

The server never binds with invalid configuration — there is no partially
started state to diagnose.

## 2. Database unavailable

Symptom: `/readyz` returns `503` with
`dependencies:{postgres:"unavailable"}`;
`sdis_readiness_probes_total|postgres|unavailable` rises; requests fail with
persistence errors; `/healthz` stays `200`.

1. Confirm the instance is otherwise healthy (`/healthz` 200) — only the
   dependency is down; do not restart the application (it will not help).
2. Diagnose PostgreSQL with the tools your deployment provides
   (`pg_isready`, service manager, cloud console). The application pool
   bounds itself (max 20, 5 s connect timeout) — it recovers on its own when
   the server returns.
3. Verify recovery: `curl /readyz` returns `200` and the counter series
   `…|postgres|ok` resumes rising.
4. If `readyz` stays `503` while PostgreSQL accepts connections, check pool
   exhaustion (`SELECT count(*) FROM pg_stat_activity WHERE datname =
current_database();`) for leaked clients — that is a defect, not an
   operational state; capture the last log lines and report it.

## 3. Readiness failure (dependency unknown)

Symptom: `/readyz` 503 for a dependency you did not expect.

1. The dependency NAME in the body is the bounded label of the failing probe
   (currently `postgres`, optionally `storage`).
2. Each probe is bounded (2 s) — a 503 is a real failure or timeout, never a
   hanging probe.
3. The application continues serving process-local endpoints (`/healthz`,
   `/metrics`) — use them to decide whether to drain traffic.

## 4. Migration failure

Symptom: `MigrationRunner` errors during setup, or `npm run ops-check`
reports a `MIGRATION_MISMATCH` finding.

1. Inspect applied state: `SELECT id, filename, applied_at FROM
sdis.schema_migrations ORDER BY applied_at;`
2. Compare with `ls db/migrations` — the runner is forward-only; a missing
   id means the migration did not apply, an extra id means the schema is
   ahead of the checkout.
3. Migrations run inside a transaction per file (`--exit-on-error`
   semantics): a failed migration leaves the database at the previous state;
   fix the obstruction and re-run.
4. Never edit an applied migration; add a new one (forward-only policy).

## 5. Backup failure

Symptom: `npm run backup` exits non-zero with
`SDIS operations CLI: backup FAILED[…]`.

1. The error category tells the failure class: `UNAVAILABLE` (server down),
   `TOOL_FAILURE` (pg_dump failed), `READABILITY_FAILED` (artifact produced
   but not readable), `INVALID_ARTIFACT` (empty or a stale
   `<name>.partial` exists).
2. A failed backup NEVER occupies the deterministic artifact name and never
   leaves `.partial` debris — the last known-good artifact is untouched.
   Verify: `ls <out-dir>` shows no `.partial` files.
3. Fix the cause (connectivity, disk space, permissions), then re-run with
   the SAME artifact name — the name is free again by design.
4. After any backup failure, check when the last successful artifact was
   written (`ls -la <out-dir>`) and reassess the RPO window (OPERATIONS.md §8).

## 6. Restore (controlled procedure)

Restore ONLY into a disposable database. The exact sequence:

```bash
# 1. Validate the artifact without touching any database (readability).
node scripts/sdis-admin.mjs verify-restore --artifact FILE --database SCRATCH_DB
#    (refuses protected targets postgres/sdis/sdis_dev first; then verifies)

# 2. Full drill: drop/create SCRATCH_DB, restore, verify schema/constraints/
#    RLS/migrations/audit chain/tenant isolation. Non-zero exit on any failure.
npm run verify-restore -- --artifact FILE --sha256 HEX --database SCRATCH_DB

# 3. Smoke the restored database with the application (synthetic actions only).
#    Point the runtime at SCRATCH_DB (PGDATABASE) and run the smoke chain or
#    the §39 manual equivalents (health, auth, one synthetic patient + order).

# 4. Drop the scratch database when done — it is disposable by contract.
```

Restoring over a production database is an EXPLICIT operator action outside
this repository's tooling (`CONFIRM-IN-PLACE-RESTORE` exists for tooling
tests, never for operations).

## 7. Restore verification failure

Symptom: `verify-restore` exits non-zero with `failures: [...]`.

1. Each failure has a stable category: `SCHEMA_MISMATCH` (missing table),
   `MIGRATION_MISMATCH` (count drift), `AUDIT_CHAIN_BROKEN` (tamper/corrupt),
   `TENANT_ISOLATION_FAILURE` (RLS posture lost), `CLINICAL_INTEGRITY_FAILURE`
   (finalized history or linkage changed), `IDEMPOTENCY_MISMATCH` (record
   lost).
2. `AUDIT_CHAIN_BROKEN` or `TENANT_ISOLATION_FAILURE` after a restore means
   the SECURITY POSTURE did not survive — do NOT put the database into
   service; investigate artifact provenance and integrity.
3. Re-verify the artifact checksum against the recorded SHA-256 before
   considering the backup unusable.

## 8. Event backlog / notification failure

Symptom: notifications or integration deliveries appear stuck.

1. SDIS has NO standalone queue — notification events are written by the
   application (receipted boundary) inside the mutation's transactional
   unit; there is no external broker to drain.
2. A delivery failure surfaces as a typed application error on the request
   that caused it (`sdis_operation_total|…|failure` and the access log's
   `errorCode`) — diagnose via the correlation id on the failing request.
3. If a receiver needs a replay, re-issue the (idempotent) request with the
   same key — replays return the stored result without duplicating state.

## 9. Integration failure (external systems)

Symptom: `sdis_operation_total|…|failure` rises on integration operations.

1. The integration gateway is fail-closed by design (registry membership
   required). Check the correlation id, timestamp, and error CODE in the
   access log — never payload contents.
2. Credential problems (the caller's token) appear as 401; registry problems
   as fail-closed rejections with stable codes. Neither is logged with any
   secret material.
3. For repeated failures, capture the bounded metrics series
   (`sdis_http_requests_total|POST|4xx`) and the audit events for the
   integration actor — those identify the failing external system without
   exposing patient data.

## 10. Smoke testing after any intervention

After restore, failover rehearsal, or environment migration, run the §39
chain: `node --test dist/tests/app/smoke.test.js` against a DISPOSABLE
database (the suite provisions its own embedded PostgreSQL), or point a
scratch instance at the restored database and repeat the chain manually:
`/healthz` → `/readyz` → auth (401 without credentials) → tenant scope →
patient → order → specimen/accession → result → QC hold/release → finalize →
inventory → audit present.

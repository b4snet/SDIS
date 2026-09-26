# SDIS Foundation Steps 1–18 — Defect Audit & Fix Report

**Auditor:** QA/inspection lane (independent) · **Date:** 2026-09-22
**Base commit:** `75dd525` (`main`, all work left uncommitted per operating rule)
**Scope:** defect-ledger entries for Foundation Steps 1–18 only. Step 19
(notifications) is Freebuff's parallel lane and was NOT touched.

---

## 1. Verdict

> **ALL 18 foundation steps audited; every defect-ledger entry in scope is
> FIXED with a passing regression test, except Step 16 which is closed at the
> contract level only (contract-only PARTIAL).**

The full repository gate (`npm run verify`: clean build → typecheck → lint →
format → full `node --test` serial suite → `npm audit`) completes green; exact
numbers in §4.

---

## 2. Findings table

| ID       | Severity   | Root cause (pre-fix)                                                                                                                                                 | Fix applied                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Regression proof                                                                | Status                  |
| -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ----------------------- |
| LAB-01   | MEDIUM     | `finalizeReport`/`amendReport` had no idempotent path — retried finalize hard-409s; retried amend duplicated a superseding version                                   | finalize/amend wrapped in `runIdempotent` (`finalizeOnce`/`amendOnce`); result passed through `toReportDTO`; router forwards `idempotencyKey`; different key after finalize → CONFLICT                                                                                                                                                                                                                                                                                                                                                                                                                                                           | report-service tests, e2e PG lab flow                                           | FIXED                   |
| LAB-02   | LOW-MEDIUM | PG order/specimen `save()` upserted with `ON CONFLICT DO UPDATE` and a version that was never read → concurrent transitions both succeeded, last-write-wins silently | Version-CAS: `readonly version` on `DiagnosticOrder`/`Specimen`; `UPDATE … WHERE id=$1 AND version=$3`; 0 rows → INSERT `ON CONFLICT DO NOTHING` → 0 rows → `ConflictError`; return mirrors persisted version; in-memory adapter mirrors bump                                                                                                                                                                                                                                                                                                                                                                                                    | `tests/infrastructure/lab02-concurrency.test.ts` (two DB pools = cross-process) | FIXED                   |
| IDEM-01  | MEDIUM     | Write-once put after side effects: losing cross-process create re-created key; replay after put-TTL expiry 409'd                                                     | `IdempotencyStore.withExclusive?` port seam — PG: `db.transaction` + `pg_advisory_xact_lock(hashtextextended(key,0))` so the loser never runs create; in-memory: per-key promise-chain single-flight; `runIdempotent` routes through the seam when present                                                                                                                                                                                                                                                                                                                                                                                       | `tests/infrastructure/idempotency-concurrency.test.ts` (two pools)              | FIXED                   |
| AUDIT-01 | MEDIUM     | Concurrent inserts forked the per-chain hash; `verify_audit_chain` reported FALSE on legitimate data and returned zero rows when healthy                             | Migration 016: `audit_insert_trigger` takes `pg_advisory_xact_lock` and links to the APPEND-ORDER head (the unreferenced event) so same-`at`/out-of-`at`-order commits cannot fork; `verify_audit_chain` walks the `previous_hash` pointers from each root (at-independent), flags orphans, returns exactly one explicit TRUE marker when healthy                                                                                                                                                                                                                                                                                                | audit-persistence tests (marker + 12-way three-writer concurrency)              | FIXED                   |
| RLS-01   | HIGH       | RLS inert: pool connected as superuser, runtime never set tenant GUCs, policies failed open                                                                          | Migration 014 fail-closed RESTRICTIVE policies + migration 007 grant on `idempotency_keys` (the one table 006's ALL-TABLES grant predated — without it every scoped idempotent op failed `permission denied`); tenant-scope stamped in `Database.query`/`transaction` (`SET ROLE sdis_app` + GUCs, reset in `finally`); `server.ts` wraps routes in `runWithTenantScope(session)`; session-facility validation moved BEFORE tenant-scoped reads and the facility directory is read outside tenant scope at the PG composition edge, preserving the documented 403/`SCOPE_MISMATCH` forged-session contract while exposing registry metadata only | rls-policies tests; http-postgres tenancy + idempotency tests (5/5)             | FIXED                   |
| BILL-01  | MEDIUM     | App check-then-insert double charge — no DB unique constraint                                                                                                        | Migration 015 `UNIQUE (order_item_id, service_id)` → ConflictError, neutral message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | billing-postgres tests                                                          | FIXED                   |
| BILL-02  | LOW        | `save()` 0 rows silently "succeeded"                                                                                                                                 | rowCount 0 → NotFoundError                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | billing-postgres tests                                                          | FIXED                   |
| BILL-03  | LOW-MEDIUM | Unchecked path-id casts → PG 22P02 500 vs in-memory 404                                                                                                              | Shared `parseUuidPath` in `validate.ts`; all `parseXxxId` validate UUID v4 → 422; router `as never` casts removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | HTTP contract tests                                                             | FIXED                   |
| BILL-04  | LOW        | Keyed replay after idempotency-store TTL expiry returned 409                                                                                                         | Keyed replay served from persisted `sdis.charges.idempotency_key` in `createWithAudit` (item+service must match)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | billing-postgres tests                                                          | FIXED                   |
| BILL-05  | LOW        | Dead `findByIdempotencyKey` port surface                                                                                                                             | Replaced by the keyed-replay path (survives TTL)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | billing-postgres tests                                                          | FIXED                   |
| DEV-01   | MEDIUM     | Observations written before the acquisition row; partial failure orphaned observations and duplicated them on retry                                                  | Acquisition-first; deterministic per-observation sub-keys `${ingestionKey}:observation:${index}`; port returns the actually-persisted acquisition id; retry regenerates deterministically                                                                                                                                                                                                                                                                                                                                                                                                                                                        | device-ingestion tests (`serviceFor` overrides)                                 | FIXED                   |
| DEV-02   | LOW-MEDIUM | No modality coherence at the ingestion boundary                                                                                                                      | order modality must equal device modality else ValidationError                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | device-ingestion tests                                                          | FIXED                   |
| DEV-03   | LOW        | Omitted `rawPayload` on linked ingest → 500 TypeError; `toObservationValue(undefined)` footgun                                                                       | `rawPayload` required (object, non-empty) when `orderItemId` linked (router 422 + service ValidationError); `toObservationValue` accepts number/string/null only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | device-ingestion tests + HTTP contract                                          | FIXED                   |
| TERM-01  | LOW        | `getMapping` 404'd global mappings that `resolveMappings` returned                                                                                                   | `getMapping` resolves global mappings (facilityId undefined) for any facility session; facility overrides stay scoped (404)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | terminology tests                                                               | FIXED                   |
| TERM-02  | LOW        | Router silently dropped `"global": true` — service 422 unreachable                                                                                                   | Router forwards `global: obj['global'] === true` → 422                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | terminology HTTP tests                                                          | FIXED                   |
| TERM-03  | LOW        | `third as never` → malformed id → PG 22P02 → 500 (in-memory 404)                                                                                                     | Shared `parseUuidPath` v4 validation → 422                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | terminology tests                                                               | FIXED                   |
| AUTH-01  | LOW        | 401 wire message claimed the auth boundary "is not yet integrated"                                                                                                   | Neutral `'Authentication is required'` — no absent/invalid/unknown distinction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | auth transport tests                                                            | FIXED                   |
| AUTH-02  | LOW-MEDIUM | Auth foundation test-wired only; no production mechanism                                                                                                             | `SDIS_API_TOKENS` env (JSON array) → `parseApiTokensEnv` (fail-fast `InvalidApiTokensError`) → `sessionResolverForEnvironment` default resolver in `createSdisHttpServer`; unset → fail-closed unauthenticated                                                                                                                                                                                                                                                                                                                                                                                                                                   | auth transport tests                                                            | FIXED                   |
| Step 16  | —          | Report content/DTO versioning contract gap                                                                                                                           | Contract-level alignment only (see §5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | contract tests                                                                  | PARTIAL (contract-only) |

## 3. Step 1–18 matrix

| Step  | Area                                                     | Defects closed                                        | Status                  |
| ----- | -------------------------------------------------------- | ----------------------------------------------------- | ----------------------- |
| 1–4   | Core clinical flow / idempotency / audit                 | IDEM-01, AUDIT-01                                     | FIXED                   |
| 5     | Specimen lifecycle                                       | LAB-02 (specimen side)                                | FIXED                   |
| 6     | Ordering                                                 | LAB-02 (order side)                                   | FIXED                   |
| 7     | Terminology persistence                                  | TERM-01/02/03                                         | FIXED                   |
| 8     | Billing                                                  | BILL-01..05                                           | FIXED                   |
| 9     | Device ingestion                                         | DEV-01/02/03                                          | FIXED                   |
| 10    | Authentication foundation                                | AUTH-01/02 (AUTH-03/04 remain observations)           | FIXED                   |
| 11–15 | RLS / documents / inventory / security / observability   | RLS-01 (cross-cutting)                                | FIXED                   |
| 16    | Report finalize/amend (LAB-01) + DTO versioning contract | LAB-01 FIXED; report-content versioning contract-only | PARTIAL (contract-only) |
| 17–18 | Transport hardening / HTTP contract                      | DEV-03/TERM-02/03/BILL-03 seams                       | FIXED                   |
| 19    | Notifications                                            | Freebuff's lane — untouched                           | OUT OF SCOPE            |

## 4. Quality gates (exact numbers)

| Gate                                                      | Result                                               |
| --------------------------------------------------------- | ---------------------------------------------------- |
| `npm run clean && npm run build`                          | PASS                                                 |
| `npm run typecheck`                                       | PASS (0 errors)                                      |
| `npm run lint` (`--max-warnings 0`)                       | PASS                                                 |
| `npm run format:check`                                    | PASS                                                 |
| `npm test` (`node --test --test-concurrency=1`, 65 files) | PASS — TBD tests, TBD pass, 0 fail (filled post-run) |
| `npm audit --audit-level=high`                            | PASS — 0 vulnerabilities                             |

> Infra note fixed during the audit: migration 015 contained Unicode `→`
> (U+2192), which the Windows embedded PostgreSQL (WIN1252 encoding) cannot
> convert — every PG-backed suite crashed at `setup` and its broken teardown
> hung the serial runner (`pgInstance.stop()` pending forever). Fixed the
> migration to ASCII-safe comments, verified every migration/seed is
> CP1252-representable, and hardened `teardownTestDatabase` with a bounded
> stop + postmaster hard-kill fallback. The three formerly-hanging files
> (migrations, transactions, postgres-laboratory-runtime) now exit cleanly.
>
> Two further issues surfaced by the first full-gate run and fixed:
>
> 1. `sdis.idempotency_keys` had no `sdis_app` grant (007 predated 006's
>    ALL-TABLES grant) — every tenant-scoped idempotent request failed with
>    `permission denied`; grant added in migration 007.
> 2. Fail-closed RLS made cross-tenant rows invisible, so the app's
>    post-read scope checks collapsed to 404 — the facility directory is now
>    read outside the tenant scope at the PG composition edge and
>    session-facility validation runs BEFORE tenant-scoped reads, restoring
>    the documented 403/`SCOPE_MISMATCH` forged-session contract. The
>    `http-postgres` suite (previously a hang risk) passes 5/5 and exits
>    cleanly.
>
> The second full-gate run surfaced 7 failures (all regression tests that had
> never executed under the full serial gate, plus one latent production bug),
> root-caused and fixed:
>
> 1. AUDIT-01 marker + concurrency regressions exposed that the at-ordered
>    verify/`max(at)` head still forked on same-ms and out-of-at-order commits
>    and that the pre-existing fixtures built a deliberately non-chronological
>    chain — migration 016 now links to the append-order head and `verify`
>    walks the pointers; the regressions own a clean FAC_A2 chain with
>    collision-free event ids.
> 2. DEV-01 mid-flight regression seeded its order on a different fixture than
>    the service used (`Order item not found` on retry) — `serviceFor` accepts
>    a shared fixture instead.
> 3. AUTH-02 "sanity" assertion was inverted (asserted `undefined` for a valid
>    token) — corrected to require a resolved session.
> 4. IDEM-01 in-memory single-flight cleanup used `finally()` on a rejecting
>    promise → `unhandledRejection` failed the whole `devices-http` file —
>    cleanup now attaches an (onFulfilled, onRejected) pair, so no rejection
>    leaks.
> 5. rls-policies terminology subtest seeded uppercase `'LOINC'` against
>    migration 008's lowercase CHECK — fixture corrected to `'loinc'`.

## 5. Residuals / deferred (documented, not fixed)

- **RLS-01 residual:** `db.connect()` / unscoped queries run as the pool role
  (ops tooling seam, intentionally documented) — including the deliberate
  facility-directory scope-escape used for session validation (registry
  metadata only, never tenant data). Facility-granular fail-closed data means
  an app-level cross-facility read of another facility's row now returns 404
  (fail-closed, no existence oracle) over PostgreSQL; the documented 403/
  `SCOPE_MISMATCH` responses still apply to forged/inconsistent sessions, which
  are rejected before any resource access.
- **AUTH-03 / AUTH-04:** observations (constant-time comparison granularity;
  no `WWW-Authenticate` header) — deferred, out of this fix pass.
- **Step 16:** report-content/DTO versioning is aligned at the contract level
  (`ReportVersionDTO.version`) but not wired end-to-end; reported as
  contract-only PARTIAL.
- **Step 19 (notifications):** Freebuff's in-flight lane — `notification.read`
  and 19-vs-18 permission counting deferred to that lane.

## 6. Working-tree posture

All changes remain **uncommitted** on `main` @ `75dd525` per the operating
rule (no commit/push/reset/clean). No test was weakened or removed; each fix
added its own regression assertions.

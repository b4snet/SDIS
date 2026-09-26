# SDIS Development Log

Chronological record of meaningful repository changes.

## 2026-09-22 — Step 20: External integration & HMS interoperability foundation (external-system identity → correlation → inbound results)

Extended the Step-17 gateway without duplicating it: (1) `sdis.external_systems`
(migration 017) formalizes external-system identity — the gateway now refuses any
system that is unregistered or not ACTIVE before touching a payload, closing the
gap where the adapter list alone was the authority; `config_ref` is a non-secret
reference, credentials/secret management documented as a deferred dependency.
(2) `sdis.order_external_references` (append-only, per-system uniqueness) closes
the Step-17 documented gap: the external caller's order id is now PERSISTED and
resolvable back through the new `ORDER_EXISTS` outbound correlation operation,
returning the canonical DTO annotated with `externalSystem`/`externalOrderRef` —
canonical ids are never overwritten. (3) The `INBOUND_RESULT` boundary maps an
external result onto a canonical OBSERVATION through the existing observation
service (scope/specimen/idempotency/provenance stay enforced there) — no vendor
formats, no analyzer integration, no invented clinical validation. (4) RBAC gains
`integration.manage` (manager tier) for registry administration. Tests: +9
application, +3 HTTP, +3 PostgreSQL; proven: registry fail-closed behavior
(disabled/unregistered/foreign-tenant), per-system reference uniqueness, idempotent
inbound results, outbound mapping without mutation.

## 2026-09-22 — Step 19: Notifications & event delivery foundation (event → publisher → channel adapter → receipts)

- Baseline: Step-18 tree uncommitted; fresh verify green (**533 pass / 123
  suites / 0 fail / 0 vulnerabilities**). No event/notification system
  existed (only a `NOTIFICATION_SETTING` setup-config family string).
- New `src/app/notifications/notification-service.ts`: schema-versioned event
  envelope (event id, bounded type, aggregate reference, server-derived
  org/facility scope, correlation id, source kind/label, bounded string
  metadata — never clinical payloads); `emit()` validates session scope +
  per-type capability permission, fans out synchronously to registered
  `NotificationChannelAdapter`s, and records per-event receipts
  (`DELIVERED`/`REJECTED`/`FAILED` + failure category); adapter crashes are
  recorded failures, never thrown at the producer. `getDelivery` is a
  permission-gated, scope-checked read model. `recordNotificationAudit`
  reuses the ONE append-only audit system. Dedup identity
  (`notification.delivery:<event>:<channel>:<attempt>`) is provided for the
  existing `runIdempotent` engine — no second idempotency system.
- `InMemoryNotificationAdapter` (test/development): deterministic delivery
  with programmable rejection/failure; real providers remain documented
  adapter targets (SMS/email/WhatsApp/push NOT implemented).
- Runtime wiring: the PostgreSQL runtime composes `notifications` with one
  in-memory adapter (infrastructure edge). Transport: two minimal read-only
  routes (`/api/v1/notifications/deliveries/{eventId}` with UUID-v4 422
  validation, `/api/v1/notifications/event-types`); the event bus itself is
  NOT exposed over HTTP. RBAC: `notification.read` added to the viewer tier
  (catalog now 19 permissions).
- Tests: 10 application (model, publisher, metadata bounds, adapter
  reject/fail, no-silent-dedup, dedup identity with the real store, RBAC
  denial, tenant/facility receipt isolation, audit, end-to-end "order created
  → event → adapter without changing authoritative order state") + 4 HTTP
  (200/403/404/422/401, no SQL/stack leakage).
- Deliberately absent: no outbox (no durable mutation is coupled to delivery
  in this phase), no retries/queues, no clinical alert rules, no templates.

## 2026-09-22 — Step 18: Backup, recovery & disaster-recovery hardening (deterministic backup → isolated restore → verified recovery)

- Baseline: `main`, Step-17 tree uncommitted; fresh verify green
  (**527 pass / 122 suites / 0 fail / 0 vulnerabilities**).
- New operational module `src/infrastructure/database/backup-restore.ts`:
  `createBackup` (deterministic artifact naming, refuses overwrite, SHA-256,
  empty-artifact guard), `restoreBackup` (artifact existence + checksum
  validated BEFORE `pg_restore --exit-on-error`; isolated disposable targets
  only — protected databases `sdis`/`sdis_dev`/`postgres` require the explicit
  `CONFIRM-IN-PLACE-RESTORE` token), `verifyRecovery` (required-table check,
  constraint/index/RLS-object counts, migration-state equality with zero
  pending, `sdis.verify_audit_chain` per (org, facility), tenant-isolation
  probes as the application role, finalized/amendment integrity, persisted
  idempotency validation).
- New `tests/infrastructure/recovery.test.ts` (6 tests): backup + checksum,
  restore into a DESTROYED database with full fingerprint equality against the
  source, application reuse of the restored database (scoped reads, new order,
  idempotent replay returning the pre-backup order, refusal to re-finalize a
  FINALIZED report, service-layer cross-facility rejection), explicit failure
  handling (missing artifact, corrupt artifact with matching checksum failing
  loudly inside pg_restore and leaving no `sdis` schema, unavailable server),
  protected-target refusal (incl. wrong token), and detection of a tampered
  audit hash chain on a restored database.
- Recovery-exposed pre-existing findings documented, NOT modified: (1) the
  audit hash trigger chains by insert order while verification replays by
  `at` order, so non-monotonic timestamps break chain verification; (2) with
  the facility GUC unset, the tenant policy OR-shape admits foreign-tenant
  rows for org-wide contexts; (3) permissive policies combine with OR, so
  intra-organization facility isolation is enforced at the service layer, not
  by RLS (proven there against the restored DB); (4) `pg_dump/pg_restore
--no-privileges` silently drops the `sdis_app` ACLs RLS depends on — the
  recovery tooling therefore preserves ACLs (the pre-existing
  `backup-restore.test.ts` was left untouched and still passes).
- `.gitignore` already excluded dumps/`tmp/`; no artifact can enter source
  control. No credentials in source, logs, or docs.

## 2026-09-21 — Step 17: Integration gateway foundation (external → adapter → canonical command → existing services)

Made the Step-1 interoperability boundary real: `IntegrationGateway`
(`src/app/integration/integration-gateway.ts`) with the `IntegrationAdapter`
and `IntegrationAdapterRegistry` ports, a `CanonicalCommand` union, and an
acknowledgement contract. The gateway orchestrates the EXISTING application
services — patient resolution/registration/reference attachment, diagnostic
order submission, order status, and report retrieval — so no business rule is
re-implemented and external systems can never reach a repository or the
database. Provenance: externally initiated mutations record the existing
`INTEGRATION` source kind (an adapter claiming HUMAN/DEVICE/SYSTEM is refused);
`PatientService` gained an optional `source` override for the same reason the
order service already had one. Audit: `IMPORTED` for inbound mutations and
`EXPORTED` for outbound retrieval on the existing append-only recorder, with
system name + correlation id only (never payloads or reference values).
Idempotency: the existing engine, with one new `integration.request` scope, so
a keyed retry duplicates no patient, order, reference, or audit event. Scope:
external references are scoped by the SERVER-derived facility; adapters cannot
assert scope. Reference adapter `HMS-SYNTHETIC` at the infrastructure edge
(synthetic; contacts nothing); the runtime registers ZERO external systems by
default. Three thin HTTP routes (`POST /api/v1/integration/requests`,
`GET /api/v1/integration/orders/{id}`,
`GET /api/v1/integration/reports/{id}`). No FHIR/HL7/DICOM/IHE/ATNA schema or
conformance claim. Tests: app 20, HTTP 10, disposable-PG 6.

## 2026-09-21 — Step 15: Master setup configuration foundation (scoped, versioned)

Made the existing master-setup contract
(`src/domain/master-setup/master-setup.ts`) a real capability for the two
configuration families this phase supports — `FACILITY` (facility-scoped
operational settings) and `DEPARTMENT` (settings on a department INSIDE the
session facility, reference-validated). New: migration
`013_setup_config_schema.sql` (append-only version rows, scope-unique on
(facility, family, department?, key, version), tenant+facility RLS, SELECT +
INSERT grants only — no UPDATE/DELETE), `SetupConfigService`
(`src/app/setup/setup-config-service.ts`: domain rule "every configuration
record is scoped and versioned" preserved literally, supported-family
allowlist, server-derived scope, secret-bearing key refusal, 8 KiB value
bound, optimistic `expectedVersion` guard so a concurrent change is never
silently overwritten, `runIdempotent` replay, audit without values),
in-memory + PostgreSQL repositories, four HTTP routes, `setup.read`/
`setup.manage` RBAC permissions (changes are manager-tier), and two dedicated
idempotency scopes. Deliberately NOT implemented: clinical families
(`REFERENCE_RANGE`, `TEST_CATALOG`, `UNIT`, `REPORT_TEMPLATE`), financial
families, user/role/permission administration, and families whose
authoritative source already exists elsewhere (`MODALITY`, `DEVICE`,
`DOCUMENT_TYPE`). No clinical semantics invented. Tests: app 20, HTTP 10,
disposable-PG 8.

## 2026-09-21 — Step 14: Laboratory inventory foundation (item → lot → movement ledger)

Made the existing inventory domain contract
(`src/domain/inventory/inventory.ts`) a real capability. New: migration
`012_inventory_schema.sql` (`inventory_items` with sku unique per facility,
immutable `inventory_lots` with lot number unique per item, APPEND-ONLY
`stock_movements` ledger with a signed-quantity sign check and a unique
idempotency key; tenant+facility RLS), `InventoryService`
(`src/app/inventory/inventory-service.ts`: item/lot registration, keyed stock
receipt, OUT/WASTAGE/RETURN movements, DERIVED balance — no balance column and
no second ledger, expiry reported as operational information only (never a
clinical usability rule, never an automatic block), insufficient stock
rejected with no partial movement), in-memory + PostgreSQL repositories, six
HTTP routes, `inventory.read`/`inventory.manage` RBAC permissions, and two
idempotency scopes. No procurement, accounting, supplier management, purchase
orders, or clinical decision logic. Tests: app 16, HTTP 10, disposable-PG 8.

## 2026-09-21 — Step 13: Document management foundation (metadata, storage boundary, resource links)

Made the existing document domain contract (`src/domain/documents/documents.ts`)
a real capability. New: migration `011_documents_schema.sql` (metadata only —
bytes never enter PostgreSQL; facility scope; FK-validated patient/order-item
links; tenant+facility RLS), `DocumentService`
(`src/app/documents/document-service.ts`: domain-rule validation via
`assertStorageSafety`, MIME allowlist, digest identity, scope + facility-
directory checks, `runIdempotent` replay, audit events), `DocumentContentStore`
port with in-memory and local-directory (`LocalDocumentContentStore`) infra
providers, in-memory + PostgreSQL metadata repositories, three HTTP routes
(`POST /api/v1/documents`, `GET /api/v1/documents/{id}`,
`GET /api/v1/documents/{id}/content` served through a dedicated binary
response — never JSON-wrapped), `document.read`/`document.create` RBAC
permissions (operator/manager create), and a dedicated idempotency scope.
No deletion path exists (domain defines no deletion lifecycle). No OCR,
document AI, PACS/DICOM, or standards conformance — none claimed. Tests:
app 14, HTTP 8, disposable-PG 8.

## 2026-09-21 — Step 12: Observability foundation (logs, metrics, health; provider-neutral, opt-in)

Added `src/core/observability/` — a dependency-free operational edge:
`createLogger` (single-line JSON; ALLOWLIST field redaction — credential keys
always dropped, unknown keys dropped, free text truncated; no body/PHI path),
`createMetricsRegistry` (bounded in-process counters: request totals by
method × status class, coarse duration buckets, operation outcomes over a
fixed vocabulary, dependency failures; no resource ids in any series), and
health probes (`liveness` process-local; `readiness` over injected probes
with a 2s timeout, failures mapped to status-only `unavailable`). The HTTP
server accepts `logger`/`metrics`/`readinessProbes` options (silent no-ops by
default): every request completion emits one structured access-log line
(correlation id, bounded route label, method, status, duration, error code —
never bodies) and one metrics observation. Added `GET /healthz` and
`GET /readyz` as root-scoped, session-free endpoints outside `/api/v1`
(liveness never queries a dependency; readiness 503s with status-only bodies).
Added `createPostgresReadinessProbe` over the EXISTING `Database` pool (one
`SELECT 1`; no second pool, no schema change). Reused the existing
correlation-ID mechanism unchanged. 32 focused tests across logger/metrics/
health units, HTTP contract, and disposable-PostgreSQL readiness (including
the dead-endpoint down-path with zero leakage). No exporter, tracing, or
monitoring integration; nothing clinical is measured. Prerequisite: closed
the Step-11 residue first (role claims on disposable-PG test sessions; 31
runtime tests restored) so this stage built on a green 362-test baseline.

## 2026-09-21 — Step 11: RBAC foundation (roles → permissions, fail-closed, scope-independent)

Added `src/app/authz/rbac.ts`: 12 stable permissions over the existing
capability surface, three neutral capability-tier roles (`viewer`, `operator`,
`manager`) in one authoritative `ROLE_PERMISSIONS` map, and a fail-closed
`AuthorizationService` (`assertPermission` denies missing session/roles,
unknown role, unknown permission; maps to the existing `403 FORBIDDEN` envelope
with no policy leakage). Roles ride the session as claims from the Step-10
credential binding (`claimedRoleResolver`) — no RBAC persistence, no user
administration. Wired into representative services (patient registration,
diagnostic orders, billing, device ingestion) before their scope checks, into
the PostgreSQL runtime composition, and surfaced via a `requireCapability`
accessor in the HTTP router. Scope remains mandatory and independent of role:
permission granted + wrong facility/org is still denied by the existing guards
(proven in tests). 15 focused engine tests; disposable-PG sessions updated to
declare role claims, matching production credential bindings (31 previously
failing runtime tests restored to green). All existing security/401/403
behavior unchanged.

## 2026-09-21 — QA round: laboratory core flow, idempotency store, audit hash chain (evidence-backed, no live-layer changes)

Independent verification (QA lane) of the settled Steps 1–6 laboratory surface
(order/specimen/observation/interpretation/report services, `lab-flow.ts`, PG
repositories), the idempotency store, the audit hash chain (migration 005),
patient identity (Step 6), the transport contract, and the secrets sweep —
against disposable PostgreSQL (ports 55452–55455). All findings reproduced
empirically; no live code changed.

- **[MEDIUM] Report finalize/amend have no retry-safe idempotent path**
  (LAB-01). `createReport` replays correctly with a key, but `finalizeReport`
  (positional args, no key) throws `ConflictError("already finalized")` on a
  retry instead of returning the final state, and `amendReport` (no key in
  `AmendedReportInput`) mints a fresh version UUID per call — a network-retried
  amend produced a duplicate superseding version v3 identical to v2
  (`distinct version ids=3, distinct contents=2` proven on PG runtime).
  Suggested fix: idempotency keys for amend + finalize (replay → stored
  result).
- **[LOW-MEDIUM] Order/specimen transitions are lost-update-prone** (LAB-02).
  `PostgresOrderRepository.save`/`PostgresSpecimenRepository.save` upsert with
  an unconditional `status = EXCLUDED.status` (no CAS), and `version` is
  incremented but never read for locking ("version handling simplified",
  repositories.ts L433). Two concurrent transition writers both validate
  against their stale snapshot; the last write wins and can regress status.
  Suggested fix: `WHERE version = $prev` (or status CAS) + ConflictError on
  staleness.
- **[MEDIUM] Idempotency unit is not atomic with its side effects** (IDEM-01).
  `runIdempotent` = get → create (multiple independent writes: row + audit) →
  put, with no transaction, advisory lock, or single-flight map; the PG put is
  write-once conditional and silently DROPS the losing result (proven: second
  `put(k, v2)` leaves `{n:1}` stored). In-process `Promise.all` same-key
  registrations happened to serialize (single row — the window is
  timing-masked), but two processes sharing the store would both create and
  orphan the loser's row — same family as DEV-01/BILL-01. Suggested fix:
  commit the idempotency key atomically with the domain row (transaction seam)
  and/or a per-key advisory lock.
- **[MEDIUM] Audit hash chain forks under concurrent inserts** (AUDIT-01).
  Migration 005's trigger chains each event to the last COMMITTED event per
  org/facility; two uncommitted concurrent inserts both pick the same head (or
  empty) → fork, and `verify_audit_chain` then reports mismatches on
  legitimate data (proven deterministically on disposable PG: 2 false mismatches
  from two concurrent inserts; append-only UPDATE/DELETE triggers verified
  working for every role). Secondary: a healthy non-empty chain returns ZERO
  rows — indistinguishable from an empty chain. Suggested fix: serialize the
  head read (advisory xact lock per chain) and emit an explicit healthy marker.
- **Verified solid (no defect):** patient duplicate-reference rejection is
  DB-backed (`UNIQUE (system, value, facility_id)` + 23505 → ConflictError);
  transport ordering (405/415/400/413/404, auth-before-routing, correlation-ID
  sanitization, error mapping) holds; the secrets-sweep test performs a real
  repository scan.
- **Noted, not audited as a phase:** Freebuff's in-flight RBAC wiring
  (`authz/rbac.ts`, `postgres-runtime.ts`, service authz hooks ~07:34–07:41,
  dist rebuilt 07:49) — re-audited when the phase lands.

## 2026-09-21 — QA round: Step-8 billing layer audit (evidence-backed, no live-layer changes)

Independent verification (QA lane) of the settled Step-8 billing slice
(migration 009, `billing-service.ts`, `billing-repository.ts`,
`in-memory-billing.ts`, the three `/api/v1` charge routes, and the billing
test suites) against disposable PostgreSQL. All findings were reproduced
empirically against the disposable PG on a scratch port (not committed, no
test added to the gate). No live billing-layer code was changed.

- **[MEDIUM] Check-then-insert duplicate-charge window (TOCTOU).** The service
  rejects "same item already charged for the same service" (CONFLICT), but
  migration 009 has NO `UNIQUE (order_item_id, service_id)` — only the
  idempotency key is unique. Two concurrent requests (each with a distinct —
  or absent, `charge:<uuid>`-generated — key) both pass the empty
  `listByOrderItem` check and both INSERT. Empirically proven: two direct
  INSERTs of the same (item, service) with different keys both persisted
  (2 rows). Keyed replays stay safe (store + schema), but the app's own
  one-charge-per-item-per-service rule is not durable. Suggested fix: add the
  unique constraint in a follow-up migration (Freebuff/architecture lane).
- **[LOW] `PostgresChargeRepository.save` silently succeeds on a
  non-existent order item.** The `INSERT ... SELECT ... WHERE oi.id = $2`
  writes 0 rows and returns the charge as if persisted — no rowcount guard.
  Empirically proven (save resolved, 0 rows persisted). Latent today (the
  service validates item membership first), but the repository gives no
  signal when the join yields nothing. Suggested fix: require an affected-row
  result and throw.
- **[LOW-MEDIUM, shared] Unchecked path-id casts → 500 (PG) vs 404
  (in-memory) on malformed ids; body ids are 422-validated.** `parseXxxId`
  in `src/transport/validate.ts` are plain `as` casts; every GET-by-id route
  (charges included) passes the raw path segment into the DB, and PG raises a
  raw `22P02` DatabaseError that the router collapses to 500 INTERNAL, while
  the in-memory adapters return 404 NotFoundError. POST bodies validate via
  `requiredUuid` → 422. Empirically proven: `getCharge('not-a-uuid')` threw
  `DatabaseError 22P02`, not NotFoundError. Suggested fix: make the shared
  id-parsers UUID-validate (throw ValidationError), aligning path/body
  handling.
- **[LOW] Keyed replay after idempotency-store expiry (24 h) returns
  CONFLICT, not the stored first result.** Store `get` filters
  `expires_at > now()`; after expiry the duplicate-service guard fires
  (`ConflictError`), so the same key+payload returns 409 instead of the
  200 + stored-result from inside the window. Empirically proven by expiring
  the store row and replaying. Ledger safety holds (no duplicate row), but
  wire behavior varies with time and `docs/API_CONTRACTS.md` doesn't document
  the window. Suggested fix: document the window, or serve post-expiry
  replays from `sdis.charges.idempotency_key` (which never expires).
- **[LOW] Dead port surface:** `findByIdempotencyKey` is implemented in both
  adapters but never called — a design hint that replays were meant to be
  served from the ledger row itself, which would eliminate the expiry window.
- **Observation (not a defect):** there is no creation API for
  `billable_services` (only a read view) — the catalog is ops-seeded SQL by
  design ("infrastructure only" per migration 009).

Fixable-in-lane options offered but not yet applied: the shared id-parser
validation (validate.ts), a `save()` rowcount guard (billing-repository), and
a `UNIQUE (order_item_id, service_id)` migration — the latter two touch the
settled Step-8 layer, so they await an explicit order. **All findings recorded
in `docs/QA_DEFECT_LEDGER.md` (BILL-01…BILL-05); fixes HELD pending FIX MODE.**

## 2026-09-21 — QA round: Step-9 device-ingestion audit (evidence-backed, no live-layer changes)

Independent verification (QA lane) of the Step-9 device-ingestion slice
(migration 010, `device-ingestion-service.ts`, `device-repository.ts`,
`in-memory-devices.ts`, the `POST /api/v1/devices/{deviceId}/acquisitions`
route, and the three device test suites) against disposable PostgreSQL.
Coverage is good (hooks wired through `setupTestDatabase` — no phantom-pass
relapse; 404 on unregistered device, facility boundaries, forged tenant,
DEVICE provenance preserved verbatim, durable happy-path replay, IMPORTED
audit all verified). Three new findings were reproduced empirically; fixes are
HELD and recorded in `docs/QA_DEFECT_LEDGER.md` (DEV-01…DEV-03):

- **[DEV-01 · MEDIUM · architecture decision] Non-atomic side-effect
  ordering.** `ingestOnce` enters OBSERVATIONS before persisting the
  acquisition row (the durable record of the ingestion), with no transaction
  across the two. Repro: with `saveAcquisition` forced to throw, the first
  call leaves 1 orphaned observation and 0 acquisition rows; the same-key
  retry (the idempotency store never recorded the failed result) succeeds but
  leaves **2 observation rows** — directly contradicting the documented
  "replay repeats NO side effect". Fix spec: acquisition-first +
  derive-observations-from-stored-`raw_payload` on key-collision replay, or a
  unit-of-work transaction.
- **[DEV-02 · LOW-MEDIUM · architecture decision] Modality coherence gap.** A
  LAB device can ingest observations onto an ECG order item; `enterObservation`
  is structural-only (scope/patient/fields) and `ingestOnce` never compares
  `device.modality` to `order.modality`. Repro: LAB device + ECG order item →
  observation row created.
- **[DEV-03 · LOW · fixable] Omitted `rawPayload` on a linked ingestion
  collapses to 500.** Router passes `obj['rawPayload'] ?? undefined`; the
  production adapter shape (`a.rawPayload.glucoseMgDl`) then throws a raw
  TypeError → 500 INTERNAL instead of 422. Also `toObservationValue(undefined)`
  would map to TEXT `"undefined"` instead of rejecting. Fix spec: require
  `rawPayload` for linked ingests; tighten the value mapping.

No live layer code changed; gate state unchanged (last full run green).

## 2026-09-21 — QA round: Step-7 terminology + cross-cutting RLS audit (evidence-backed, no live-layer changes)

Independent verification (QA lane) of the Step-7 terminology persistence
surface (migration 008, `terminology-service.ts`, PG + in-memory adapters,
3 routes, 35-test suite) and — discovered during it — the repository-wide RLS
enforcement posture. All findings reproduced empirically on disposable PG
(ports 55451) and over HTTP; recorded in `docs/QA_DEFECT_LEDGER.md`
(TERM-01…TERM-03, RLS-01), fixes HELD:

- **[TERM-01 · LOW · fixable] Global mappings unreadable by id.** A seeded
  global mapping (`facility_id NULL`) is returned by `resolveMappings` but
  `getMapping` throws NotFoundError for the same id and session
  (`facilityId !== session.facilityId` treats `undefined` as out-of-scope).
  Latent (global creation not exposed over HTTP), verified by proof script.
- **[TERM-02 · LOW · fixable] `"global": true` silently dropped at the
  router.** HTTP POST returns 201 at the session facility; the service's
  scope-escalation guard (422) is unreachable over HTTP — router never
  forwards the field.
- **[TERM-03 · LOW · fixable] Malformed mapping id:** `third as never` cast
  → PG `22P02` → raw DatabaseError → 500 INTERNAL; in-memory adapter 404s the
  same input. Same shared-cast family as BILL-03.
- **[RLS-01 · HIGH · architecture decision] Database-level tenant isolation
  is INERT in every shipped configuration.** Empirically: (1) every PG suite
  and the shipped default connects as superuser `postgres` → RLS bypassed;
  (2) the documented `sdis_app` role with NO tenant GUC — nothing in the
  runtime ever sets one; `Database.withTenantContext` has zero call sites —
  reads 3/3 cross-tenant rows AND inserts a row for another org's facility
  (fail-open read + write; permissive policies combine with OR and the
  vacuous facility policy re-opens the tenant boundary); (3) only
  `sdis_app` + GUCs — a configuration no test or code path exercises —
  segregates correctly. `tests/infrastructure/rls-policies.test.ts` asserts
  only `pg_policy` metadata with the self-admitted comment "This test would
  need to run as sdis_app role with GUCs set." API-layer service filters
  still hold (service-level isolation proven), so this is a defense-in-depth /
  claim-integrity gap today, but the documented "database-level guarantee" is
  absent in every deployable state. Architecture decision required (wire the
  tenant context; fail-closed policy shape; sdis_app+GUC integration tests).

No live layer code changed; gate state unchanged (last full run green).

## 2026-09-21 — QA round: Step-10 auth audit (evidence-backed, no live-layer changes)

Independent verification (QA lane) of the Step-10 authentication foundation
(`src/transport/auth.ts`, the `SessionResolver` seam, `createSdisHttpServer`
wiring, and the 14-test auth suite) over real HTTP. Baseline verified: the
suite count of 14 is accurate (2 extraction + 5 resolution + 1 scope + 6 HTTP);
fail-closed 401 posture, malformed-material rejection (control chars, wrong
scheme, absurd length), scope-from-binding separation, 201-with-actor record,
and no-leak assertions are genuinely exercised. Findings reproduced
empirically over HTTP (`qa-auth-repro.cjs`), recorded in
`docs/QA_DEFECT_LEDGER.md` (AUTH-01…AUTH-04), fixes HELD:

- **[AUTH-01 · LOW · fixable] Stale 401 wire message.** With the credential
  boundary wired exactly as the Step-10 tests do, every 401 body still says
  "authentication boundary is not yet integrated" (valid token → 201 works,
  so the boundary IS integrated). Message lives in `requireResolvedSession`
  (session.ts) and is placed on the wire by `serializeError`.
- **[AUTH-02 · LOW-MED · architecture decision] No production wiring /
  doc-vs-code gap.** `createSdisHttpServer` still defaults to
  `unauthenticatedSessionResolver`; the only credential source is the
  in-memory `constantTimeDirectory` factory. SECURITY §6 / API_CONTRACTS §9
  say bindings are "external configuration (DEPLOYMENT §3)" and DEPLOYMENT §3
  says "all configuration is validated at startup, fail-fast" — neither has an
  implementation in `src/`.
- **[AUTH-03 · observation] "Constant time" is per-comparison only.**
  `constantTimeDirectory` iterates with `.find` early-exit + a length
  pre-check; timing discloses configured-token lengths/order. Fail-closed
  behavior not affected.
- **[AUTH-04 · observation] No `WWW-Authenticate: Bearer` on 401s** —
  documented intent (SECURITY §7); RFC 6750 suggests it for bearer schemes.

No live layer code changed; gate state unchanged.

## 2026-09-21 — Step 10: Authentication Foundation & Session Resolution

- Baseline re-verified after finishing the interrupted Step-9 cleanup:
  333/333 across 75 suites. Discovery: the `SessionResolver` seam
  (`src/transport/session.ts`) shipped fail-closed with authentication
  deferred; `docs/SECURITY.md` §2 plans "token-based for APIs" — the smallest
  concrete form of that plan was implemented rather than a new protocol.
- `src/transport/auth.ts`: `Authorization: Bearer` credentials resolved
  through an injected `CredentialDirectory` port into the EXISTING
  `ApplicationSession` (actor + server-derived org/facility scope).
  Constant-time token comparison; malformed material (control chars, wrong
  scheme, absurd length) and unknown tokens all resolve to no session → the
  existing 401 envelope. No passwords, OAuth/OIDC, SSO, MFA, refresh tokens,
  cookies, or RBAC — the §2 plan's later items remain future.
- Scope separation preserved: scope is a property of the principal's
  credential binding, never of the request; the existing scope guards
  (403 SCOPE_MISMATCH) continue deciding what an authenticated principal may
  reach. Audit untouched (no invented auth event categories); no DB changes.
- Credential bindings are external configuration (docs/DEPLOYMENT.md §3); the
  repository carries deterministic TEST-ONLY fixtures, no real secrets.
- Tests: 14 authentication tests (token extraction, fail-closed resolution,
  constant-time matching, scope separation, HTTP 401/403/201 integration,
  no-credential-leakage). Full gate: **347/347, 79 suites, 0 vulnerabilities,
  diff-check clean**.

## 2026-09-21 — Step 9: Device Ingestion & Acquisition Foundation

- Baseline re-verified: 306/306 across 72 suites (Step-8 state). Discovery:
  the device domain (`DeviceRegistry`, `DeviceAcquisition`, `DeviceAdapter`,
  `NormalizedResult`) existed with tests but had no persistence, application
  service, or transport; the specimen contract already serves modality
  acquisitions via kind ACQUISITION.
- Migration 010: `sdis.devices` (facility-registered, modality-bound) and
  `sdis.device_acquisitions` (raw payload verbatim in JSONB, adapter id,
  acquired/ingested timestamps, UNIQUE ingestion key), with
  migration-006-convention RLS policies. Forward-only, replay-safe.
- Application: `src/app/devices/device-ingestion-service.ts` composes the
  EXISTING `DeviceRegistry` (identity, adapter resolution, normalization) with
  a `DeviceIngestionRepository` port — no second device/modality registry.
  Devices are facility-bound: a payload can never escape its registration
  scope. Order-context linkage goes through the existing order service's
  scoped resolvers; normalized observations are created ONLY through the
  existing observation service (acquisition ≠ observation ≠ interpretation ≠
  report) with the ADAPTER's DEVICE provenance preserved verbatim (label +
  device-id ref). Keyed idempotency via the existing `runIdempotent`
  (`device.ingest`); IMPORTED audit event through the existing `AuditRecorder`.
- Transport: `POST /api/v1/devices/{deviceId}/acquisitions` via the existing
  conventions.
- Tests: 12 application + 7 disposable-PostgreSQL + 8 HTTP contract tests.
  Full gate: **333/333, 75 suites, 0 vulnerabilities, diff-check clean**.

## 2026-09-21 — Step 8: Billing Application Wiring & Diagnostic Charge Lifecycle

- Baseline re-verified: 269/269 across 66 suites (Step-7 state). Discovery:
  the billing domain (`src/domain/billing/billing.ts` — `Charge`, ledger
  idempotency-key semantics, no pricing policy) existed with tests; no
  application service, persistence, or transport. No billing schema existed.
- Migration 009: `sdis.billable_services` (facility-scoped catalog entries,
  recorded prices) and `sdis.charges` (order-item scoped, UNIQUE idempotency
  key per the domain ledger rule, scope `facility_id` for RLS), both with
  migration-006-convention RLS policies. Forward-only, replay-safe.
- Application: `src/app/billing/billing-service.ts` composes the EXISTING
  domain `Charge`/ledger semantics with a `ChargeRepository` port — no second
  billing model. Order linkage goes through the EXISTING order service's
  scoped `requireScopedOrder`/`requireScopedOrderByItem` (the order remains
  the authoritative workflow object); amounts are the billable service's
  recorded price verbatim (no tax/discount/insurance/payment logic — that
  policy gap is reported, not invented). Keyed idempotency via the existing
  `runIdempotent` (`charge.create`); audited via the existing `AuditRecorder`.
- Persistence detail proven by tests: the domain `Charge` intentionally has no
  scope field, so the PostgreSQL insert derives `facility_id` from the charged
  order item's owning order in a single INSERT...SELECT — RLS scope is never
  client-derivable and the domain contract stays untouched.
- Transport: three `/api/v1` routes (POST /charges, GET /charges/{id},
  GET /diagnostic-orders/{orderId}/charges) via the existing conventions.
- Tests: 14 application + 9 disposable-PostgreSQL + 10 HTTP contract tests.
  Full gate: **306/306, 72 suites, 0 vulnerabilities, diff-check clean**.

## 2026-09-21 — QA round: reactivated 5 phantom PostgreSQL suites; idempotency write-once fix

Independent verification (QA lane, no schema/service changes to live steps):

- **Phantom-pass cluster (HIGH)**: 34 PostgreSQL integration tests across 5
  suites (`postgres-repositories`, `audit-persistence`, `rls-policies`,
  `transactions`, `e2e-pg-lab-flow`) were silently passing with ZERO executed
  assertions. Their `before` hooks only set `PG*` env vars, never called
  `setupTestDatabase()`, so `getTestDb()` returned null and every `it` body
  early-returned. RLS existence, audit hash-chain/append-only enforcement,
  transaction/optimistic-concurrency, and repository CRUD were unverified.
  Reactivating them (setup + teardown hooks) surfaced and fixed:
- `PostgresIdempotencyStore.put` used `ON CONFLICT DO UPDATE` — a second put
  with a different value overwrote the first stored result, breaking the
  documented replay-returns-first-result contract. Now a conditional upsert:
  live keys are write-once, only expired keys are refreshable.
- `setupTestDatabase` self-heals stale `tmp/pg-test-<port>` dirs left by
  crashed runs (`initdb: directory exists but is not empty`).
- Test-fixture rot: non-hex UUID literals rejected by PG, FK-orphaned order
  items, an e2e db-wrapper lacking `connect()`, zero audit records where the
  test asserted ≥4, `pg_policy.schemaname` (non-existent column; now joined
  via `pg_class`/`pg_namespace`), and a DELETE test deleting a row it never
  inserted (insert id `a5`, delete id `a4`).
- e2e now records its audit trail through `PostgresAuditPort` (matching the
  app-layer behavior the assertion intended).

Gate: the 5 suites now run 34 real assertions against disposable PostgreSQL;
full suite **306/306 tests, 72 suites**, lint + format clean.

**Open (reported, deferred — needs a domain decision)**: migration 004's
`sdis.specimen_events` ("Specimen status transition history") is never written
by any code; the specimen upsert references `received_at`/`accepted_at`/
`processed_at`/`rejected_at` that no INSERT supplies. The domain `Specimen`
carries status only, so this is feature-scale (either persist events or drop
the schema promise) — Freebuff/architecture lane.

## 2026-09-21 — Step 7: Terminology Persistence & Mapping Store

- Baseline re-verified: 234/234 across 60 suites (Step 6 state), all gates
  green. Discovery confirmed the terminology domain contract
  (`src/domain/terminology/terminology.ts`: canonical/external code refs,
  known-vocabulary validation, facility-override resolution) existed with
  tests but had NO persistence, application service, or transport — the gap.
- Migration 008 (`db/migrations/008_terminology_schema.sql`): the smallest
  forward-only `sdis.terminology_mappings` table — UNIQUE (canonical, external
  system, external code, facility scope) mirroring the domain resolution rule,
  known-system CHECK constraint, updated_at trigger, RLS policies following
  migration 006 conventions (tenant policy sees global defaults + own-org
  facilities; facility policy hides other facilities' overrides), replay-safe
  under the existing runner.
- Application: `src/app/terminology/terminology-service.ts` composes the
  EXISTING domain vocabulary rules with a `TerminologyMappingRepository` port —
  no second terminology model. Facility overrides are always created at the
  session facility; global-scope creation from a facility session is rejected
  (no scope escalation); retrieval prefers the facility override then global,
  never another facility's override; cross-facility reads share the unknown-
  resource 404 (no existence leak). Keyed idempotency via the existing
  `runIdempotent` (`terminology.mapping.create`); duplicate probing happens
  inside the idempotent callback (patient-registration pattern) so replays
  return the stored result instead of a false CONFLICT. Audited via the
  existing `AuditRecorder` (detail kept ASCII — a `→` character failed the
  disposable PG's WIN1252 client encoding, caught by the PG tests).
- Persistence: `PostgresTerminologyMappingRepository` (23505 → CONFLICT) and an
  in-memory adapter with identical semantics; runtime composition root wires
  the service.
- Transport: three `/api/v1` routes (POST mappings, GET mappings/{id},
  GET resolve/{canonical}/{system}); router capabilities are now accessed
  through a `requireCapability` accessor whose absent capability is a 404 —
  same behavior as before, expressed once instead of per-route.
- Tests: 17 application + 8 disposable-PostgreSQL (migration-from-empty,
  persistence, 23505, facility/tenant boundaries, audit persistence, durable
  replay with no duplicate audit) + 10 HTTP contract tests. Backup/restore
  migration-count assertions updated 7 → 8 for migration 008. Full gate:
  **269/269, 66 suites, 0 vulnerabilities, diff-check clean**.

## 2026-09-23 - Step 26: SDIS Core Architecture Hardening

- **Audit findings (architectural drift)**: exactly two genuine boundary
  violations existed after 25 phases: (1) `src/transport/index.ts` re-exported
  `createPostgresReadinessProbe` from `../infrastructure/...`, and (2)
  `src/transport/server.ts` imported `runWithTenantScope` (PostgreSQL
  AsyncLocalStorage) directly, hard-wiring the RLS mechanism into the
  transport layer. Everything else audited clean: domain→domain leaks none;
  parameterized SQL throughout (no dynamic identifiers); one event
  abstraction (`NotificationBus`); stack-free error serialization;
  fail-closed session/scope/authorization seams intact.
- **Fix (dependency direction)**: transport now owns the request-scope SEAM
  (`src/transport/request-scope.ts`, `TenantScopeRunner` type);
  `createSdisHttpServer` accepts an injected `requestScopeRunner` (default
  pass-through, fail-closed for non-RLS deployments); the new composition
  edge `src/index.ts` binds the PostgreSQL implementation
  (`postgresRequestScopeRunner`, `postgresServerOptions`). The transport
  barrel is infrastructure-free.
- **Enforcement (new architecture tests)**:
  `tests/architecture/boundary-hardening.test.ts` proves as source-tree
  checks: transport never imports infrastructure; the composition edge is
  the only bridge; the barrel stays infrastructure-free; `process.env` is
  read only in a bounded allowlist (auth seam, server default selection,
  infrastructure process boundary); app/transport never write `console.*`
  (structured Logger only).
- **Regression proof**: the PG-backed HTTP suite now injects
  `runWithTenantScope` explicitly and still passes end-to-end (scoped RLS
  queries, cross-facility rejection) — the seam refactor did not weaken
  tenant isolation. Architecture (5/5 + 5/5), transport (20/20 auth), and
  all focused suites green.
- **Documentation**: `docs/ARCHITECTURE.md` §2.1 now states the canonical
  dependency direction, environment-access allowlist, and logging discipline
  as enforced rules (previously implicit).
- No migrations, no clinical behavior changes, no API contract changes.

## 2026-09-23 - Step 24: Master Setup & Configuration Management Foundation

- **Extended, not duplicated (IMPLEMENTED)**: Step 15 already delivered scoped,
  versioned configuration (FACILITY + DEPARTMENT families, append-only
  history, optimistic concurrency, secret refusal, HTTP, PostgreSQL/RLS) and
  canonical master data existed as facilities/departments/modalities/
  billable-services tables. Step 24 closed the genuine gaps:
- **Department master-data administration (VERIFIED)**: new
  `DepartmentService` over the EXISTING `sdis.departments` table - create /
  list / get / deactivate with per-facility code uniqueness (codes are stable
  identifiers, never recycled, even for deactivated departments),
  server-derived facility scope, migration **021** (`status` column with
  ACTIVE/INACTIVE CHECK, FK-preserving lifecycle; no physical delete).
  RBAC reuses `setup.manage`/`setup.read` - no second permission system.
- **Bounded configuration registry (VERIFIED)**: every key WITH OPERATIONAL
  BEHAVIOR is registered with a defined type, validator, and deterministic
  default (`worklist.defaultPageSize` 1-200 default 50; `worklist.includeHistory`
  default false). Registered keys are type+range validated at write time.
  Unregistered keys keep the Step-15 generic validation and are OPERATIONALLY
  INERT - no consumer path exists from configuration to clinical semantics.
- **Config-driven operational behavior (VERIFIED)**: WorklistService consumes
  the registered keys for paging and history inclusion only; ordering remains
  deterministic (priority rank, orderedAt, id) and never clinical triage.
  Absent configuration preserves pre-Step-24 behavior exactly (defaults).
- **Historical integrity (VERIFIED)**: configuration and master-data changes
  (create, version update, department deactivation) leave finalized reports,
  versions, and provenance byte-identical - proven in application AND
  PostgreSQL suites. Department-scoped configuration written while a
  department was ACTIVE remains resolvable after deactivation.
- **Tests (VERIFIED)**: application 16 (departments lifecycle/scope/RBAC/
  idempotency/audit, registry validation, worklist consumption, historical
  integrity), HTTP 9 (lifecycle, RBAC tiers, 401/403/404/409/422, versioned
  updates, idempotent replay), PostgreSQL 9 (migration 021, uniqueness at
  schema level, facility isolation, registry keys, historical integrity over
  real PG). Step-15 suites updated coherently (inert-key contract).
- **DEFERRED**: organizations/units/other master families, org-level scope,
  generic inheritance chain (explicit scoping instead), config-driven
  billing/device behavior, configuration administration UI.

## 2026-09-22 - Step 23: Diagnostic Document & Attachment Management Foundation

- **Extended, not duplicated (IMPLEMENTED)**: Step 13 already delivered the
  document model (branded ids, types, `DocumentLocation`, storage-safety
  rule), the `DocumentContentStore` port with in-memory + local-directory
  adapters, MIME/size/filename validation, SHA-256 identity, scope-validated
  resource links, idempotent upload, PG schema/RLS (migration 011), HTTP
  up/download, and audit. Step 23 closed the genuine gaps:
- **Lifecycle (VERIFIED)**: `ACTIVE | RETIRED` on the domain metadata,
  migration **020** (`status` CHECK + default, `patient_visible` flag,
  listing index). Retirement removes ACCESS only - metadata and bytes are
  retained (no physical deletion; retention is a governed process). One-way
  transition, idempotent (scope `document.retire`), audited `UPDATED`.
- **Content integrity (VERIFIED)**: retrieval now re-hashes the stored bytes
  and compares against the RECORDED digest embedded in the storage ref -
  tampered content surfaces as CONFLICT, never silently returned.
- **Explicit patient visibility (VERIFIED)**: `patientVisible` defaults to
  FALSE; a document is patient-accessible only when linked to the owned
  patient AND explicitly marked visible. Patient document access runs
  through the Step-22 ownership gate (binding -> canonical patient, new
  `patient.document.read` permission on the `patient` role only) with a
  patient-safe DTO that exposes no storage internals; foreign / non-visible /
  retired / unknown are the same 404. Content downloads are audited with the
  PATIENT actor.
- **Staff surface (VERIFIED)**: `GET /api/v1/patients/{id}/documents`
  (facility-scoped listing), `POST /api/v1/documents/{id}/retire`,
  `patientVisible` on upload; `GET /api/v1/patient/documents[...]` for the
  patient boundary. PG `save` became a targeted upsert (status/visibility/
  version) to make retirement durable.
- Tests: 11 application/security + 7 HTTP + 2 new PostgreSQL (10 total in
  the document PG suite). Full gate below.

## 2026-09-22 - Step 22: Patient Portal / Result Access Boundary Foundation

- **Patient principal (IMPLEMENTED)**: `ApplicationSession` with actor kind
  `PATIENT` + the new `patient` role (exactly one permission:
  `patient.report.read`). The `Actor` kind vocabulary and the
  `SDIS_API_TOKENS` actor-kind validation now admit `PATIENT`; no
  authentication protocol, token format, or OAuth flow was invented.
- **Ownership (VERIFIED)**: `PatientPrincipalRegistry` port resolves the ONE
  canonical patient identity per principal, server-side. PostgreSQL binding
  table `sdis.patient_principal_bindings` (migration **019**, which also
  widens the audit `actor_kind` CHECK with `PATIENT`). No binding owns
  nothing; client-supplied ids/demographics are never ownership proof.
- **Access service (VERIFIED)**: `PatientReportAccessService` -
  `listMyReports` / `getMyReport` over the CANONICAL report repository
  (`listByPatientAndFacility` added to the port + in-memory + PostgreSQL).
  FINALIZED versions only; DRAFT heads of amendments invisible; foreign /
  draft / unknown ids are the same non-leaking 404; patient-safe
  `PatientReportView` (no staff refs, no provenance, no workflow state).
- **Audit**: access events through the existing append-only path, action
  `VERIFIED`, object `patient-report-access`, actor kind `PATIENT`; report
  content never in audit detail. Provenance untouched (read-only).
- **HTTP**: `GET /api/v1/patient/reports` and `GET
/api/v1/patient/reports/{reportId}` under the existing router/session/
  RBAC/correlation/error envelope; runtime composition wires
  `patientReports` into the PostgreSQL runtime.
- Tests: 15 application/security + 6 HTTP contract + 4 PostgreSQL. Full
  gate below.

## 2026-09-22 — Step 21: Emergency & Critical Diagnostic Workflow Foundation

- **Emergency ≠ critical result.** Priority is an operational workflow
  attribute only: bounded domain vocabulary `ROUTINE | URGENT | EMERGENCY`
  (`src/domain/ordering/diagnostic-order.ts`), validated at creation and
  change, deterministic rank `EMERGENCY(0) < URGENT(1) < ROUTINE(2)`, default
  ROUTINE when unstated. No reference ranges, thresholds, panic values, or
  decision rules were introduced; the clinical-rule boundary (§8) is intact.
- Orders carry `priority` end-to-end: creation input validated via
  `assertOrderPriority` (wrapped as ValidationError 422 at the services),
  DTO field, PostgreSQL persistence (migration **018**: CHECK constraint,
  `ROUTINE` default with `NOT NULL` backfill, worklist index
  `(facility_id, priority rank, ordered_at, id)`), in-memory repository
  parity, lab-flow passthrough, and the HMS-SYNTHETIC adapter mapping.
- `changeOrderPriority`: audited (`UPDATED`, detail `priority X -> Y`),
  idempotent via the EXISTING engine (new scope `ORDER_PRIORITY_CHANGE`),
  state-guarded (historical once cancelled), no-op returns the DTO without a
  duplicate audit row. `WorklistService` is a read model over the
  authoritative order repository with deterministic ordering — explicitly
  NOT clinical triage — now asserting `ORDER_READ` like every other read
  path (fail-closed).
- Transport: `GET /api/v1/worklist` and
  `POST /api/v1/diagnostic-orders/:id/priority` under the existing session /
  RBAC / scope / correlation / error-envelope conventions; priority accepted
  on order creation. Malformed order ids fail 422 at the boundary.
- Encounter context unchanged: existing encounter model reused as-is; no
  ED module, triage, or bed management introduced. Emergency events remain
  future work via the Step-19 notification boundary (ARCHITECTURE-READY).
- Tests: 4 domain + 15 application (incl. clinical-safety invariants:
  priority never reaches observation/interpretation/report content,
  finalized reports immutable) + 6 PostgreSQL (persistence, constraint,
  isolation, audit detail, replay) + 9 HTTP. Full gate below.

## 2026-09-21 — Step 6: Registration & Patient Intake

- Baseline re-verified before work: 194 tests / 51 suites, all gates green;
  the discovery session had identified patient registration as the next
  vertical slice (domain contract existed, application/HTTP entry did not).
- Domain untouched (Phase 1): `src/domain/patient/patient.ts` and
  `PatientIdentityService` were already complete — duplicate exact-reference
  rejection, immutable references, facility-scoped registration. No rule
  changed; no migration added (`patients` and `patient_external_identifiers`
  already existed in migration 002 with RLS in 006).
- Application layer: `src/app/patients/patient-service.ts` — `registerPatient`
  (server-derived facility scope, exact-reference conflict → CONFLICT, keyed
  idempotency via the existing `runIdempotent`, audited),
  `attachExternalIdentifier` (scoped to the patient's registered facility,
  audited), `getPatient` (IDOR-resistant scoped lookup). Write-capable
  `PatientRegistrationRepository` port extends the existing read-only
  `PatientDirectory` — no second patient model or store.
- Persistence: `PostgresPatientRegistrationRepository` in the existing
  repositories module (atomic patient+references transaction, uniqueness
  backed by the schema's UNIQUE constraint); in-memory adapter mirrors the
  same semantics for application/HTTP tests. Runtime composition root wires
  the service.
- Transport: three routes added under `/api/v1` — `POST /patients`,
  `GET /patients/{patientId}`, `POST /patients/{patientId}/external-identifiers`
  — following the existing router/DTO/error-envelope conventions; fail-closed
  401 posture unchanged.
- Audit fix surfaced by tests: the attach audit initially used a composite
  string object id, which migration 005 rejects (`object_id UUID NOT NULL`) —
  corrected to audit against the patient id with a non-PHI detail string
  (raw identifier values are PHI-adjacent and never enter audit detail).
- Tests: 18 application + 14 HTTP + 8 disposable-PostgreSQL proofs, including
  durable (`PostgresIdempotencyStore`) replay with no duplicate audit, schema
  23505 uniqueness, forged-tenant/facility rejection, and registration→order
  over one identity source. Full gate: **234/234, 60 suites, 0 vulnerabilities,
  diff-check clean**.

## 2026-09-20 — Step 4: HTTP transport boundary (this session)

- Measured the Step-3 baseline before changing anything: 159 tests / 42 suites
  but **158 pass / 1 fail** — the architecture dependency-direction test failed
  because `src/app/laboratory/postgres-runtime.ts` (application layer) imported
  infrastructure, which the documented layering and the architecture gate
  forbid. Three docs files carried pre-existing prettier drift.
- Repair (no rule weakened, no behavior changed): relocated the composition
  root to `src/infrastructure/runtime/postgres-runtime.ts` and updated its test
  import; formatted the three docs files. Step-3 baseline restored: **159/159,
  all gates green** — verified before any new work.
- Authoritative next capability identified from the repository (PROJECT_STATUS
  "HTTP/API server: Deferred", API_CONTRACTS §7 "No HTTP server", ARCHITECTURE
  status): a minimal HTTP transport boundary. Not assumed — confirmed.
- Added `src/transport/`: `node:http` server (correlation IDs, JSON content
  type, body-size limit 413, malformed-JSON 400, unsupported-media-type 415,
  404/405, mandated §3 error shape), route table over `/api/v1` binding the 13
  repository-supported laboratory operations, transport-shape validation only,
  and a fail-closed `SessionResolver` seam — authentication is deferred, so the
  shipped configuration 401s every request; no token/session format invented.
- Direction preserved: transport imports application/domain/types only (typed
  `TransportRuntime` over the app services); runtime composition happens at
  the edge. No business logic in routes; `Idempotency-Key` header is honored
  and the application idempotency store remains the only engine; report
  authorship is bound to the session actor; error bodies never leak SQL,
  stacks, paths, or credentials; responses are the application DTOs verbatim.
- Tests added (`tests/transport/`, 35 total): 30 contract tests over real HTTP
  (validation, 401 posture incl. no-read-bypass, forged tenant, wrong facility,
  IDOR-resistant reads, forged patient/encounter pairings, full order →
  specimen → observation → interpretation → report drive, 409 on double
  finalize, amendment versioning, idempotent replay via header, DTO-field and
  leakage assertions) and 5 HTTP → application service → disposable PostgreSQL
  proofs (persisted flow with SQL-as-evidence, durable idempotent replay,
  cross-facility 403, forged-tenant 403, 401) on a fresh port (55442).
- Migrations, RLS, domain, and application contracts unchanged.
- Full regression: **194 pass / 0 fail / 0 cancelled (51 suites)**, build,
  typecheck, lint (0 warnings), format check, secret sweep, npm audit
  0 vulnerabilities, `git diff --check` clean. No commits made; working tree
  changes left for review.

## 2026-09-20 — Step 1: Foundation & Standards (this session)

- Repository discovered: `b4snet/SDIS`, public, single commit `75dd525`
  ("Initial commit", README only). Baseline recorded as **NEW / EMPTY FOUNDATION**.
- Toolchain established locally: Git 2.55.0.3, Node.js 24.19.0 (portable), npm 11.17.0.
- Authoritative documentation created under `docs/`:
  README (product identity), ARCHITECTURE, MASTER_RULES, TERMINOLOGY, DATABASE,
  SECURITY, TENANCY, AUDIT_PROVENANCE, CLINICAL_SAFETY, STANDARDS (register),
  INTEROPERABILITY, QUALITY_MANAGEMENT, API_CONTRACTS, TESTING_STRATEGY,
  DEPLOYMENT, ROADMAP, COMPLIANCE_REGISTER, PROJECT_STATUS, DEVELOPMENT_LOG.
- Architecture decisions made (contract-only):
  - Modality-extensible platform core (LAB first; ECG/EEG/PFT/TMT/ECHO/ULTRASOUND
    representable without core rewrites).
  - Observation ≠ Interpretation ≠ Report.
  - Append-only audit with distinct provenance source kinds
    (human/device/algorithm/integration/system).
  - Centralized patient identity; external-reference HMS boundary.
  - Tenant/facility scope explicit and server-derived; RLS target.
  - Modular monolith + internal domain events; distributed events deferred.
  - No speculative migrations; PostgreSQL strategy documented.
- Foundation code created: TypeScript contract modules + tests (see `src/` and
  `tests/`). No runtime, no HTTP layer, no database connection.
- Quality gates executed and green: build, typecheck, lint (0 warnings),
  format check, **52 tests pass / 0 fail**, secret-sweep security test,
  npm audit 0 vulnerabilities.
- No commits made; working tree changes left for review.

## 2026-09-20 — Step 3: PostgreSQL laboratory runtime

- Added the in-process PostgreSQL laboratory composition root, wiring existing
  services to existing PostgreSQL repositories, audit, and idempotency ports.
- Added disposable PostgreSQL runtime tests for the complete order -> specimen ->
  observation -> interpretation -> report flow, persisted relationships,
  provenance/audit, durable idempotency, and tenant/facility rejection.
- Fixed PostgreSQL audit-detail encoding compatibility and persisted draft-to-
  finalized report updates without permitting finalized-version overwrite.
- No migrations or RLS policies changed. Full local verification: **159 pass /
  0 fail / 0 cancelled**.

## 2026-09-20 — Step 2: Build & Integration Prime / Laboratory Core (this session)

- Application layer created under `src/app/`: errors taxonomy, session/scope
  handling, DTO boundary, idempotency plumbing, audit recorder, repository
  ports, deterministic in-memory adapters, and laboratory services
  (order, specimen, observation, interpretation, report, end-to-end flow).
- Minimal additive domain extensions (existing patterns only):
  `PatientIdentityService.findById` (read-only lookup) and the specimen
  lifecycle (`transitionSpecimenStatus` + `SPECIMEN_LIFECYCLE`, mirroring the
  order state machine). No domain semantics changed.
- Step-2 test suites added under `tests/app/` and
  `tests/clinical/specimen-lifecycle.test.ts`; dependency-direction test
  extended with application-layer rules (app → domain/core/types only; lower
  layers never import app).
- Quality gates executed and green: build, typecheck, lint (0 warnings),
  format check, **111 tests pass / 0 fail** (Step-1 52 preserved + 59 new),
  secret-sweep security test, npm audit 0 vulnerabilities,
  `git diff --check` clean.

## 2026-09-20 — Step 2 cleanup: lab-flow rewrite (this session)

- Pre-cleanup baseline: Step-2 draft did not compile (11 TypeScript errors)
  and no Step-2 tests existed; Step-1 suite unaffected (52/52).
- Removed: wrong-module imports, constructor initialization-order faults,
  DTO→domain casts (replaced by branded-id parsing at re-entry),
  untyped idempotency choke point (generic ports; single documented narrowing
  in the infrastructure adapter), vacuous self-assertion, unguarded inputs.
- Added: shared fail-closed session-facility check (forged organization
  rejected before resource checks), `FacilityDirectory` port reusing the
  Step-1 `Facility` type, frozen audit snapshots, explicit test fixture
  factory with per-test isolation.
- One genuine defect found by cleanup and fixed: the orchestrator returned a
  stale (COLLECTED) specimen DTO instead of the final transitioned one.
- Full regression green: **111 pass / 0 fail**, all gates clean.
- No commits made; working tree changes left for review.

## 2026-09-23 — Step 27: Laboratory Workflow Completion (this session)

- Discovered state: the laboratory lifecycle was substantially built (order
  state machine, specimen collection, result entry incl. device-originated
  provenance, verification via order states, immutable finalized reports +
  amendments, priority worklist, QC domain contract from Step 1). Genuine
  gaps: no specimen rejection reason, no accession identity, missing RBAC
  asserts on lab services, no worklist filters, no QC application/persistence.
- Specimen exceptions (migration 022): `rejection_reason` (bounded
  vocabulary, CHECK-enforced consistency), REJECTED requires an explicit
  reason at the application boundary; history preserved, no deletion.
- Accessioning (migration 022): facility-unique accession number assigned
  exactly once at RECEIVED, immutable, DTO-exposed; never replaces global ids.
- RBAC: specimen/observation/interpretation/report services now assert
  existing permissions (fail-closed); test fixtures carry operator claims.
- Worklist (Step 27 filters): status/priority/from/to narrowing of the same
  authoritative read model; unknown status/priority values 422; no second
  worklist store.
- Quality application service + persistence (migration 023):
  facility-scoped records over the Step-1 domain contract, RLS, audited,
  idempotent; analytical-hold boundary pauses report finalization (conflict
  until released) — QC never mutates patient results.
- QC hold id invariant: one row = one hold; the hold shares the record's id
  (matches the PostgreSQL mapping; release references are resolvable).
- Tests: application 13 (lifecycle e2e, rejection, accession, worklist,
  QC separation, idempotent replay, historical integrity), HTTP 6 (transitions,
  validation, 401/403/409/422, safe DTOs), PostgreSQL 9 (migrations 022/023,
  persistence, CHECK, hold loop, RLS isolation, manager tier).
- Fixtures: shared lab fixture gained worklist + quality capabilities and the
  QC-hold probe (same wiring as the PostgreSQL runtime).
- Docs: API_CONTRACTS (new endpoints + worklist filters), CLINICAL_SAFETY
  §11 (QC hold separation), PROJECT_STATUS (laboratory row).

## 2026-09-23 — Step 28: Result Verification, Finalization & Amendment Governance (this session)

- Verification attribution (Step 28): the `RESULT_ENTERED -> VERIFIED`
  transition records `verifiedByRef`/`verifiedAt` from the SESSION actor —
  never a client-supplied field. Persisted (migration 024) with a CHECK
  constraint enforcing attribution only in VERIFIED-or-later states; exposed
  on the order DTO.
- Manager-tier verification: `VERIFIED` requires the reviewing signature
  (SETUP_MANAGE — the existing administrative permission; no second RBAC
  system). Staff below the tier is 403.
- Verification gate on report finalization: a report cannot finalize until
  the underlying diagnostic order is VERIFIED (409 before, 200 after);
  amendments re-finalize the corrected version under the same gate.
- Amendment governance: `amendmentReason` is REQUIRED (bounded vocabulary,
  422 on missing/unknown); amendments are manager-tier (403 below); the new
  version is created as DRAFT and finalizes like any other; prior versions
  are never mutated (append-only lineage).
- DTO additions: order `verifiedByRef`/`verifiedAt`; report version
  `amendmentReason` — governance metadata only, no PHI.
- Tests: application 8 (attribution, tier, gate, reason, lineage, replay),
  PostgreSQL 3 (attribution persistence via migration 024, amendment lineage,
  concurrent verification CAS), HTTP 4 (403/409/422 + keyed replay).
- Docs: API_CONTRACTS (report governance rows).

## 2026-09-25 — Step 35: Full Foundation Audit & Completion Gate (this session)

- Gate executed over the real repository (main @ 75dd525, all work
  uncommitted): baseline `npm run verify` launched first and audited in
  parallel — EXIT=0, 821 tests / 821 pass / 0 fail / 0 skipped, 0
  vulnerabilities, build/typecheck/lint/Prettier clean.
- Audit probes: destructive-SQL scan of src (0 hits), SQL-interpolation scan
  (compile-time column constants only — parameterization holds),
  scope-trust grep (no body-supplied facility/role anywhere in the router),
  route-method scan (GET/POST only, no generic PATCH/PUT state mutation),
  worklist bounds/keyset/RBAC read, QC-vs-patient-result separation read
  (hold gates finalization; QC never rewrites results), priority-vocabulary
  read, index-coverage read (orders/specimens/worklist paths backed by
  003/018/004 indexes), boundary reads over notifications (receipted),
  documents (sha256 proofs), patient access (FINALIZED-only), integrations
  (fail-closed registry), and `.env.example`/README claim checks.
- Result: NO code blocker found — every security, integrity, concurrency,
  lifecycle, migration, and operational invariant is enforced and
  regression-tested. Two documentation drifts found and FIXED (text-only):
  README status header still declared "Step 4" while Steps 1–34 are
  implemented; `.env.example` documented `PORT`/`LOG_LEVEL`/`LOG_FORMAT`/
  `DATABASE_URL`, which no code reads (real contract: `PG*`,
  `SDIS_API_TOKENS`, `SDIS_PG_CLIENT_DIR`; unknown `SDIS_*` keys fail
  startup, so the template is load-bearing). No test weakened, no failure
  suppressed, zero production code lines changed.
- `docs/FOUNDATION_GATE.md` written: gate decision **FOUNDATION COMPLETE**,
  35-area status matrix (33 PASS, 2 PARTIAL with cited non-blocking gaps),
  fixes, 8 non-blocking debt items (DB-layer facility policy, fingerprint
  coverage beyond order.create, global accession scope, RLS residual,
  worklist SQL-pushdown, 24h replay window, QC hold scope, cursor headers),
  deferred/advanced-integration/advanced-modality/platform categories, and
  the gate execution record.
- PROJECT_STATUS header updated to the gate state; README now points at
  PROJECT_STATUS + FOUNDATION_GATE.

## 2026-09-25 — Step 34: Observability, Backup/Recovery & Production Operational Readiness (this session)

- Discovery: the Step-12/18/26 observability + recovery stack was already
  mature (health probes, bounded metrics, allowlisted logger, correlation
  IDs, error envelope, pg backup/restore with `verifyRecovery`, disposable-PG
  recovery drills). The genuine Step-34 gaps were process lifecycle,
  metrics wiring/exposure, backup finalize atomicity, operator tooling, the
  §39 smoke chain, and operational docs — all closed without adding any new
  logging/monitoring system.
- Process lifecycle (`src/runtime/process.ts`, NEW): fail-fast startup
  validation (unknown `SDIS_*` keys, malformed `SDIS_API_TOKENS`, bad
  `NODE_ENV`/`PGPORT`, transport config — absent optional config stays
  valid so local dev is unchanged and auth stays fail-closed);
  `runtimeHealth`/`runtimeMetrics` surfaces; bounded graceful shutdown
  (SIGTERM/SIGINT → listener close + idle-socket close + in-flight budget
  10 s + caller drain step; wedged ⇒ `forced` + non-zero exit; second
  signal force-exits).
- Metrics (Step 34 wiring): `observeDependencyProbe` (readiness outcomes →
  `sdis_readiness_probes_total`, the alertable dependency-down signal) and
  `observeShutdown` added to the bounded registry; `/readyz` and the DB pool
  (`setDatabaseMetrics`, pool errors → `sdis_dependency_failures_total|
postgres`, no credentials in the logged message) now feed them; new
  unauthenticated-by-design `GET /metrics` endpoint carrying bounded
  counters only, gated by `TransportConfig.exposeMetrics` (default on,
  validated boolean).
- Backup/recovery hardening: `verifyBackupArtifact` readability gate
  (`pg_restore --list`, no database touched) run on the backup path AND
  before any restore side effect (`READABILITY_FAILED`); `createBackup`
  now writes to `<name>.partial` and finalizes atomically — a failed backup
  can never occupy the deterministic name and never leaves debris; no
  failure path reports success.
- Operator CLI (`scripts/sdis-admin.mjs`, NEW; npm scripts `backup`,
  `verify-restore`, `ops-check`): drives the repository's own
  backup-restore module — protected-target refusal FIRST, artifact
  validation, drop/create-drill into a disposable database, JSON
  verification report, non-zero exits on every failure, and read-only
  integrity diagnostics (schema/RLS/migrations/audit chain + derived
  inventory balances + accession identity; never repairs).
- New suites: `tests/runtime/process.test.ts` (11: config valid/missing/
  invalid, health surface, `/metrics` leak-proof over real HTTP, graceful
  - forced shutdown, signal wiring) and `tests/app/smoke.test.ts` (6: §39
    chain — health/metrics, auth fail-closed, tenant scope, patient→order→
    specimen/accession→result→verify→QC hold/release→finalize, inventory
    receipt/issue/stock-floor, audit evidence — over real HTTP + PostgreSQL,
    synthetic data only). `tests/infrastructure/backup-restore.test.ts` +2
    (readability gate, atomic finalize); `tests/infrastructure/ops-cli.test.ts`
    NEW (4: backup→drill, protected-target/garbage refusal, healthy check,
    inconsistent-ledger detection with no repair).
- Docs: OPERATIONS.md (NEW canonical chain, health semantics, lifecycle,
  metrics table, DB observability, backup ops + security/retention policy
  boundaries, RPO/RTO placeholders, honest DR/HA boundary), RUNBOOKS.md
  (NEW 10 procedures), PRODUCTION_READINESS.md (NEW factual per-area
  checklist), DEPLOYMENT.md (§6 lifecycle, §7 tooling, metrics exposure).
- Status discipline: backups are NOT disaster recovery; no HA, PITR, or
  replication is claimed; retention/encryption/scheduling are deployment
  policy; overall production readiness is deferred to the Foundation gate.

## 2026-09-24 — Step 33: Data Integrity, Concurrency, Idempotency & Transaction Hardening (this session)

- Step-33 audit found the integrity architecture already mature: PG
  `Database.transaction` with RLS role/GUC stamping, version-CAS on
  order/specimen PG saves (LAB-02), `IdempotencyStore.withExclusive`
  single-flight (IDEM-01), the atomic stock-floor conditional insert, the
  serialized audit hash chain (AUDIT-01), and strong unique constraints across
  migrations 001–023. Four genuine gaps plus one scope residual were fixed; no
  distributed infrastructure, lock service, or second event system was added.
- INT-33a (§10): same-key/different-payload guard. `runIdempotent` optionally
  records a SHA-256 fingerprint (`requestFingerprintOf`, stable key-sorted
  JSON) of the LOGICAL operation under a derived `<key>:fp` record (hex digest
  only — no request payload persisted) and asserts it both before and after
  `withExclusive` (covers racing losers served by the store's internal
  pre-get). Mismatch → `RequestFingerprintMismatchError`
  (`IDEMPOTENCY_CONFLICT`, 409). Wired into `order.create` with a logical
  fingerprint that excludes `orderedAt` — the Step-18 recovery drill replays
  with a regenerated timestamp and still passes 6/6.
- INT-33b (§37): in-memory order/specimen `save()` now enforce version CAS —
  parity with the PG LAB-02 fix; stale writes throw `ConflictError` instead of
  silently overwriting (insert stores the caller's version, update advances it).
- INT-33c (§13): PG order/specimen saves map SQLSTATE 23505 (exported
  `isUniqueViolation`) to `ConflictError` — constraint races are 409, not 500.
- INT-33d (§14): in-memory `applyDepletingMovement` snapshot→check→append is
  now synchronous (no interleaving `await`) — the overdraw window is closed;
  the PG path was already atomic via conditional INSERT.
- INT-33e (§9 residual): `SetupConfigService.updateConfig` — the last of 26
  `runIdempotent` call sites without a `session` argument — now passes it;
  `SETUP_CONFIG_UPDATE` replays are facility-scoped.
- New regression suite `tests/app/integrity-hardening.test.ts` (9 tests):
  different-payload rejection + regenerated-timestamp replay + fingerprint
  digest properties; concurrent same-key create (same id) and
  different-payload race (exactly 1 fulfilled + 1 conflict); in-memory CAS
  parity; stock-floor race (never negative); facility-scoped update replay.
- Docs: `docs/DATA_INTEGRITY.md` — canonical integrity model (integrity
  chain, transaction architecture, idempotency semantics incl. fingerprints,
  state-machine integrity, concurrency rules, historical immutability,
  remaining debt).
- Gate: full `npm run verify` green — 798 tests, 0 fail, 0 vulnerabilities
  (789 + 9 new); recovery drill 6/6; broad regression net 575/575.

## 2026-09-24 — Step 32: Security, Authorization & Tenant/Facility Hardening (this session)

- Repository-wide security audit confirmed the shipped architecture: fail-
  closed 401 transport, canonical RBAC engine wired into 18 services, RESTRI-
  CTIVE RLS policies + request-scope stamping (migration 014), env-read
  allowlist (architecture-tested), safe error envelope, constant-time token
  comparison, and scoped audit recording. Three genuine gaps found and fixed;
  no security theater added.
- SEC-IDEM (§32): idempotency records are now FACILITY-SCOPED. `scopedIdem-
potencyKey` composes the session's server-derived facility into the record
  key; all 26 session-scoped `runIdempotent` call sites pass the session, so
  `facility A + key X ≠ facility B + key X` — a retry can neither read nor
  plant another facility's memoized result. Scope-less callers are rejected
  (no insecure fallback).
- AUTH-04 (§4): every 401 now carries `WWW-Authenticate: Bearer` (scheme
  only); 403 never does — authentication vs authorization failures are wire-
  distinguishable per RFC 6750 §3.
- AUTH-03 (§4): credential lookup is now timing-uniform — SHA-256 commit-
  ments compared against EVERY entry with no early exit; work no longer
  leaks configured-token lengths or match positions.
- SEC-HEADERS (§24): `x-content-type-options: nosniff` on every JSON
  response.
- New security regression suite `tests/app/security-hardening.test.ts`
  (11 tests): cross-facility replay isolation/no-plant, scope-less
  rejection, on-the-wire challenge semantics, timing-uniform directory
  position-independence, fail-closed forged-scope denial through the
  application boundary.
- Docs: SECURITY.md (hardening table + status), RBAC.md (canonical
  permission→roles→scope matrix, NEW), TENANCY.md (infrastructure
  isolation), API_CONTRACTS.md (auth-challenge row), QA_DEFECT_LEDGER
  (AUTH-03/AUTH-04 → FIXED).
- Audited and found already-safe (no change): client-supplied scope
  selectors (none exist), process.env surface (allowlisted), SQL
  parameterization, audit actor/timestamp trust, document download
  authorization, patient-portal ownership gating, integration gateway
  provenance enforcement.

## 2026-09-24 — Step 31: Inventory, Reagent & Consumable Lifecycle Completion (this session)

- Built on the Step-14 foundation (facility-scoped item master, lots,
  append-only movement ledger, derived balances, RBAC, idempotency, RLS).
  No second inventory system; no ERP/procurement scope.
- Lot lifecycle (Step 31 §6): AVAILABLE -> QUARANTINED -> RELEASED, RETIRE
  terminal; every transition reasoned, audited, keyed-idempotent, and
  rejected with 409 when the current state disallows it. Expiry is never
  rewritten; the derived gate stays authoritative.
- Expiry semantics (§11): three-state derived view VALID / EXPIRING_SOON
  (30-day horizon) / EXPIRED; `GET /inventory/expiring?horizonDays=`
  (1-365) lists lots with balances; expired lots remain fully visible in
  history and are never deleted.
- Consumption gates (§8/§17): OUT movements are refused for expired,
  quarantined, retired, or zero-balance lots; wastage from retired lots is
  refused. WASTAGE remains the disposal path for expired/damaged stock
  (§18) — recording wastage of expired stock is how it leaves the ledger.
  RETURN cannot top up a retired lot; receipts cannot reuse an expired/
  quarantined lot number (new stock goes to a fresh lot).
- FEFO selection (§12): deterministic read-only pick — earliest expiry,
  then receivedAt, then lotNumber — over consumable, balance-positive
  lots only. Selection consumes nothing; issueStock re-applies every gate.
- Usage traceability (§14): movements carry a required bounded reason and
  an optional operationRef (order/QC record id); `GET /lots/{id}/usage`
  and `GET /operations/{ref}/usage` answer "which lot served this
  operation" without fabricating links.
- Item lifecycle (§3): retire/reactivate with reason + audit; retired
  items accept no stock movements (409).
- Persistence (§25): migration 025 — lot status + movement reason/
  operation_ref + item active flag + expiry/status indexes; PG repository
  enforces the negative-stock invariant with a single conditional UPDATE
  (atomic check-and-decrement, no check-then-act race); the same
  invariant is enforced in the in-memory mirror.
- HTTP: six new routes (lot status, item status, expiring, FEFO pick,
  lot usage, operation usage) following the existing conventions —
  auth, fail-closed RBAC (INVENTORY_MANAGE for mutations, INVENTORY_READ
  for reads), scope server-derived, bounded vocabularies, consistent
  error envelope.
- Tests: application 16 (incl. duplicate identity, expiry views, keyed
  receipt replay), PostgreSQL 8 (migration + schema-level uniqueness,
  over-issue atomicity, isolation, durable idempotent replay), HTTP 10
  (existing contract) + 7 new lifecycle/FEFO/traceability/security.
- Docs: API_CONTRACTS (six new rows).

## 2026-09-23 — Step 29: Diagnostic Worklists & Operational Workflow Maturity (this session)

- Worklist architecture unchanged in kind: views/queries over authoritative
  state — NO second worklist store, no copied workflow state, no claim
  machinery (the domain models no assignment states; none were invented).
- New typed views (`WorklistService.listView`): `collection` (ACQUIRED),
  `accessioning` (COLLECTED), `processing` (RECEIVED), `result-entry`
  (PROCESSING), `verification` (RESULT_ENTERED), `finalization` (VERIFIED),
  `exception` (REJECTED specimens + CANCELLED orders + the facility's active
  QC hold). Every view selects canonical lifecycle states only.
- Per-view authorization reuses the EXISTING permission matrix (the
  permission of the work the view leads to); scope stays server-derived;
  fail-closed.
- Specimen read port `listByFacilityWithStatus` (in-memory + PostgreSQL):
  deterministic (collected-at, then id); DB-side filtering served by the
  status index (migration 004).
- Bounded pagination with keyset cursors (sort key + unique id tie-break);
  page size from Step-24 config with the 50 default as hard maximum.
- HTTP: `GET /api/v1/worklists/{view}` with vocabulary-validated view
  (422), priority/testCode/cursor/limit filters, consistent error mapping.
- Tests: application 11 (view correctness, ordering, filters, pagination
  cover, RBAC, isolation, governance integrity, unauthenticated denial),
  HTTP 5 (contract body, 422 view/limit, 403 tier, 401/403 security,
  cursor/priority pass-through).
- Docs: API_CONTRACTS (worklists/{view} row); ARCHITECTURE (worklist layer
  as read model).

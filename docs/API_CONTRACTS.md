# SDIS API Contracts

Status: Step 8 — **the HTTP transport boundary exposes the existing laboratory,
patient-registration, terminology-persistence, and diagnostic-charge
application services over `/api/v1` and is contract-tested, including against
the disposable PostgreSQL runtime. Authentication remains fail-closed
deferred; no production API is deployed.**

## 1. API-first principles

- Public API boundary and internal service boundary are distinct.
- APIs expose stable **DTO/resource contracts**, never raw database models.
- The code layer defines typed resource models now; an HTTP framework binds later.

## 2. Versioning

- API version in the URL path (`/api/v1/...`).
- Breaking changes require a new major version; additive changes are backward compatible.

## 3. Error format (mandated shape)

```json
{
  "error": {
    "code": "SME_ORDER_NOT_FOUND",
    "message": "Diagnostic order not found in this facility",
    "correlationId": "…",
    "details": []
  }
}
```

- Stable error codes; no stack traces; no internal identifiers leaked.
- The application layer raises typed errors (`src/app/errors.ts`) with stable
  codes: `UNAUTHENTICATED`, `FORBIDDEN`, `SCOPE_MISMATCH`,
  `VALIDATION_FAILED`, `NOT_FOUND`, `INVALID_STATE_TRANSITION`, `CONFLICT`,
  `IDEMPOTENCY_CONFLICT` (reserved), `INTERNAL`.

## 4. Cross-cutting API behaviors

| Behavior        | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication  | **Credential bearer-token foundation (Step 10)** — `Authorization: Bearer` resolved through the injected `CredentialDirectory` port; absent/malformed/unknown credentials fail closed to 401 (see §9)                                                                                                                                                                                                                                         |
| Authorization   | RBAC scoped to organization/facility; every request carries server-derived scope (enforced by the application services, not the transport)                                                                                                                                                                                                                                                                                                    |
| Idempotency     | `Idempotency-Key` header honored on POST for state-changing operations (header wins over a body field); the application idempotency store is the only engine. Records are scoped to the session's facility (Step 32) and a replayed key with a DIFFERENT logical request payload is rejected `409 IDEMPOTENCY_CONFLICT` (Step 33 fingerprint guard)                                                                                           |
| Auth challenges | Every `401` response carries `WWW-Authenticate: Bearer` (Step 32); `403` responses never do — authentication and authorization failures stay wire-distinguishable. Idempotency records are scoped to the session's server-derived facility, so a retry key never collides across facilities.                                                                                                                                                  |
| Pagination      | The Step-29 worklist views and the Step-19 notification list implement keyset pagination today: `limit` + `cursor` query parameters, `nextCursor` returned in the response body (deterministic sort key, resume-after semantics, bounded page size). Other collections are still returned as JSON arrays. RFC-5988 `Link` cursor headers are a deferred standardization (BASELINE-09) — consumers depend on the in-body `nextCursor` contract |
| Filtering       | Explicit, whitelisted query parameters; never free-form SQL fragments (planned; no filtering endpoints exist today)                                                                                                                                                                                                                                                                                                                           |
| Correlation IDs | Generated at the edge (`X-Correlation-Id` echo when a safe token is supplied); propagated to every response and error body                                                                                                                                                                                                                                                                                                                    |
| Audit           | Material mutations emit audit events (see AUDIT_PROVENANCE.md)                                                                                                                                                                                                                                                                                                                                                                                |
| Rate limiting   | Per-user/IP token buckets (planned, not deployed)                                                                                                                                                                                                                                                                                                                                                                                             |

## 5. Resource boundary (future)

Planned resource families (typed contracts exist in `src/domain/`):

```text
organizations, facilities, departments, patients, encounters,
diagnostic-orders, order-items, specimens, observations,
interpretations, reports (versions), practitioners, devices,
modalities, billable-services, charges, invoices, payments,
documents, inventory-items, inventory-lots, stock-movements,
setup-configuration, integration-requests, terminology-mappings, audit-events
```

## 6. Event-driven extensibility

- Initial posture: **modular monolith with explicit internal domain events**.
- Reserved event types: analyzer ingestion, critical values, report finalization,
  notifications, billing events, interoperability, analytics, audit.
- Step 19 makes the internal event/notification path durable: a minimal outbox
  (`sdis.notification_events` / `notification_intents` /
  `notification_delivery_attempts`) with an in-process dispatcher, bounded
  deterministic retries, and DB-layer idempotency — no parallel message broker.
- Evolution boundary: when an event is consumed by an EXTERNAL subsystem, promote
  the channel boundary to a real provider adapter (email/SMS/webhook). A broker
  remains future/deferred; distributed infrastructure is not required today.

## 7. HTTP transport boundary (implemented, local only)

`src/transport/` hosts a `node:http` server exposing the repository-supported
laboratory operations under `/api/v1`. Direction is strictly:

```text
HTTP (server.ts) → route table (router.ts) → application services → domain
                                             ↘ DTO mapping (src/app/dto.ts)
```

The transport never imports infrastructure and never touches PostgreSQL; the
runtime is composed at the edge and injected (`TransportRuntime`). Routes
perform transport-shape validation only (presence, JSON shape, UUID v4
identifier format, ISO-8601 timestamps, provenance-kind vocabulary, observation
value kinds); lifecycle, scope, identity, idempotency, audit, and persistence
remain exclusively below the transport layer.

### Endpoints (current, complete list)

| Method | Path                                                | Success | Notes                                                                                                                                                               |
| ------ | --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/v1/diagnostic-orders`                         | 201     | Idempotent (keyed)                                                                                                                                                  |
| GET    | `/api/v1/diagnostic-orders/{orderId}`               | 200     | Scope-checked read                                                                                                                                                  |
| POST   | `/api/v1/diagnostic-orders/{orderId}/transitions`   | 200     | Domain state machine decides legality; `order.create` (operator tier) on every transition, `order.verify` (manager tier) for VERIFIED; viewer 403                   |
| POST   | `/api/v1/order-items/{orderItemId}/specimens`       | 201     | Idempotent (keyed)                                                                                                                                                  |
| POST   | `/api/v1/order-items/{orderItemId}/observations`    | 201     | Idempotent (keyed); explicit provenance source                                                                                                                      |
| GET    | `/api/v1/order-items/{orderItemId}/observations`    | 200     | Scope-checked list                                                                                                                                                  |
| POST   | `/api/v1/order-items/{orderItemId}/interpretations` | 201     | Idempotent (keyed); explicit provenance source                                                                                                                      |
| GET    | `/api/v1/order-items/{orderItemId}/interpretations` | 200     | Scope-checked list                                                                                                                                                  |
| POST   | `/api/v1/diagnostic-orders/{orderId}/reports`       | 201     | Idempotent (keyed)                                                                                                                                                  |
| POST   | `/api/v1/reports/{reportId}/finalize`               | 200     | Step 28: 409 when already finalized OR order not VERIFIED (verification gate) OR QC hold active                                                                     |
| POST   | `/api/v1/reports/{reportId}/amendments`             | 200     | Step 28: requires `amendmentReason` (bounded vocabulary, 422 otherwise); `report.amend` manager tier (403 below); new superseding version; prior versions immutable |
| GET    | `/api/v1/reports/{reportId}`                        | 200     | Scope-checked read                                                                                                                                                  |
| POST   | `/api/v1/patients`                                  | 201     | Idempotent (keyed); facility from session only                                                                                                                      |
| GET    | `/api/v1/patients/{patientId}`                      | 200     | Scope-checked read (IDOR-resistant)                                                                                                                                 |
| POST   | `/api/v1/patients/{patientId}/external-identifiers` | 201     | Idempotent (keyed); `patient.create` (operator tier); duplicate reference → 409                                                                                     |
| POST   | `/api/v1/terminology/mappings`                      | 201     | Idempotent (keyed); `terminology.manage` (manager tier); duplicate mapping → 409                                                                                    |
| GET    | `/api/v1/terminology/mappings/{mappingId}`          | 200     | Scope-checked read (no cross-facility leak)                                                                                                                         |
| GET    | `/api/v1/terminology/resolve/{canonical}/{system}`  | 200     | Facility override first, then global                                                                                                                                |
| POST   | `/api/v1/devices/{deviceId}/acquisitions`           | 201     | Device ingestion boundary (Step 9); linked acquisition requires `rawPayload` (422 otherwise); idempotent (`ingestionKey`)                                           |
| POST   | `/api/v1/charges`                                   | 201     | Idempotent (keyed); recorded price only                                                                                                                             |
| GET    | `/api/v1/charges/{chargeId}`                        | 200     | Scope-checked read (IDOR-resistant)                                                                                                                                 |
| GET    | `/api/v1/diagnostic-orders/{orderId}/charges`       | 200     | Order-scoped charge list                                                                                                                                            |
| POST   | `/api/v1/documents`                                 | 201     | Idempotent (keyed); base64 body; metadata DTO                                                                                                                       |
| GET    | `/api/v1/documents/{documentId}`                    | 200     | Scope-checked metadata read (no storage detail)                                                                                                                     |
| GET    | `/api/v1/documents/{documentId}/content`            | 200     | Dedicated binary response (never JSON-wrapped)                                                                                                                      |
| POST   | `/api/v1/inventory/items`                           | 201     | Item registration (sku unique per facility)                                                                                                                         |
| POST   | `/api/v1/inventory/lots`                            | 201     | Lot registration + receipt (lot unique per item)                                                                                                                    |
| POST   | `/api/v1/inventory/receive`                         | 201     | Idempotent (keyed) IN movement                                                                                                                                      |
| POST   | `/api/v1/inventory/issue`                           | 201     | Idempotent (keyed) OUT/WASTAGE/RETURN movement                                                                                                                      |
| GET    | `/api/v1/inventory/items/{itemId}/balance`          | 200     | Derived ledger balance (never stored)                                                                                                                               |
| GET    | `/api/v1/inventory/items/{itemId}/lots`             | 200     | Lot balances + expiry status (operational only)                                                                                                                     |
| POST   | `/api/v1/inventory/lots/{lotId}/status`             | 200     | Controlled lot transition (AVAILABLE/QUARANTINED/RELEASED/RETIRED); reasoned, audited, idempotent (keyed)                                                           |
| POST   | `/api/v1/inventory/items/{itemId}/status`           | 200     | Item retire/reactivate; reasoned, audited, idempotent (keyed)                                                                                                       |
| GET    | `/api/v1/inventory/expiring`                        | 200     | Expiring lots within bounded horizonDays (1-365, default 30)                                                                                                        |
| GET    | `/api/v1/inventory/items/{itemId}/fefo-selection`   | 200     | FEFO pick (earliest expiry, receivedAt/id tie-break); read-only, excludes expired/quarantined/retired/zero-balance lots                                             |
| GET    | `/api/v1/inventory/lots/{lotId}/usage`              | 200     | Full movement history of one lot (usage traceability)                                                                                                               |
| GET    | `/api/v1/inventory/operations/{operationRef}/usage` | 200     | Movements recorded against one laboratory operation (order/QC id)                                                                                                   |
| POST   | `/api/v1/setup/config`                              | 201     | Idempotent (keyed); scoped + versioned config                                                                                                                       |
| GET    | `/api/v1/setup/config`                              | 200     | Configuration applicable to the session scope                                                                                                                       |
| GET    | `/api/v1/setup/config/{family}/{key}`               | 200     | Latest version in the session scope                                                                                                                                 |
| GET    | `/api/v1/setup/config/versions/{configId}`          | 200     | One historical version (scope-checked)                                                                                                                              |
| POST   | `/api/v1/setup/config/{family}/{key}/versions`      | 201     | Appends version N+1 (stale version → 409)                                                                                                                           |
| POST   | `/api/v1/integration/requests`                      | 200/201 | Inbound external envelope; unregistered or disabled system 403                                                                                                      |
| GET    | `/api/v1/integration/orders/{orderId}`              | 200     | Order status (`x-integration-system` header)                                                                                                                        |
| GET    | `/api/v1/integration/reports/{reportId}`            | 200     | Report bundle; audited `EXPORTED`                                                                                                                                   |

Integration envelope operations (Step 20 additions): `INBOUND_RESULT` maps an
external result onto a canonical observation through the existing observation
service (201; idempotent replay returns the same observation); `ORDER_EXISTS`
resolves an external system's own order id to the canonical order via the
`sdis.order_external_references` correlation table (200 with `{order,
externalSystem, externalOrderRef}`, 404 unknown, 422 when correlation storage is
not configured). External-system registration data lives in
`sdis.external_systems` (non-secret `config_ref` only — no credentials).
| GET | `/api/v1/notifications/deliveries/{eventId}` | 200 | Delivery receipts; scope-checked read model |
| GET | `/api/v1/notifications/event-types` | 200 | Bounded event-type vocabulary (bus stays internal) |
| GET | `/api/v1/notifications` | 200 | Step 19 durable read model: delivery intents (items + `nextCursor`, `limit` 1–100, `cursor`); no payloads/secrets exposed |
| GET | `/api/v1/notifications/{intentId}` | 200 | Step 19 one delivery intent + its attempt ledger; foreign/unknown 404 (IDOR-resistant) |
| POST | `/api/v1/notifications/{intentId}/retry` | 200 | Step 19 manager-tier (`notification.manage`); FAILED→PENDING / RETRYING→PENDING within budget; 409 invalid state / budget exhausted / concurrent lost-update |
| POST | `/api/v1/notifications/{intentId}/cancel` | 200 | Step 19 manager-tier (`notification.manage`); PENDING/FAILED/RETRYING→CANCELLED; audited; repeated cancel 409 |
| POST | `/api/v1/diagnostic-orders/{orderId}/priority` | 200 | Step 21 priority change; idempotent (keyed); audited |
| GET | `/api/v1/worklist` | 200 | Step 21/27 deterministic facility worklist; `status`/`priority`/`from`/`to` read-model filters (unknown status/priority 422) |
| GET | `/api/v1/worklists/{view}` | 200 | Step 29 typed operational views: `collection`/`accessioning`/`processing`/`result-entry`/`verification`/`finalization`/`exception` (unknown view 422); `priority`/`testCode`/`from`/`to`/`cursor`/`limit` filters; per-view RBAC (403), keyset pagination, `exception` surfaces the active QC hold |
| GET | `/api/v1/patient/reports` | 200 | Step 22 OWN finalized reports (patient principal) |
| GET | `/api/v1/patient/reports/{reportId}` | 200 | Step 22 one owned FINALIZED report; foreign/draft/unknown all 404 |
| POST | `/api/v1/documents/{documentId}/retire` | 200 | Step 23 removes ACCESS only (content retained); idempotent |
| GET | `/api/v1/patients/{patientId}/documents` | 200 | Step 23 staff per-patient listing (facility-scoped) |
| GET | `/api/v1/patient/documents` | 200 | Step 23 OWN patient-visible documents (patient principal) |
| GET | `/api/v1/patient/documents/{documentId}` | 200 | Step 23 one owned visible document; foreign/retired/unknown 404 |
| GET | `/api/v1/patient/documents/{documentId}/content` | 200 | Step 23 checksum-verified download; audited PATIENT access |
| POST | `/api/v1/departments` | 201 | Step 24 department master data; manager tier; idempotent (keyed) |
| GET | `/api/v1/departments` | 200 | Step 24 facility-scoped department listing |
| GET | `/api/v1/departments/{departmentId}` | 200 | Step 24 one department (own facility only) |
| POST | `/api/v1/departments/{departmentId}/deactivate` | 200 | Step 24 lifecycle status change; no physical delete; idempotent |
| POST | `/api/v1/specimens/{specimenId}/transitions` | 200 | Step 27 lifecycle transition; REJECTED requires `rejectionReason` (bounded vocabulary, else 422); RECEIVED assigns an immutable accession number |
| POST | `/api/v1/quality/records` | 201 | Step 27 quality record; `quality.manage` (manager tier); idempotent (keyed); optional analytical hold |
| GET | `/api/v1/quality/records` | 200 | Step 27 facility-scoped quality listing (`family` filter); manager tier |
| POST | `/api/v1/quality/holds/release` | 200 | Step 27 releases the active analytical hold (`quality.manage`); audited; idempotent replay |

Response bodies are the application DTOs of `src/app/dto.ts` verbatim: no
repository rows, no audit internals, no provenance objects (only source
kind/label/ref), no secrets. Report authorship is bound to the session actor —
client-supplied author fields are not accepted over HTTP.

### HTTP status mapping

| Status | When                                                                             |
| ------ | -------------------------------------------------------------------------------- |
| 400    | Malformed JSON body                                                              |
| 401    | No session resolves (shipped fail-closed posture)                                |
| 403    | `FORBIDDEN` / `SCOPE_MISMATCH` from the application boundary                     |
| 404    | Unknown route, or `NOT_FOUND` from the application boundary (no existence leak)  |
| 405    | Method not GET/POST                                                              |
| 409    | `INVALID_STATE_TRANSITION` / `CONFLICT` / `IDEMPOTENCY_CONFLICT`                 |
| 413    | Body exceeds the configured size limit                                           |
| 415    | Content-Type is not `application/json`                                           |
| 422    | `VALIDATION_FAILED` (transport shape or application validation)                  |
| 500    | Unexpected failure — generic message only; no stacks, SQL, paths, or credentials |

Error bodies always use the §3 shape, including transport-originated failures.

### Operational health endpoints (Step 12)

Root-scoped infrastructure probes outside `/api/v1` — they never require a
session, never touch the session resolver, and never expose dependencies'
error details. Both echo the correlation ID header.

| Endpoint   | Method | Success                                                           | Failure                                                                                                      |
| ---------- | ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/healthz` | GET    | `200 {"status":"ok"}` (process-local liveness; no dependency I/O) | n/a                                                                                                          |
| `/readyz`  | GET    | `200 {"status":"ok","dependencies":{...}}`                        | `503` with `status:"unavailable"` and per-dependency status only — no SQL, stacks, endpoints, or credentials |

Access logging and metrics are opt-in composition options of the HTTP server
(`logger`, `metrics`, `readinessProbes`); they add no new API surface and
carry no PHI (see `docs/DEPLOYMENT.md` §4).

## 8. Application contract (supported)

In-process laboratory services (`src/app/laboratory/`) over the domain
contracts. Each operation validates input, enforces server-derived scope,
invokes domain behavior, persists through injected ports, emits audit, and
returns a DTO — never a domain entity.

| Operation                         | Scope enforced | Idempotent | Audit emitted                                                |
| --------------------------------- | -------------- | ---------- | ------------------------------------------------------------ |
| `createOrder`                     | org/facility   | keyed      | `CREATED` diagnostic-order                                   |
| `transitionOrder` / `cancelOrder` | org/facility   | no         | `TRANSITIONED` / `CANCELLED`                                 |
| `getOrder`                        | org/facility   | n/a (read) | none                                                         |
| `collectSpecimen`                 | org/facility   | keyed      | `CREATED` specimen (+ order `TRANSITIONED` ORDERED→ACQUIRED) |
| `transitionSpecimen`              | org/facility   | no         | `TRANSITIONED` specimen                                      |
| `enterObservation`                | org/facility   | keyed      | `CREATED` observation                                        |
| `addInterpretation`               | org/facility   | keyed      | `CREATED` interpretation                                     |
| `createReport`                    | org/facility   | keyed      | `CREATED` diagnostic-report                                  |
| `finalizeReport`                  | org/facility   | no         | `FINALIZED` diagnostic-report                                |
| `amendReport`                     | org/facility   | no         | `AMENDED` diagnostic-report                                  |
| `getReport`, list views           | org/facility   | n/a (read) | none                                                         |
| `registerPatient`                 | org/facility   | keyed      | `CREATED` patient                                            |
| `attachExternalIdentifier`        | org/facility   | keyed      | `CREATED` patient-external-identifier                        |
| `getPatient`                      | org/facility   | n/a (read) | none                                                         |
| `createMapping` (terminology)     | org/facility   | keyed      | `CREATED` terminology-mapping                                |
| `getMapping` (terminology)        | org/facility   | n/a (read) | none                                                         |
| `resolveMappings` (terminology)   | org/facility   | n/a (read) | none                                                         |
| `createCharge` (billing)          | org/facility   | keyed      | `CREATED` charge                                             |
| `getCharge` (billing)             | org/facility   | n/a (read) | none                                                         |
| `listChargesForOrder` (billing)   | org/facility   | n/a (read) | none                                                         |

Provenance: every mutation records actor (session), explicit source kind
(human/device/algorithm/integration/system), timestamp, and
organization/facility context. Replays emit no duplicate audit events.
DTO identifiers re-entering the boundary are re-validated as branded UUID v4.**Explicitly not a framework-based or deployed API.** No OpenAPI files are
published, no middleware chain, no tokens, no rate limiting; authentication
enforcement remains deferred and fail-closed (see §9). The transport layer is
local, contract-tested code — not a deployed service.

`createPostgresLaboratoryRuntime` (now in `src/infrastructure/runtime/`) is the
current runtime composition root. It wires the laboratory services to the
existing PostgreSQL repositories, audit port, and durable idempotency store,
and is injected into the transport router at the composition edge. The patient
registration service composes the same runtime (a write-capable patient
repository extending the existing read-only `PatientDirectory` port). Disposable
PostgreSQL tests prove the order-to-report flow, the registration flow, scope
checks, and persisted audit/provenance — including over real HTTP requests.

## 9. Authentication state (Step 10 foundation, explicit limitations)

The `SessionResolver` seam is now backed by a minimal credential mechanism
(`src/transport/auth.ts`): an `Authorization: Bearer <token>` header is
resolved through an injected `CredentialDirectory` port into the existing
`ApplicationSession` (actor + server-derived organization/facility scope).
Absent, malformed, and unknown credentials resolve to no session and the
guard maps that to the mandated `401 UNAUTHENTICATED` envelope; the shipped
default without an injected directory remains fail-closed for every request.
Token comparison is constant time and no authentication detail is ever
reflected in responses or errors.

Explicit limitations (still future per `docs/SECURITY.md` §2): no passwords,
no cookie sessions for staff, no OAuth 2.0/OIDC, no SSO, no MFA, no refresh
tokens, no revocation/rotation, no RBAC. Credential bindings are external
configuration; this repository carries deterministic test fixtures only. This
is an authentication FOUNDATION — not production authentication, and no such
claim is made.

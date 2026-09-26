# SDIS Interoperability Architecture

Status: Step 1 — **architectural boundaries and adapter contracts only.**
No external systems are connected. No production HL7/FHIR/DICOM/HMS/device traffic.

## 1. External-reference boundary (HMS)

- HMS integration uses an **external reference** (`ExternalSystemReference`) attached
  to SDIS entities (patient, order, result). HMS records are never re-created inside
  SDIS, and no HMS database is embedded.
- Conceptually: `HMS Patient → Encounter → Diagnostic Order → SDIS`.

## 2. FHIR (planned)

Reserved resource alignment, for future APIs/interoperability:

```text
Patient · Encounter · ServiceRequest · Specimen · Observation ·
DiagnosticReport · Practitioner · Organization · Device · Provenance · Bundle
```

No FHIR conformance claim: profiles, validation, and interoperability tests are
prerequisites before any claim is possible.

## 3. HL7 v2 (planned)

Reserved for instrument connection and message-based integration when a real,
authorized integration exists. No claim.

## 4. DICOM / DICOMweb / PACS boundary

Reserved concepts only: imaging study identity, accession number, modality
worklists, study/series/instance relationships, PACS archive abstraction.

- **No DICOM objects are implemented.**
- **No PACS is connected.**
- No DICOM support is claimed merely because the boundary exists.

## 5. IHE profiles — applicability matrix

| Domain                 | Profiles to evaluate (future) | Relevance                |
| ---------------------- | ----------------------------- | ------------------------ |
| Laboratory             | LDTF, LTW, LA1/LA2 (planned)  | Lab workflow, worklist   |
| Patient administration | PAM, PDQ, PIX (planned)       | Identity feeds           |
| Audit                  | ATNA (planned)                | Audit trail & node auth  |
| Document sharing       | XDS / XDS-I (planned)         | Report/document exchange |
| Imaging                | SWF, MHD (planned)            | Workflow + metadata      |
| Workflow               | XDS-Workflow (planned)        | Order flow               |

Architecture resemblance is **not** IHE support.

## 6. Terminology mapping

```text
Internal canonical code
        ↕
External terminology mapping  (LOINC, SNOMED CT, UCUM, ICD, local codes, external codes)
```

Implemented as a type-level contract in `src/domain/terminology/`. No licensed
terminology data is bundled.

## 7. Devices & diagnostic equipment

```text
Device Registry
      ↓
Device Adapter
      ↓
Acquisition
      ↓
Raw Data
      ↓
Normalization
      ↓
Observation
      ↓
Interpretation
      ↓
Report
```

Preserved through provenance: source device, adapter, acquisition timestamp,
ingestion timestamp, and interpretation source.

- `src/domain/devices/` implements the registry and adapter interfaces.
- **No real hardware is connected.**

## 8. Integration gateway (implemented boundary — Step 17)

Central boundary **for protocol adapters**: external system → `IntegrationAdapter`
(normalization) → canonical SDIS command → `IntegrationGateway` → EXISTING
application services → canonical response → adapter acknowledgement. External
systems never reach a repository or the database, and cannot bypass patient
identity, tenant/facility scope, RBAC, provenance, audit, idempotency, or the
clinical lifecycle rules.

- Ports/contracts: `src/app/integration/integration-gateway.ts`
  (`IntegrationAdapter`, `IntegrationAdapterRegistry`, `CanonicalCommand`).
- Reference adapter: `src/infrastructure/integration/hms-synthetic-adapter.ts`
  (`HMS-SYNTHETIC`) — synthetic, contacts nothing, used only for boundary proof.
- Operations supported: patient reference resolution, patient registration,
  external-reference attachment, diagnostic order submission, order status,
  report/result retrieval (Observation → Interpretation → Report kept distinct),
  plus the Step-20 operations below.
- Provenance: externally initiated mutations are recorded with the existing
  `INTEGRATION` source kind; an adapter claiming any other kind is refused.
- Audit: `IMPORTED` for inbound mutations, `EXPORTED` for outbound clinical
  retrieval, through the existing append-only recorder.

## 8a. External-system identity, order references, and inbound results (implemented — Step 20)

- **External-system registry (IMPLEMENTED, VERIFIED).** `sdis.external_systems`
  (migration 017) is the formal identity of an integration counterpart — never a
  human principal, never an SDIS patient. The gateway refuses any system that is
  unregistered or not `ACTIVE` before normalizing a payload (fail-closed, without
  disclosing registered keys). `config_ref` stores a NON-SECRET configuration
  reference only; credential/secret management is a documented DEFERRED dependency.
  Port: `ExternalSystemRegistry`; PostgreSQL: `PostgresExternalSystemRegistry`;
  in-memory: `InMemoryExternalSystemRegistry`.
- **Order external references (IMPLEMENTED, VERIFIED).**
  `sdis.order_external_references` (migration 017, append-only — no UPDATE/DELETE
  grants) maps an external system's own order id to the canonical SDIS order.
  Uniqueness is per (external system, external reference): the same external value
  under a different system is a different reference. A conflicting remap fails with
  `ConflictError`; the canonical order id is never overwritten. `SUBMIT_ORDER`
  records the mapping; `ORDER_EXISTS` resolves it back (outbound correlation) and
  returns the canonical DTO verbatim annotated with `externalSystem` /
  `externalOrderRef` — nothing is flattened.
- **Inbound result boundary (IMPLEMENTED, VERIFIED).** `INBOUND_RESULT` maps an
  external result onto a canonical OBSERVATION through the EXISTING observation
  service — scope, specimen binding, idempotency, and provenance stay enforced
  there. The gateway records `INTEGRATION` provenance; it never invents clinical
  authorship, never writes clinical records directly, and never produces
  interpretations or reports from inbound results. Vendor result formats are
  deliberately out of scope (no analyzer integration, no clinical validation rules).
- **RBAC.** `integration.manage` (manager tier) covers external-system
  registration administration; all gateway operations remain behind the existing
  authenticated session + permission + scope chain.
- **SWASTHYA HMS readiness (ARCHITECTURE-READY, DEFERRED).** The adapter boundary,
  system identity, external-reference correlation, and canonical operations above
  are the required seams. A future real integration requires: an authorized HMS
  contract, credentials/secret management, and a protocol decision — none exist
  here, and none may be invented in advance.

**No protocol adapter is implemented.** No FHIR, HL7 v2, DICOM/DICOMweb, IHE, or
ATNA message schema is defined, and no conformance is claimed: the gateway is
standards-READY, not standards-compliant. No production endpoint, credential, or
live SWASTHYA/HMS connection exists. The runtime composition registers ZERO
external systems by default (the gateway fails closed).

**No protocol adapter is implemented.** No FHIR, HL7 v2, DICOM/DICOMweb, IHE, or
ATNA message schema is defined, and no conformance is claimed: the gateway is
standards-READY, not standards-compliant. No production endpoint, credential, or
live SWASTHYA/HMS connection exists. The runtime composition registers ZERO
external systems by default (the gateway fails closed).

## 9. Notifications & event delivery (implemented foundation — Step 19)

An internal event/notification foundation exists (`src/app/notifications/`):

- **Event model**: bounded event types over the actual capability surface
  (`patient.registered`, `order.created`, `specimen.state_changed`,
  `observation.available`, `report.finalized`, `report.amended`,
  `charge.created`, `device.acquisition_received`, `inventory.low_stock`,
  `setup.config_changed`), schema-versioned envelope with event id,
  aggregate reference, server-derived tenant/facility scope, correlation id,
  source kind/label, and bounded string metadata only — never clinical
  payloads.
- **Durable delivery (outbox)**: events and per-channel delivery intents are
  enqueued transactionally (`notification_events` → `notification_intents` →
  `notification_delivery_attempts`), with an in-process dispatcher that claims
  due intents and settles every outcome through the explicit delivery state
  machine (PENDING/PROCESSING/DELIVERED/FAILED/RETRYING/PERMANENTLY_FAILED/
  CANCELLED). Attempts are bounded (default 5) with deterministic exponential
  backoff (1 s base, 60 s cap); exhausted intents finalize to
  `PERMANENTLY_FAILED`.
- **Idempotency**: duplicate events/queueing/worker executions are refused by
  database constraints (`event_key`, `event_id+channel`, `intent_id+attempt`),
  and every claim/settle is a CAS on status — concurrent dispatchers are
  single-winner with no double delivery.
- **Channel boundary**: application `NotificationService` →
  `NotificationChannelAdapter` port → adapters. The only implemented channel
  is `IN_MEMORY` (deterministic test/development adapter; pre-programmable to
  reject/fail so failure behavior is provable).
- **Surface**: delivery intents are a scope-checked, permission-gated read
  model over HTTP (`GET /api/v1/notifications`, detail, manager-tier
  retry/cancel). Emitting never mutates authoritative clinical state; events
  are emitted inside application services, never over HTTP.
- **NOT claimed**: no real SMS/email/webhook/push providers (documented
  adapter targets, deferred), no external message broker, no clinical alert
  rules, no exactly-once across a provider boundary (provider delivery
  semantics belong to the provider, not SDIS).

## 10. Step 1 reality

Nothing external is integrated. Interfaces and contracts exist and are tested with
synthetic fixtures only; the Step-17 gateway boundary is exercised end-to-end with
the `HMS-SYNTHETIC` reference adapter over in-memory and disposable-PostgreSQL
repositories, and the Step-19 notification boundary with deterministic in-memory
delivery adapters.

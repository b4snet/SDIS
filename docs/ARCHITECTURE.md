# SDIS Master Architecture

Status: Step 4 — **laboratory application runtime, disposable PostgreSQL
persistence, and a minimal HTTP transport boundary are implemented locally;
authentication and production infrastructure remain deferred**.

## 1. Product definition

- **Name:** Swasthya Diagnostic Information System (SDIS).
- **Purpose:** a standards-first, extensible diagnostic information platform. It must
  operate standalone (Registration → Investigation) and integrate later with an HMS
  (HMS Patient → Encounter → Diagnostic Order → SDIS) without duplicating identity.
- **Initial scope:** Laboratory. Non-laboratory diagnostic domains (ECG, EEG, PFT,
  TMT, Echo, Ultrasound, Imaging, and others) must plug into the same platform model.

## 2. Conceptual layers

```text
SDIS
│
├── Identity & Access
├── Organization / Facility / Department
├── Patient & Registration
├── Investigation / Diagnostic Orders
├── Laboratory
├── Specimen Management
├── Results
├── Reports
├── Billing
├── Documents
├── Emergency
├── Medical Inventory
├── Analytics
├── HMIS / Daily Reporting
├── Devices & Diagnostic Equipment
├── Interoperability
├── Audit & Provenance
├── Quality Management
├── Notifications
└── Integration Gateway
```

These layers define **boundaries**, not a mandate to implement everything now.

## 2.1 Canonical dependency direction (enforced)

```text
Transport → Application → Domain/Ports ← Infrastructure
```

Rules, enforced by `tests/architecture/dependency-direction.test.ts` and
`tests/architecture/boundary-hardening.test.ts`:

- **Domain** imports only its own module and the shared `types` layer. No
  domain-to-domain, core, infrastructure, transport, or app imports.
- **Core** (audit, observability) imports only `types`.
- **Application** imports app, domain, core, and types — never infrastructure
  or transport. Infrastructure specifics reach application only through ports.
- **Transport** never imports infrastructure. Infrastructure mechanisms
  (PostgreSQL RLS request scope, readiness probes) are injected at the
  **composition edge** (`src/index.ts`). Transport owns the request-scope
  SEAM (`src/transport/request-scope.ts`); the edge injects the PostgreSQL
  implementation (`runWithTenantScope`).
- **Infrastructure** implements application ports; it never imports transport.
- **Environment access**: `process.env` is read only in the bounded allowlist —
  the transport auth seam (`sessionResolverForEnvironment`), the server's
  default resolver selection, and the infrastructure process boundary
  (database connection, backup tooling path). Application and domain code
  never touches the environment.
- **Logging discipline**: application and transport write only through the
  structured `Logger`; direct `console.*` calls are architecture-test
  violations. Infrastructure keeps its explicit process-level writers
  (migration progress, embedded-PG test log).

Step 26 hardening record: the transport barrel previously re-exported the
PostgreSQL readiness probe and `server.ts` imported `runWithTenantScope`
directly — both crossed the transport → infrastructure boundary. The barrel
is now infrastructure-free and the scope runner is an injected option
(`requestScopeRunner`), with `src/index.ts` as the composition edge.

## 3. Modality-extensible platform (not a laboratory one-off)

SDIS is a **Diagnostic Platform** with pluggable modalities. Laboratory is the first
modality; Cardiology, Neurodiagnostics, Pulmonary, and Imaging are future modalities.

```text
Diagnostic Platform
        │
        ├── Laboratory      (LAB)      — initial modality
        ├── Cardiology      (ECG|TMT|ECHO)
        ├── Neurodiagnostics(EEG)
        ├── Pulmonary       (PFT)
        ├── Imaging         (ULTRASOUND | RADIOLOGY)
        └── Other diagnostics
```

Rules:

- No `if modality == LAB` branching in the core domain.
- The modality registry (`src/domain/modality/`) is the single extension point.
- A diagnostic capability (order, specimen, observation, interpretation, report) is
  declared per modality via capability descriptors, not hard-coded switches.
- Extensibility is proven by a test that adds LAB, ECG, EEG, PFT, TMT, ECHO, and
  ULTRASOUND to the registry without modifying the core (see `docs/TESTING_STRATEGY.md`).

## 4. Canonical domain model

```text
Organization
   ↓
Facility
   ↓
Department / Diagnostic Unit
   ↓
Patient
   ↓
Encounter / Visit
   ↓
Diagnostic Order
   ↓
Order Item
   ↓
Specimen / Acquisition
   ↓
Observation / Measurement
   ↓
Interpretation
   ↓
Diagnostic Report
```

Companion concepts: Practitioner · Device · Analyzer · Modality · Billing (Billable
Service → Charge → Invoice → Payment) · Document · Audit · Provenance · Notification.

Mandatory in the Step-1 conceptual model: Organization, Facility, Department, Patient,
Encounter, Diagnostic Order, Order Item, Specimen, Observation, Interpretation,
Diagnostic Report, Device, Modality, Audit, Provenance, Billing, Document.

Optional / future: Notifications engine, Analytics read models, Emergency module,
national reporting, AI assistance.

**Step 1 implements interface contracts for these concepts, not full tables.**

## 5. Distinct concepts: Observation vs Interpretation vs Report

These MUST remain distinct (see `docs/CLINICAL_SAFETY.md`):

| Concept        | Definition                                           | Source             |
| -------------- | ---------------------------------------------------- | ------------------ |
| Observation    | A measured or observed data point                    | device/human       |
| Interpretation | Human/device/algorithm reading of observations       | preserved source   |
| Report         | Clinical communication artifact assembling the above | finalized artifact |

There is **no** single conflated `Result` object.

## 6. Clinical data lifecycle

```text
ORDERED
   ↓
ACQUIRED / COLLECTED
   ↓
PROCESSING
   ↓
RESULT ENTERED
   ↓
VERIFIED
   ↓
FINALIZED
   ↓
REPORTED
```

Supporting: draft, verification, finalization, amendment/correction (new version,
never silent overwrite), historical version, provenance.

## 7. API-first boundary

- Public API boundary and internal service boundary are distinct.
- APIs expose stable DTO/resource contracts, never raw database models.
- Versioning, error format, idempotency, pagination, filtering, correlation IDs,
  audit, and external-integration contracts: see `docs/API_CONTRACTS.md`.
- Step 4 adds the minimal transport ring locally (`src/transport/`):
  `node:http` → route table → application services → domain. The transport
  imports application/domain/types only — never infrastructure — and performs
  transport-shape validation only. Authentication ships fail-closed deferred.

## 8. Event-driven extensibility

Initial posture: **modular monolith with explicit internal domain events**. Distributed
event infrastructure is deferred; the evolution boundary is documented in
`docs/API_CONTRACTS.md`. Event use-cases reserved: analyzer ingestion, critical values,
report finalization, notifications, billing, interoperability, analytics, audit.

## 9. Module status (Step 3)

| Layer                                | Status                                                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Identity & Access                    | Contract boundary (RBAC types, audit hooks) — deferred                                             |
| Organization / Facility / Department | Contract implemented                                                                               |
| Patient & Registration               | Contract implemented (identity boundary)                                                           |
| Investigation / Diagnostic Orders    | Contract implemented (lifecycle types)                                                             |     | Laboratory | **Implemented** (service flow + PostgreSQL runtime wiring) |
| HTTP/API transport                   | **Implemented locally** (`src/transport/` over `/api/v1`; not deployed; auth fail-closed deferred) |
| Specimen Management                  | **Implemented** (collection + lifecycle + persistence)                                             |
| Results                              | **Implemented** (observation / interpretation / report persistence)                                |
| Reports                              | **Implemented locally** (draft/finalize/amend persistence)                                         |
| Billing                              | Contract boundary only — deferred                                                                  |
| Documents                            | Contract boundary only — deferred                                                                  |
| Emergency                            | Deferred                                                                                           |
| Medical Inventory                    | Contract boundary only — deferred                                                                  |
| Analytics                            | Contract boundary only — deferred                                                                  |
| HMIS / Daily Reporting               | Contract boundary only — deferred                                                                  |
| Devices & Diagnostic Equipment       | Adapter interface implemented                                                                      |
| Interoperability                     | Contract boundary only — deferred                                                                  |
| Audit & Provenance                   | **Implemented locally** (append-only schema + service events)                                      |
| Quality Management                   | Contract boundary only — deferred                                                                  |
| Notifications                        | Deferred                                                                                           |
| Integration Gateway                  | Deferred                                                                                           |

See `docs/PROJECT_STATUS.md` for the live matrix.

## 10. Module boundary specifications (Step 1 definitions)

### 10.1 Billing

`Billable Service → Charge → Invoice → Payment`. Reserved: discounts, packages,
corporate billing, insurance, HIB, SSF, payer-specific rules, refunds, adjustments,
reconciliation. **No statutory tax rules are implemented from memory**; any statutory
logic later requires configurable, date-effective, source-versioned rules.
Idempotency keys prevent duplicate irreversible financial effects.

### 10.2 Documents (Scanned Documents & generated)

Metadata + object-storage abstraction + encryption + access control + versioning +
provenance + retention + audit + secure download. Document types reserved:
requisitions, referrals, reports, consents, patient documents, billing documents,
quality documents, calibration certificates, SOPs, certificates. Not bound to local
filesystem storage; no S3 claim is made unless actually configured.

### 10.3 HMIS Reports & Daily Reports

Two reporting domains, built from a reporting data model (aggregation boundary,
access controls, scheduled reports, export boundary, future national reporting).
Daily Reports is first-class: daily registration, investigations, specimen counts,
results, billing, revenue, inventory movements, critical values, turnaround metrics,
operational workload. Report logic is never hard-coded into transactional
controllers.

### 10.4 Master Setup

Configuration domain: organization, facility, department, laboratory section, test
catalog, specimen types, units, reference ranges, packages, pricing, billing
configuration, report templates, users, roles, permissions, devices, analyzers,
modalities, document types, quality settings, notification settings. Establishes
configuration source-of-truth rules; not implemented now.

### 10.5 Laboratory Medical Inventory

Separate from diagnostic results: reagents, consumables, kits, controls,
calibrators, batches, lot numbers, expiry, storage, stock movement, wastage,
procurement, vendor, equipment consumables. Inventory state is not duplicated
across laboratory departments.

Step-31 completion (operational foundation, still NOT an ERP/procurement/
pharmacy/warehouse system):

- **Ledger authority** — stock is DERIVED from the append-only movement
  ledger (`sdis.stock_movements`); there is no mutable quantity column and
  no second balance store. Every movement is attributable (required bounded
  reason) and optionally references the laboratory operation (order/QC id)
  that caused it (`operationRef`).
- **Item master** — facility-scoped, unique sku; bounded category vocabulary
  (REAGENT / CONSUMABLE / KIT / CONTROL / CALIBRATOR / OTHER); explicit
  active lifecycle (retired items accept no stock activity).
- **Lot lifecycle** — AVAILABLE -> QUARANTINED -> RELEASED with RETIRED
  terminal; controlled, reasoned, audited transitions (409 otherwise).
- **Expiry** — derived three-state view (VALID / EXPIRING_SOON / EXPIRED);
  expired/quarantined lots remain visible in history and are never deleted
  or silently mutated; consumption (OUT) of non-consumable lots is refused,
  while WASTAGE remains the disposal path (§18).
- **FEFO** — deterministic read-only selection (earliest expiry, then
  receivedAt, then lotNumber) over consumable, balance-positive lots;
  selection never consumes — issueStock re-applies every gate.
- **Traceability** — `lots/{id}/usage` and `operations/{ref}/usage` answer
  which lot served which laboratory operation; history is append-only.
- **Concurrency** — the negative-stock invariant is enforced by a single
  conditional UPDATE in PostgreSQL (atomic check-and-decrement), mirrored
  in the in-memory repository; keyed idempotency prevents duplicate
  receipts/issues on retry.
- **Isolation** — every item, lot, movement, and query is tenant- and
  facility-scoped server-side (RLS + application scope checks).

### 10.6 Emergency

Reserved top-level module; deferred (architectural boundary only).

### 10.7 Analytics

Aggregation read models over the transactional domains; access-controlled;
deferred.

### 10.8 Notifications

Reserved for critical values, report finalization, workflow events; event-driven;
deferred.

## 11. Roadmap

See `docs/ROADMAP.md`. Step 1 implements only foundation boundaries.

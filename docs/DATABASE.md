# SDIS Database Architecture

Status: Step 3 — **disposable PostgreSQL migrations and application persistence
are implemented and tested locally; production infrastructure is not deployed.**

## Strategy

- **Engine:** PostgreSQL (selected target). Rationale: RLS for tenant/facility
  isolation, strong constraints, JSON support, mature migration tooling.
- **Identifier strategy:** UUID v4 for all public identifiers (code-level branded
  types). Internal autoincrement keys (if any) are implementation-private and never
  exposed through APIs.
- **Migrations:** versioned, ordered, forward-only files in `db/migrations/`.
  A migration must be reversible by a corresponding downgrade script until deployed.
- **Concurrency:** optimistic concurrency via `version` columns or `updated_at`
  guards; explicit transaction boundaries for multi-write invariants.
- **Tenant/facility isolation:** every tenant-scoped table carries
  `organization_id` and, where applicable, `facility_id`; enforced by RLS policies
  keyed to the authenticated context. Facility/tenant scoping is enforced on the
  database, never trusted from client input.
- **Idempotency keys are facility-tagged and RLS-scoped (SEC-03):**
  `sdis.idempotency_keys` carries a nullable `facility_id` written from the
  facility-composed key (`scope:facility:key`); RLS isolates tagged rows per
  facility (untagged legacy rows expire within the 24-hour TTL), a
  RESTRICTIVE policy requires the facility GUC, and the DELETE grant is
  revoked from `sdis_app` (expiry is predicate-based; the cleanup function
  has no caller). Values remain full operation DTOs — key secrecy plus RLS
  is the documented boundary, not value minimization.

## Schema organization

```text
db/
  migrations/      # ordered SQL migrations
  seeds/           # synthetic fixtures only — never real data
  policies/        # RLS policy definitions
```

## Planned schema families (architecture-ready, NOT yet created)

| Family            | Core tables (future)                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Identity & access | users, roles, permissions, user_roles, sessions                                                  |
| Organization      | organizations, facilities, departments, diagnostic_units                                         |
| Patient           | patients, patient_identifiers (hospital MRN, national ID as external refs), patient_merge_events |
| Encounter         | encounters                                                                                       |
| Ordering          | diagnostic_orders, order_items                                                                   |
| Specimen          | specimens, specimen_events                                                                       |
| Results           | observations, interpretations, reports, report_versions                                          |
| Audit             | audit_events (append-only), provenance (actor/source/timestamp/context)                          |
| Billing           | billable_services, charges, invoices, payments, idempotency_keys                                 |
| Documents         | documents, document_versions                                                                     |
| Inventory         | inventory_items, stock_movements, batches, lots                                                  |
| Quality           | qc_runs, training_records, calibrations, nonconformities (future)                                |
| Terminology       | terminology_mappings (created, migration 008); code_systems (future)                             |
| Devices           | devices, device_adapters, acquisitions                                                           |

## Invariants (non-negotiable, enforced in DB where possible)

1. A diagnostic result cannot belong to the wrong patient.
2. A diagnostic result cannot belong to the wrong order.
3. A specimen cannot silently change patient identity.
4. A finalized result cannot be silently overwritten.
5. A finalized report cannot be silently rewritten.
6. Provenance (source/actor/timestamp) cannot disappear.
7. Data cannot cross organization boundaries.
8. Data cannot cross facility boundaries without authorized semantics.
9. Retries cannot duplicate irreversible financial effects.
10. Material mutations remain attributable.

## What was actually created locally

- Ordered migrations `001` through `013` create the current disposable schema,
  constraints, indexes, audit structures, idempotency table, terminology,
  billing, device ingestion, document metadata, inventory (items, lots, and an
  append-only stock-movement ledger whose balance is DERIVED), and scoped
  master-setup configuration (append-only versions — no UPDATE/DELETE grant),
  with RLS policies throughout.
- `MigrationRunner` replays the chain from an empty embedded PostgreSQL database
  and detects zero pending migrations on repeat.
- `createPostgresLaboratoryRuntime` wires application services to PostgreSQL
  repositories. Tests use synthetic seed data only.
- Backup/restore is proven locally with disposable PostgreSQL tooling. This is
  not a production disaster-recovery or RPO/RTO claim.
- Step 18 recovery hardening: `src/infrastructure/database/backup-restore.ts`
  provides `createBackup` (deterministic artifact + SHA-256), `restoreBackup`
  (checksum-validated, isolated-target-only; protected databases require the
  explicit `CONFIRM-IN-PLACE-RESTORE` token), and `verifyRecovery` (schema,
  constraints, indexes, RLS objects, migration state, `sdis.verify_audit_chain`
  hash-chain integrity per (organization, facility), tenant isolation under the
  application role, finalized/amendment integrity, persisted idempotency).
  `tests/infrastructure/recovery.test.ts` proves the full loop — backup →
  restore into a destroyed database → verify → application reuse with idempotent
  replay — plus explicit failures (missing artifact, corrupt artifact, refused
  protected target, unavailable server, tampered audit chain). Artifacts land
  under `tmp/` (gitignored); no credentials in source or logs.

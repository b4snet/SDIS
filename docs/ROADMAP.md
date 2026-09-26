# SDIS Master Roadmap

Status: **FOUNDATION COMPLETE** — Steps 1–34 implemented and gate-measured
(821/821 tests, build/typecheck/lint/format/audit clean) by the Step-35
foundation audit (`docs/FOUNDATION_GATE.md`, `docs/BASELINE_AUDIT_1-35.md`),
then independently re-audited (`docs/SDIS_FULL_AUDIT_STEPS_1_35.md`) and
remediated (`docs/SDIS_STEPS_1_35_REMEDIATION_REPORT.md`, final gate
**894/894 tests, 233 suites, 0 fail** across 31 migrations).
This status covers the Foundation boundary only — the product capabilities
below are NOT yet implemented and remain the post-foundation plan.

## FOUNDATION — COMPLETE (Steps 1–34)

- Project architecture ✓ (strict TS, 4-ring layering, lint/format/build gates)
- Identity/access boundary ✓ (bearer credential foundation, RBAC, scoped sessions)
- Organization/facility boundary ✓ (fail-closed RLS tenancy + facility scope)
- Patient registration boundary ✓ (registration, encounters, provenance, isolation)
- Master setup boundary ✓ (FACILITY/DEPARTMENT config families, departments)
- Audit/provenance foundation ✓ (hash-chained append-only audit)
- Data model contracts ✓ (31 forward-only migrations, domain aggregates)
- Laboratory workflow ✓ (order→specimen→accession→result→verify→finalize→report)
- Reporting ✓ (immutable finalization, reason-bound amendments, versioned content)
- Worklists ✓ (typed operational views, keyset pagination, per-view RBAC)
- Billing / inventory / documents / QC-foundation / observability / backup-recovery
  ✓ (foundation slices; see the audit matrix for per-step status)
- Notifications ✓ (durable event/notification delivery foundation — Step 19:
  schema-versioned events, per-channel intents with an explicit delivery state
  machine, append-only attempt ledger, PostgreSQL outbox + dispatcher with
  bounded deterministic retries and DB-layer idempotency, facility/tenant RLS,
  HTTP read model + manager-tier retry/cancel; IN_MEMORY channel real,
  EMAIL/SMS/WEBHOOK provider adapters deferred)

Foundation residual debt (BASELINE-01…11) was dispositioned in the 2026-09-25
cleanup run — each finding is FIXED, VERIFIED NON-BLOCKING, or INTENTIONAL /
DOCUMENTED (see `docs/BASELINE_AUDIT_1-35.md` §19).

## CORE LABORATORY (post-foundation)

- Critical-value / emergency-result clinical pathways; exception-handling depth
- Result entry/verification UX and portal surfaces; report artifact rendering

## DIAGNOSTIC EXPANSION

- ECG, EEG, PFT, TMT, Echo, Ultrasound, other modalities
- Modality adapters via the existing registry

## ENTERPRISE

- Billing invoices/payments; patient merge/dedup; analytics/HMIS reports
- Integrations (HMS); per-resource ACLs; external IdP federation

## INTEROPERABILITY

- FHIR, HL7, DICOM, IHE, external systems
- Precondition: real, authorized, testable integrations

## INTELLIGENCE

- AI, analytics, decision support — with the AI boundary enforced

## PRODUCTION

- HA/replication/failover, PITR/WAL archiving, tracing, scheduled backup,
  enterprise SSO/audit sinks, deployment, scalability, operational readiness

## GO-LIVE

- Hospital integration, UAT, training, migration, pilot, go-live, stabilization

## Rules for roadmap execution

1. Do not implement everything now.
2. Each Step passes the quality gates (TESTING_STRATEGY.md) before advancing.
3. No premature integration; no speculative migrations.
4. STOP conditions apply at every Step (see the Step-1 prompt contract).

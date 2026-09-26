# SDIS Master Rules

Non-negotiable engineering rules. Every future Step must satisfy these or document an
explicit, reviewed exception.

## Repository-first development

1. The repository is the source of truth. Inspect before deciding.
2. Do not assume stack, schema, or architecture; read the repo.
3. Never fabricate repository contents or baseline numbers.

## Contract-first implementation

4. Public boundaries are defined as contracts (types + documented behavior) before
   implementation. APIs never expose raw database models.
5. A change that breaks an existing contract must be a deliberate, versioned change.

## Clinical rules

6. Never invent clinical rules, reference ranges, thresholds, or interpretations.
7. Clinical rules require an authoritative, versioned, governed source and provenance.
8. No unverified clinical accuracy claims. No "clinically validated" language without
   evidence.
9. Finalized clinical records are immutable. Amendment creates a new version with full
   provenance. Silent overwrite is prohibited.

## Security & tenancy

10. Never store or commit secrets, credentials, or production configuration.
11. No real patient data, no real hospital data, no PHI in development. Synthetic
    fixtures only.
12. Tenant and facility isolation are mandatory; context cannot be forged; RLS is the
    enforcement mechanism where applicable.
13. Least privilege, RBAC, IDOR prevention, audit: see `docs/SECURITY.md`.
14. Do not use client-selected tenant/facility as the authoritative security boundary.

## Data integrity

15. Core identifiers are validated (UUID v4 by default).
16. Relationships are enforced; keywords: patient, order, specimen, result, report,
    provenance, organization, facility, billing idempotency.
17. Transaction boundaries are explicit where multiple writes must be atomic.
18. Append-only audit; actor/source/timestamp/context must never disappear.
19. Retries cannot duplicate irreversible financial effects (idempotency keys).

## Provenance & audit

20. Actor, source, timestamp, and context are recorded for every material mutation.
21. Device, algorithm, human, integration, and system actors are never collapsed into
    a single "verified by" concept.

## Standards

22. No fabricated conformance claims. "Compliant / certified / accredited" are
    forbidden without evidence. Use the approved wording in
    `docs/COMPLIANCE_REGISTER.md` §Conformance language.
23. Never download copyrighted terminology data without license confirmation.

## Process

24. No premature integration: no real HMS/EMR/analyzer/device/PACS/HL7/FHIR/DICOM
    connections without existing, authorized, testable integration code.
25. No speculative migrations, tables, or schemas (see `docs/DATABASE.md`).
26. Quality gates are mandatory (see `docs/TESTING_STRATEGY.md`).
27. No commit, push, or deploy without passing the full verification suite.
28. Web3/DLT is OPTIONAL FUTURE INTEGRATION — never required for core SDIS, never
    stores PHI.

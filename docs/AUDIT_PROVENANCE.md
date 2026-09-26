# SDIS Audit & Provenance Architecture

Status: Step 1 — **contract implemented and tested (append-only semantics).**

## 1. Audit model

Append-only. An audit event records six facets:

| Facet     | Meaning                  | Example                               |
| --------- | ------------------------ | ------------------------------------- |
| Actor     | Who performed the action | user, service, API client             |
| Source    | Where the data came from | analyzer, integration, manual entry   |
| Timestamp | When it occurred         | UTC instant                           |
| Context   | Org/facility/department  | scope identifiers                     |
| Object    | What was affected        | patient, order, report                |
| Action    | What happened            | CREATED, VERIFIED, FINALIZED, AMENDED |

## 2. Provenance source kinds

Provenance must distinguish the origin of data. These are **never collapsed**:

```text
human        — person-entered
device       — instrument/analyzer output
algorithm    — software interpretation
integration  — inbound external system data
system       — internal system process
```

Example: `interpretation.source.kind = ALGORITHM` is not the same as
`interpretation.source.kind = HUMAN`. Verification by a human is a separate,
recorded event (see CLINICAL_SAFETY.md).

## 3. Clinical lifecycle states (see ARCHITECTURE.md)

ORDERED → ACQUIRED/COLLECTED → PROCESSING → RESULT ENTERED → VERIFIED → FINALIZED → REPORTED

- Every transition records audit events.
- Finalized records are immutable; amendments create new versions referencing the
  superseded version (full history retained).

## 4. Invariants

1. Source/actor/timestamp cannot disappear.
2. Material mutations remain attributable.
3. Audit data is append-only — no deletion, no silent edit.
4. Device/algorithm/human are never collapsed into one concept.

## 5. Step 1 code

- `src/core/audit/` — `AuditEvent`, `AuditAction`, `AuditStore` (append contract).
- `src/types/provenance.ts` — `Actor`, `DataSource`, `ProvenanceSourceKind`,
  `Provenance`.
- Tests prove actor/source/timestamp/context are representable and that source
  kinds remain distinct: `tests/provenance/provenance.test.ts`.

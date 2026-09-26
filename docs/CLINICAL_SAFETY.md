# SDIS Clinical Safety Architecture

Status: Step 1 — **architecture and contracts; no clinical rules implemented.**

## 1. Scope of the system

SDIS is **diagnostic information infrastructure**. It does NOT automatically provide:

- medical diagnosis
- autonomous treatment
- autonomous clinical decisions
- unsupported clinical thresholds
- unsupported reference ranges
- unsupported interpretation algorithms

Any future clinical decision support requires: an authoritative clinical source,
versioning, validation, governance, human oversight, and provenance.

## 2. Result vs Interpretation vs Report (never conflated)

| Concept        | Definition                            | Source allowed                        |
| -------------- | ------------------------------------- | ------------------------------------- |
| Observation    | A measured or observed data point     | human or device                       |
| Interpretation | A reading/explanation of observations | human, device, algorithm, integration |
| Report         | Final clinical communication artifact | assembled/verified by human           |

Code separation is enforced at the type level: `Observation`, `Interpretation`, and
`DiagnosticReport` are distinct aggregates (`src/domain/results/`).

## 3. Record immutability

- Finalized results and reports are **immutable**.
- Corrections are **amendments** that produce a new version referencing the
  superseded version; the complete history and provenance remain.
- Silent overwriting of clinically authoritative results is prohibited.

## 4. Data integrity invariants

1. A result cannot belong to the wrong patient.
2. A result cannot belong to the wrong order.
3. A specimen cannot silently change patient identity.
4. A finalized result cannot be silently overwritten.
5. A finalized report cannot be silently rewritten.
6. Provenance (source/actor/timestamp/context) cannot disappear.

## 5. Human verification

- Verification is a distinct, recorded audit event with its own actor.
- Human verification is never implied by device/algorithm output.
- Device and algorithm provenance are preserved separately from human actions.

## 6. AI boundary

Reserved future uses (report drafting, summarization, coding assistance, anomaly
support, workflow assistance, quality review, NLP) are **not implemented**.

Hard rules:

- **AI output ≠ clinical truth**
- **AI output ≠ human verification**
- AI is not embedded into core clinical state transitions.

## 7. Device boundary

Devices (analyzers, ECG/EEG/PFT machines, imaging equipment) enter the platform only
through adapter contracts — never directly into clinical state (see
`docs/INTEROPERABILITY.md` §Devices and `src/domain/devices/`).

## 8. Clinical-rule boundary

No reference ranges, thresholds, or decision rules are implemented in Step 1. Any
future rule must carry: authoritative source, version, validity, and provenance.

## 9. Emergency priority ≠ critical result (Step 21)

Order priority (`ROUTINE | URGENT | EMERGENCY`) is an OPERATIONAL queue
attribute. **IMPLEMENTED, VERIFIED** and proven by tests:

- Priority never modifies an observation value, an interpretation, or a
  report. A report is never labelled "critical" because its order was
  emergency priority — a critical result would require a clinically defined
  critical-value policy, which SDIS deliberately does not implement.
- Priority is validated against the bounded vocabulary, preserved through
  order/specimen/worklist boundaries, and audited on change. It is never a
  diagnosis, never a result, never a clinical recommendation.
- The worklist orders EMERGENCY → URGENT → ROUTINE deterministically. This
  is operational queue ordering, NOT clinical triage.
- Finalized reports remain immutable and the amendment workflow is intact
  regardless of priority. No clinical validation is claimed.

## 10. Patient access boundary (Step 22)

Patient-facing access to finalized diagnostic information is **IMPLEMENTED,
VERIFIED** as an application/API boundary - not a portal:

- **Patient principal**: an `ApplicationSession` with actor kind `PATIENT`
  and the `patient` role claim. The credential binding that backs it is
  infrastructure; no token format, password, OTP, or OAuth flow is invented.
  Staff roles never carry `patient.report.read`; the patient role carries
  nothing else.
- **Ownership**: the authenticated principal maps to exactly ONE canonical
  patient identity through the server-side binding
  (`sdis.patient_principal_bindings` / `PatientPrincipalRegistry`). Patient
  ids, report ids, names, birth dates, phones, or external identifiers
  supplied by a client are NEVER ownership proof. No binding owns nothing
  (fail closed).
- **Visibility**: only FINALIZED report versions are exposed. DRAFT content -
  including the DRAFT head of an amended report - is never shown, and reports
  with no finalized version are invisible (existence is not leaked). A
  foreign report, a draft, and an unknown id are the SAME indistinguishable 404.
- **Patient-safe DTO**: a deliberate projection (`PatientReportView`) - no
  staff references, no provenance objects, no audit internals, no workflow
  state. Observation / interpretation / report remain distinct in the
  canonical model; nothing is flattened.
- **Read-only, no authorship**: access mutates nothing, creates no
  interpretation, no advice, no reference ranges, no diagnosis, and never
  alters report provenance or version history. Each access event is audited
  through the ONE append-only audit path with actor kind `PATIENT` (never
  collapsed into SYSTEM); report content is never written to audit detail.
- **No clinical validation, portal UI, or patient authentication product is
  claimed.** Production credential issuance for patients remains a documented
  dependency (DEFERRED).

## 11. QC hold boundary (Step 27)

The Step-27 quality capability keeps the QC → operational → patient-result
separation explicit and enforced:

- **A hold pauses workflow; it never rewrites data.** An active analytical
  hold (quality record with `hold`, family QC/IQC/EQA/CALIBRATION/...) makes
  report finalization fail with a conflict until an authorized actor releases
  it. No patient result, observation, interpretation, or report content is
  modified by QC events at any point.
- **One active hold per facility** (unique partial index); release is
  audited, idempotent on replay, and never deletes the record.
- **No clinical semantics ride QC.** Quality records carry operational
  reference data only — no thresholds, no ranges, no decision rules. A QC
  failure cannot create, block, or alter a patient diagnostic result; it can
  only pause the operational release boundary.
- **Specimen rejection ≠ clinical judgment.** Rejection reasons come from a
  bounded operational vocabulary (insufficient/incorrect/damaged specimen,
  labeling/processing problem). Rejection preserves the full specimen record
  and its history; it never deletes data and never produces a diagnosis.
- **Accession numbers are operational identity only** (globally-unique,
  assigned exactly once at RECEIVED; the application's accession probe stays
  facility-scoped through the owning order). They never replace global entity
  ids and carry no clinical meaning.

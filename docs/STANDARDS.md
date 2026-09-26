# SDIS Standards Register

Formal register of standards evaluated for SDIS. This register is authoritative.
Conformance language is governed by `COMPLIANCE_REGISTER.md` §Conformance language.

**General note:** SDIS makes NO claim of certification, accreditation, or formal
conformance to any standard. Statuses below mean "design intent / architectural
boundary / contract" unless "tested" is explicitly evidenced in this repository.

## Laboratory quality

| Standard                        | Status                                                                                                                                                                                                                            | Evidence required for a future claim                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| ISO 15189                       | **Architectural boundary / planned.** Aims documented (quality system, document control, records, equipment, QC, information management).                                                                                         | External audit by accreditation body; onsite evidence; cannot be established by software alone |
| ISO 15190                       | **Architectural boundary / planned** (laboratory safety).                                                                                                                                                                         | External audit evidence                                                                        |
| WHO laboratory quality guidance | **Architectural boundary / planned.** WHO material (ISO 15189-oriented) informs quality-system design: documented quality systems, equipment/reagent management, records, document control, safety, continual quality management. | Internal implementation evidence + external assessment                                         |
| CLSI (applicable parts)         | **Planned / evaluate licensing** before embedding any CLSI content.                                                                                                                                                               | License confirmation + conformance evidence                                                    |

## Interoperability / health information

| Standard                       | Status                                                                                                                                                                                         | Notes                                                                                              |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| HL7 FHIR                       | **Architectural boundary / planned.** Reserved resources: Patient, Encounter, ServiceRequest, Specimen, Observation, DiagnosticReport, Practitioner, Organization, Device, Provenance, Bundle. | No FHIR conformance claim. Profiles, validation, and interoperability tests are prerequisites.     |
| HL7 v2                         | **Planned** for instrument/messaging integration.                                                                                                                                              | No claim.                                                                                          |
| DICOM                          | **Architectural boundary** for imaging identity (study/series/instance, accession, modality worklists).                                                                                        | No DICOM objects implemented; no PACS. No claim.                                                   |
| DICOMweb                       | **Planned** (future REST layer).                                                                                                                                                               | No claim.                                                                                          |
| IHE profiles                   | **Planned / evaluate** (laboratory, patient administration, audit, document sharing, imaging, workflow). Applicability matrix: see `INTEROPERABILITY.md` §IHE.                                 | Architecture resemblance is not IHE support.                                                       |
| LOINC / SNOMED CT / UCUM / ICD | **Planned.** Canonical internal codes with external mapping tables (`src/domain/terminology/`).                                                                                                | Licensing must be confirmed before any data embedding; no copyrighted terminology data is bundled. |
| ATC / local test codes         | **Supported design.** Facility-specific and external codes map to internal canonical codes.                                                                                                    | —                                                                                                  |

## Security / privacy / software

| Standard                   | Status                                                                                 | Notes                                  |
| -------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------- |
| ISO/IEC 27001              | **Alignment target (not implemented).** Security practices follow its structure.       | Certification requires external audit. |
| ISO 27799                  | **Alignment target** for health-sector security management.                            | Certification requires external audit. |
| OWASP ASVS / API Security  | **Guidance followed** in design (authz, IDOR, rate limiting, headers, error handling). | Not a certification.                   |
| OAuth 2.0 / OpenID Connect | **Planned** for API and SSO authentication.                                            | No claim.                              |
| SMART on FHIR              | **Planned / evaluate** when FHIR integration is implemented.                           | No claim.                              |

## Web3 / DLT

Status: **OPTIONAL FUTURE INTEGRATION — NOT REQUIRED FOR CORE SDIS.**
Reserved, not implemented: document integrity proofs, provenance anchoring, consent
evidence, hash anchoring, supply-chain traceability, audit notarization. The clinical
source of truth remains in controlled healthcare infrastructure. No PHI on any
public ledger. No speculative blockchain dependencies.

## Traceability

Every standards-driven decision recorded as:

```text
Requirement → Standard/source → SDIS design decision → Implementation status → Test/evidence
```

See `docs/COMPLIANCE_REGISTER.md` and `tests/` (Standards Traceability test section).

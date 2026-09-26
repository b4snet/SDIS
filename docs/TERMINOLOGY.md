# SDIS Terminology Policy

Authoritative vocabulary. Future modules must use these terms consistently.

## Product naming

- Official name: **Swasthya Diagnostic Information System**
- Short name: **SDIS**
- The product is never branded "Core Labs", "Laboratory Core", "Diagnostic Core",
  "HMS", or any other name.

## Core terms (single meaning)

| Term                                  | Meaning                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| SDIS                                  | Swasthya Diagnostic Information System                                       |
| Organization                          | Legal/supervisory entity owning facilities                                   |
| Facility                              | A physical operating site (clinic, lab, hospital)                            |
| Department / Diagnostic Unit          | A unit within a facility where diagnostics are performed                     |
| Patient                               | The person who is the subject of diagnostics (single identity source)        |
| Encounter / Visit                     | A patient interaction with a facility                                        |
| Diagnostic Order                      | A request for diagnostic work                                                |
| Order Item                            | A single test/procedure line within an order                                 |
| Investigation                         | The laboratory (or general diagnostic) work item — collection of order items |
| Specimen / Acquisition                | A collected sample or acquired signal/asset for diagnosis                    |
| Observation                           | A measured or observed data point                                            |
| Interpretation                        | Human/device/algorithm reading of observations                               |
| Result                                | The outcome of an order item (composed of observations + interpretation)     |
| Report                                | The finalized clinical communication artifact                                |
| Modality                              | A diagnostic discipline (LAB, ECG, EEG, PFT, TMT, ECHO, ULTRASOUND, …)       |
| Device                                | Physical diagnostic equipment (analyzer, ECG machine, …)                     |
| Analyzer                              | A laboratory device that produces observations                               |
| Practitioner                          | A clinical user (pathologist, lab technician, physician)                     |
| Registration                          | Creating/updating a patient and/or encounter in SDIS                         |
| Billing                               | Charging/invoicing/payment for billable diagnostic services                  |
| Facility policy / Organization policy | Configuration scopes (facility-local vs organization-wide)                   |
| Accession                             | Assignment of a specimen/order item to a laboratory workflow                 |

## Coding conventions

- URL/resource names use `kebab-case`.
- Database tables use `snake_case`.
- TypeScript identifiers use `camelCase` for values, `PascalCase` for types.
- Identifiers are UUID v4 strings (branded types in code).
- Codes are strings with an explicit code system namespace (e.g., `loinc:2345-7`).

## Reserved-word rules

- Never use "Result", "Interpretation", and "Report" interchangeably — see
  `docs/ARCHITECTURE.md` §5.
- Never call a system-level or device-level actor "verified by" a human.

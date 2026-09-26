# SDIS — Swasthya Diagnostic Information System

Status: **FOUNDATION COMPLETE (Step 35 gate — Steps 1–34 audited; see
`docs/PROJECT_STATUS.md`, `docs/FOUNDATION_GATE.md`)**

## Identity

|               |                                                                      |
| ------------- | -------------------------------------------------------------------- |
| Official name | Swasthya Diagnostic Information System                               |
| Short name    | SDIS                                                                 |
| Purpose       | Standards-first, modality-extensible diagnostic information platform |
| Initial scope | Laboratory                                                           |
| Repository    | <https://github.com/b4snet/SDIS>                                     |

## Documentation index

| Document                      | Purpose                                               |
| ----------------------------- | ----------------------------------------------------- |
| `docs/ARCHITECTURE.md`        | Master product architecture, domain model, boundaries |
| `docs/TERMINOLOGY.md`         | Authoritative terminology policy                      |
| `docs/MASTER_RULES.md`        | Engineering rules (non-negotiable)                    |
| `docs/DATABASE.md`            | Database & schema strategy                            |
| `docs/SECURITY.md`            | Security architecture & healthcare data protection    |
| `docs/TENANCY.md`             | Organization / facility / patient identity model      |
| `docs/AUDIT_PROVENANCE.md`    | Append-only audit & provenance foundation             |
| `docs/CLINICAL_SAFETY.md`     | Clinical safety, immutability, AI boundary            |
| `docs/STANDARDS.md`           | SDIS Standards Register                               |
| `docs/INTEROPERABILITY.md`    | FHIR / HL7 / DICOM / IHE / terminology / devices      |
| `docs/QUALITY_MANAGEMENT.md`  | Quality management architecture                       |
| `docs/API_CONTRACTS.md`       | API-first boundary & resource contracts               |
| `docs/TESTING_STRATEGY.md`    | Test strategy & quality gates                         |
| `docs/DEPLOYMENT.md`          | Deployment & environments                             |
| `docs/ROADMAP.md`             | Master development roadmap                            |
| `docs/COMPLIANCE_REGISTER.md` | Compliance matrix & conformance language              |
| `docs/PROJECT_STATUS.md`      | Current status board                                  |
| `docs/DEVELOPMENT_LOG.md`     | Change log                                            |

## Top-level business modules

All ten modules are defined as **top-level domains**. In Step 1 each is **deferred**
(foundation boundary only — see `docs/ARCHITECTURE.md` for the per-module status table):

HMIS Reports · Scanned Documents · Registration · Billing · Investigations ·
Master Setup · Emergency · Laboratory Medical Inventory · Analytics · Daily Reports

## Conformance statement

SDIS makes **no** claim of certification, accreditation, or conformance to ISO 15189,
HL7, FHIR, DICOM, IHE, or any national regulatory scheme. The repository documents
**design intent** and **architectural boundaries** only. See `docs/STANDARDS.md`
and `docs/COMPLIANCE_REGISTER.md` for exact statuses.

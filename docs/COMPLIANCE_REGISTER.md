# SDIS Compliance Register

## 1. Conformance language (approved wording)

Use:

- "designed for alignment with"
- "implementation targets"
- "supports"
- "architecture reserves a boundary for"
- "contract-tested"
- "locally proven"
- "not yet validated"

**Forbidden without actual evidence:**

- "certified", "ISO compliant", "FHIR compliant", "DICOM compliant",
  "HL7 compliant", "FDA approved", "clinically validated", "accredited"

Every registry status uses the approved wording only.

## 2. Compliance matrix

Columns: Requirement | Source | Jurisdiction | Applicable Module | Implementation Status | Evidence | Validation Method | Owner | Review Date | Conformance Status

| Requirement                            | Source                                                                              | Jurisdiction | Module              | Implementation Status             | Evidence                        | Validation Method                      | Owner          | Review Date | Conformance Status |
| -------------------------------------- | ----------------------------------------------------------------------------------- | ------------ | ------------------- | --------------------------------- | ------------------------------- | -------------------------------------- | -------------- | ----------- | ------------------ |
| Diagnostic laboratory quality system   | ISO 15189 (international)                                                           | Global       | Laboratory, Quality | Architectural boundary (planned)  | This register + ARCHITECTURE.md | External audit (future)                | Quality lead   | Not set     | Not claimed        |
| Laboratory safety                      | ISO 15190                                                                           | Global       | Laboratory          | Architectural boundary (planned)  | REGISTER entry                  | External audit (future)                | Safety officer | Not set     | Not claimed        |
| Health-sector security                 | ISO 27799 / ISO/IEC 27001                                                           | Global       | Security            | Alignment target                  | SECURITY.md                     | Audit (future)                         | Security lead  | Not set     | Not claimed        |
| Application security                   | OWASP ASVS / API Security                                                           | Global       | Security, API       | Guidance followed in design       | SECURITY.md, API_CONTRACTS.md   | Static/pen test (future)               | Security lead  | Not set     | Not claimed        |
| Health data protection                 | National privacy law (Nepal — to be verified against authoritative current sources) | Nepal        | All                 | Not verified / needs legal review | —                               | Legal review (required, not performed) | Legal          | Not set     | Not claimed        |
| Retention/record keeping               | Facility/legal policy (pending)                                                     | Nepal        | Documents, Audit    | Architectural boundary            | DOCUMENTS/register              | Legal review                           | Legal          | Not set     | Not claimed        |
| Medical-device software classification | To be determined jurisdictionally                                                   | TBD          | Devices             | Boundary reserved, no claim       | INTEROPERABILITY.md             | Regulatory review (future)             | TBD            | Not set     | Not claimed        |
| Accessibility                          | WCAG 2.x (planned)                                                                  | Global       | UI (future)         | Not started                       | —                               | Automated + manual (future)            | UX             | Not set     | Not claimed        |

Rules:

- **No Nepal statutory requirement is invented.** Any Nepal-specific requirement must
  be verified against authoritative current sources before being recorded as a
  requirement (STOP condition if uncertain).
- Financial requirements (billing/tax) are likewise deferred until verified; no tax
  rules from memory are implemented (see ARCHITECTURE.md, Billing boundary).
- "Implemented" in this register means the control exists; it does **not** mean
  compliance is proven.

## 3. Review process

- Owner assignment and review dates are set when a domain Step begins.
- Any change to this register requires an entry in DEVELOPMENT_LOG.md.

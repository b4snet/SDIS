# SDIS Authorization Matrix (RBAC)

Status: Step 32 — canonical matrix of every permission, the roles that hold
it, and the scope model that bounds it. Derived from the SINGLE authoritative
mapping in `src/app/authz/rbac.ts` (`PERMISSIONS`, `ROLES`,
`ROLE_PERMISSIONS`) — if this document and the code disagree, the code wins
and the document must be corrected.

## 1. Model

```text
Authenticated principal (Step-10 credential binding)
        ↓  role claim resolved by the ONE RoleResolver port
Role (viewer / operator / manager / patient)
        ↓  ROLE_PERMISSIONS lookup (fail-closed: unknown role ⇒ deny)
Permission (<area>.<operation> over the real capability surface)
        ↓  scope guards (org/facility, server-derived, never client input)
Resource in the session's own tenant + facility
        ↓  append-only audit + provenance
```

Enforcement order at every application use case: **authenticated → permission
allowed → scope allowed → resource in scope**. Denials surface as the stable
`403 FORBIDDEN` contract with a minimal message (no role/policy internals).

## 2. Roles

| Role       | Intent                                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `viewer`   | Read-only across the existing capability surface                                                                                            |
| `operator` | Front-line operation: intake, orders, specimens, results entry                                                                              |
| `manager`  | Operations plus billing, configuration, integration administration, clinical verification/amendment, quality and terminology administration |
| `patient`  | The authenticated patient — exactly two patient-scoped read permissions; never any staff permission                                         |

## 3. Permission → roles matrix

| Permission              | viewer | operator | manager | patient | Scope      | Notes                                                                                                                                                  |
| ----------------------- | ------ | -------- | ------- | ------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `patient.read`          | ✔      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `patient.create`        | —      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `order.read`            | ✔      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `order.create`          | —      | ✔        | ✔       | —       | facility   | order lifecycle transitions (remediation AUD-01: every transition requires it)                                                                         |
| `order.verify`          | —      | —        | ✔       | —       | facility   | VERIFIED reviewing signature on diagnostic content (Step 28; never a config permission — AUD-02)                                                       |
| `specimen.create`       | —      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `observation.read`      | ✔      | ✔        | ✔       | —       | order-item |                                                                                                                                                        |
| `observation.create`    | —      | ✔        | ✔       | —       | order-item |                                                                                                                                                        |
| `report.read`           | ✔      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `report.create`         | —      | ✔        | ✔       | —       | facility   | draft creation + finalization (Step 28 verification gate applies at finalize)                                                                          |
| `report.amend`          | —      | —        | ✔       | —       | facility   | amendment of a finalized report: new superseding version (never a config permission — AUD-02)                                                          |
| `billing.read`          | ✔      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `billing.create`        | —      | —        | ✔       | —       | facility   | charges (Step 8)                                                                                                                                       |
| `device.ingest`         | —      | ✔        | ✔       | —       | facility   | device ingestion boundary (Step 9)                                                                                                                     |
| `document.read`         | ✔      | ✔        | ✔       | —       | facility   | staff document access                                                                                                                                  |
| `document.create`       | —      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `inventory.read`        | ✔      | ✔        | ✔       | —       | facility   | balances, FEFO pick, usage traceability                                                                                                                |
| `inventory.manage`      | —      | ✔        | ✔       | —       | facility   | receive/issue/wastage/return + lot/item lifecycle (Step 31)                                                                                            |
| `setup.read`            | ✔      | ✔        | ✔       | —       | facility   |                                                                                                                                                        |
| `setup.manage`          | —      | —        | ✔       | —       | facility   | configuration is administrative: manager tier only                                                                                                     |
| `notification.read`     | ✔      | ✔        | ✔       | —       | facility   | notification read model: delivery intents + attempt ledger (Step 19)                                                                                   |
| `notification.manage`   | —      | —        | ✔       | —       | facility   | manual delivery-intent lifecycle: retry / cancel (Step 19)                                                                                             |
| `integration.manage`    | —      | —        | ✔       | —       | facility   | external-system registration (Step 20) — reservation-only: no registration route exists yet, so nothing asserts it; the future endpoint MUST (AUTH-01) |
| `quality.manage`        | —      | —        | ✔       | —       | facility   | QC record administration + analytical-hold release (Steps 25/27/30; never a config permission — AUD-02)                                                |
| `terminology.manage`    | —      | —        | ✔       | —       | facility   | terminology mapping creation (reads stay auth+scope open by design — remediation adjacent fix)                                                         |
| `patient.report.read`   | —      | —        | —       | ✔       | ownership  | OWN finalized reports only (Step 22)                                                                                                                   |
| `patient.document.read` | —      | —        | —       | ✔       | ownership  | OWN patient-visible documents only (Step 23)                                                                                                           |

## 4. Scope semantics

- **Facility scope** — every staff permission operates inside the session's
  server-derived facility; resources of other facilities are `404`
  (IDOR-resistant: existence is not disclosed) or `403` for forged session
  scope (`SCOPE_MISMATCH`).
- **Ownership scope** — patient permissions never consult facility roles; the
  server resolves ownership through the patient-principal registry (Step 22)
  and returns indistinguishable `404`s for resources the principal does not
  own.
- **Tenant integrity** — a session whose facility is not registered to its
  organization is rejected before any resource check; tenant scope is never
  the actor identity.

## 5. Special state restrictions (beyond permissions)

| Transition               | Additional gate                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Order lifecycle          | `order.create` (operator tier) on every transition; `order.verify` (manager tier) for VERIFIED (remediation AUD-01)      |
| Result verification      | `order.verify` (manager tier, Step 28); idempotent replay scoped to facility                                             |
| Report finalization      | order must be VERIFIED; QC hold pauses finalization application-wide (Step 27)                                           |
| Report amendment         | `report.amend` (manager tier) + bounded amendment-reason vocabulary; prior versions immutable                            |
| Quality hold release     | `quality.manage` (manager tier) + bounded reason + audit (Step 27)                                                       |
| Terminology mapping      | `terminology.manage` (manager tier); reads stay auth+scope open                                                          |
| Inventory issue (OUT)    | lot must be consumable (not expired/quarantined/retired, positive balance) — WASTAGE remains the disposal path (Step 31) |
| Inventory lot transition | valid transition for the CURRENT state (409 otherwise); RETIRED terminal                                                 |
| Configuration mutation   | `setup.manage` (manager tier) + idempotent replay                                                                        |

## 6. What is deliberately NOT modeled

- No hospital job titles, no clinical privileges beyond the capability tiers
  above (documented future capability), no per-user persisted RBAC tables, no
  role-management endpoints, no delegation, no resource-level ACLs beyond
  scope + ownership.

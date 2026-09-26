# SDIS Tenancy, Facility & Patient Identity

Status: Step 4 — **server-derived application scope, disposable PostgreSQL
RLS, and HTTP transport scope behavior are tested locally; production
authentication remains deferred (the transport fails closed with 401).**

## 1. Organization / Facility hierarchy

```text
Organization
   ↓
Facility
   ↓
Diagnostic Department
   ↓
Diagnostic Resources
```

Requirements:

- Multiple organizations, multiple facilities per organization, multiple laboratories
  per organization, multiple departments/sections, multiple diagnostic units.
- Facility-local configuration; organization-wide policy; facility-specific policies.
- Tenant/facility scope is **explicit** (typed `FacilityContext`) on every
  scoped operation. It is derived server-side from the authenticated session, never
  trusted from the client.
- Client-selected tenant/facility is **not** an authoritative security boundary.
- Over HTTP (Step 4), scope is still enforced exclusively by the application
  services: the transport never accepts client-supplied organization/facility
  scope, forged tenants are rejected before resource checks, cross-facility
  reads are 404 (existence is not disclosed; forged scope itself is 403),
  and report authorship is bound to the session actor.

## 2. Patient identity (centralized, no duplicates)

- One patient identity source in SDIS.
- No laboratory-specific patient table, no second identity source.
- Future identity sources attach as **external references**:
  - hospital MRN
  - SDIS patient ID (canonical)
  - external patient identifiers
  - national health identifiers — only where legally/technically applicable;
    SDIS does **not** assume or invent one
  - enterprise patient identifiers
- Future capabilities reserved: duplicate detection, merge, identity resolution —
  architecture-ready only.

## 3. Standalone vs hospital-integrated operation

### Standalone

```
Patient → SDIS Registration → Investigation
```

### Hospital-integrated

```
HMS Patient → Encounter → Diagnostic Order → SDIS
```

- Both operate on the same SDIS identity model without duplicating patient identity.
- External-reference boundary: HMS patients reference SDIS patients via an
  external system reference, never by re-creating the record.
- A future HMS database is never embedded inside SDIS.

## 4. Code boundary (Step 1)

`src/domain/patient/` models the canonical patient identity boundary;
`src/types/tenant.ts` models organization/facility scope. Tests prove that patient
identity and facility scope cannot be forged or duplicated trivially
(see `tests/security/tenant.test.ts`, `tests/patient/patient-identity.test.ts`).

## 5. Isolation across supporting infrastructure (Step 32)

- **Idempotency records are tenant/facility-scoped**: the record key composes
  the session's server-derived facility (`scopedIdempotencyKey`), so a retry
  key is never shared across facilities or organizations (SEC-IDEM,
  `tests/app/security-hardening.test.ts`).
- **RLS posture (RLS-01)**: PostgreSQL policies require the tenant GUCs to be
  set; migration `014_rls_fail_closed.sql` adds RESTRICTIVE policies so a
  request without context fails closed, and the transport stamps every
  authenticated request with the session scope through the injected
  request-scope runner.
- **Client-supplied scope selectors**: no API accepts `tenantId`/`facilityId`
  as authorization scope; all scope is derived from the authenticated session
  and re-validated against the facility directory on every service call.

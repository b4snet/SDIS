# SDIS Security Architecture

Status: Step 32 — **security hardening applied across the foundation:
facility-scoped idempotency, `WWW-Authenticate: Bearer` challenges,
timing-uniform credential lookup, `nosniff`, plus the previously shipped
fail-closed authentication, application RBAC, and RESTRICTIVE RLS. Production
identity infrastructure (SSO/MFA/rotation) remains deferred.**

## 1. Principles

- **Least privilege** — roles grant the minimum capability needed.
- **Defense in depth** — application authorization, database RLS, API contracts.
- **Tenant/facility isolation is mandatory** — client-selected context is never the
  authoritative security boundary; the server derives scope from authenticated session.
- **IDOR prevention** — every resource access is checked against the caller's
  organization/facility scope and record ownership.
- **PHI protection** — minimum-necessary access; field-level protection where needed.
- **Auditability** — material mutations are attributable (see AUDIT_PROVENANCE.md).

## 2. Authentication & authorization (future)

| Mechanism          | Plan                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Authentication     | Session-based auth for staff (HTTP-only cookies); token-based for APIs (OAuth 2.0 / OIDC when integrated) |
| Authorization      | RBAC with roles → permissions → scope (org/facility)                                                      |
| Service-to-service | mTLS or signed JWT with short-lived credentials                                                           |
| Session security   | HttpOnly, Secure, SameSite cookies; rotation; revocation                                                  |
| Rate limiting      | Per-user and per-IP limits on auth and API endpoints                                                      |
| Secrets            | Managed secret store; never in source, env files, or logs                                                 |

## 3. Healthcare data protection

- Data classification: PHI/PII, clinical, operational, public.
- Encryption at rest (PostgreSQL TDE/volume encryption, object storage SSE).
- Encryption in transit (TLS 1.2+).
- Log redaction of identifiers; never log patient/result payloads.
- Retention, archival, deletion, and export per documented policy; legal review
  required before activation.
- Development uses **synthetic fixtures only**. No real patient data.

## 4. API security

- TLS everywhere; secure headers (CSP, HSTS, X-Content-Type-Options, frame
  ancestors); secure error handling (no stack traces, no internal detail leakage).
- Correlation IDs across the request lifecycle.
- Abuse protection via rate limiting and input validation.

## 5. Boundaries implemented in Step 1 (code)

- Typed facility/organization context that must be supplied explicitly (cannot be
  forged from client data — see `src/domain/` and tests).
- Branded identifier types preventing cross-entity confusion.
- Provenance model separating actor/source/timestamp/context.
- Audit contract with append-only semantics.
- `.env.example` template with no secrets; `.gitignore` protects real env files.

## 6. Authentication foundation (Step 10, local only)

The `SessionResolver` seam is now connected to a minimal credential mechanism:
opaque bearer tokens (the smallest concrete form of the "token-based for APIs"
plan in §2) resolved through an injected `CredentialDirectory` port
(`src/transport/auth.ts`).

- Credentials map to the existing `ApplicationSession` (actor + server-derived
  organization/facility scope) — authentication identity ≠ authorization scope
  is preserved; scope is a property of the principal's binding, never of the
  request.
- Absent, malformed, and unknown credentials all fail closed to the existing
  401 UNAUTHENTICATED envelope; no authentication detail is echoed.
- Token comparison is constant time; credential bindings are external
  configuration (docs/DEPLOYMENT.md §3) — no secrets in source; the repository
  contains deterministic test fixtures only.
- Not implemented (still future per §2): passwords, cookie sessions for staff,
  OAuth 2.0/OIDC, SSO, MFA, refresh tokens, revocation/rotation, RBAC. This is
  an authentication foundation for local/testing use — NOT production
  authentication, and no such claim is made.

## 7. RBAC foundation (Step 11)

A minimal authorization engine sits behind the existing session boundary
(`src/app/authz/rbac.ts`), separating **who** (authentication, Step 10) from
**what** (role → permission) and **where** (existing tenant/facility scope
checks, unchanged):

- **Permissions** — one stable identifier per existing application capability
  (12 total: patient/order/observation/report read+create, specimen.create,
  billing.read/create, device.ingest). No permissions for functionality that
  does not exist.
- **Roles** — three neutral capability tiers (`viewer`, `operator`, `manager`),
  not hospital job titles. `manager` = `operator` + billing create; the single
  authoritative mapping lives in `ROLE_PERMISSIONS`.
- **Enforcement** — services call `AuthorizationService.assertPermission`
  (fail-closed: missing session/roles, unknown role, or unknown permission →
  deny) at the application boundary, _before_ scope checks. Scope remains
  mandatory and independent: a role grants capability; scope still limits where
  it may be used. Failure maps to the existing `403 FORBIDDEN` envelope with no
  role/permission/fixture-name leakage.
- **Role claims** — roles arrive on the session from the credential binding
  (`claimedRoleResolver`); roles are authorization claims, never client input,
  and are not persisted in this phase. No RBAC tables, no user administration.
- Wired into representative verticals (patients, orders, billing, device
  ingestion) and the PostgreSQL runtime; wired via a capability accessor in the
  HTTP router. Not integrated: specimen/observation/interpretation/report
  services (same engine applies; integration is mechanical when needed).

## 7b. Step-32 hardening (implemented)

| Control                                         | Enforcement point                                                                                                                                                                                                                                                  | Test                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Facility-scoped idempotency (SEC-IDEM)          | `scopedIdempotencyKey` in `src/app/idempotency.ts` — every session-scoped `runIdempotent` call composes the SERVER-DERIVED facility into the record key, so `facility A + key X ≠ facility B + key X`; replay can neither read nor plant another facility's result | `tests/app/security-hardening.test.ts` (replay isolation + no-plant + scope-less rejection) |
| `WWW-Authenticate: Bearer` on 401 (AUTH-04)     | `src/transport/errors.ts` marks 401s; `src/transport/server.ts` sets the header — scheme only, no realm/scope detail; 403 never carries it                                                                                                                         | `security-hardening.test.ts` + `tests/transport/auth.test.ts`                               |
| Timing-uniform credential lookup (AUTH-03)      | `constantTimeDirectory` hashes every configured token to a fixed-length SHA-256 commitment and compares against EVERY digest with no early exit — work is uniform in entry count and independent of token length/position                                          | `security-hardening.test.ts` (position-independence, unknown-length rejection)              |
| `x-content-type-options: nosniff` (SEC-HEADERS) | every JSON response in `src/transport/server.ts`                                                                                                                                                                                                                   | `security-hardening.test.ts`                                                                |

The authorization matrix (permission → roles → scope per resource and
operation) lives in `RBAC.md`; tenancy semantics in `TENANCY.md`.

## 8. What is explicitly NOT done yet

- No authentication, sessions, tokens, or RBAC service. The HTTP transport
  exposes one session seam (`SessionResolver`) and ships fail-closed: without
  an integrated authentication boundary every request receives 401 and no
  `WWW-Authenticate` scheme is claimed. Transport tests prove both the 401
  posture and full contract behavior when a session source is injected.
- No RBAC persistence (roles/permissions tables), user administration, role
  management endpoints, or clinical-privilege modeling. Role claims ride the
  credential binding; a per-principal persisted model is future work.
- No production RLS deployment, encryption at rest, rate limiting service, or
  secret-store integration. Disposable PostgreSQL RLS and application-role
  behavior are tested locally only.
- The transport layer is local, contract-tested code — not a deployed or
  publicly reachable API.
- No certification or standard conformance claim is made (see
  COMPLIANCE_REGISTER.md).

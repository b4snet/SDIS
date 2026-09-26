# SDIS Testing Strategy

Status: Step 4 — **unit, application, disposable PostgreSQL persistence, and
HTTP transport contract tests pass locally.**

## 1. Test framework

- **Runtime:** Node.js LTS.
- **Runner:** built-in `node --test` (no extra framework dependency).
- **Language:** TypeScript compiled with `tsc`, tests run against compiled output.
- **Fixtures:** synthetic only. Never real patient/hospital data.

## 2. Test layers (mapped to quality gates)| Layer | Scope | Status (Step 1) |

| ---------------------- | -------------------------------------------------------------------------------------------- | --------------- |
| Architecture | Module boundaries compile; dependency direction valid; no circular domain coupling | Implemented |
| Security | Authorization boundary exists; tenant/facility context cannot be forged; secrets not exposed | Implemented |
| Data | Core identifiers valid (UUID); relationships enforced in types | Implemented |
| PostgreSQL runtime | Migration replay, application persistence, RLS, audit, and laboratory flow | Implemented |
| HTTP transport | Validation, error contract, auth posture, scope/IDOR, idempotency, leakage over real HTTP | Implemented (Step 4) |
| HTTP→DB integration | HTTP → application service → disposable PostgreSQL: persisted flow, durable replay, scope | Implemented (Step 4) |
| Clinical | Lifecycle transitions valid; finalized records immutable; amendment creates versions | Implemented |
| Provenance | Actor/source/timestamp/context representable; kinds never collapsed | Implemented |
| Extensibility | LAB, ECG, EEG, PFT, TMT, ECHO, ULTRASOUND representable without core change | Implemented |
| Standards traceability | Standards-driven decisions verified as meaningful behavior | Implemented |

## 3. Standard traceability test rule

Standards-driven architecture decisions must be verified by **meaningful behavior**
tests (state transitions, immutability, provenance kinds, modality registration,
identity validation). Tests that merely assert a class name exists are prohibited.

## 4. Quality gates (mandatory for every future Step)

### Code

- Build (`tsc`), type checking (`tsc --noEmit`), lint (ESLint), format (Prettier).

### Tests

- Unit, integration, database (when a DB is provisioned), API, authorization,
  tenancy, regression.

### Security

- Secret scan (repo sweep), dependency scan (`npm audit`), IDOR checks,
  authorization checks, PHI/log leakage review, RLS where applicable.

### Data

- Migration validation (when migrations exist), FK validation, concurrency,
  idempotency.

### Clinical

- Record immutability, provenance, patient identity.

### Documentation

- Architecture, API contract, change log, validation tier.

## 5. Commands

```text
npm run build        # tsc compile
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run format:check # prettier --check
npm test             # node --test on compiled tests
npm run verify       # all of the above
```

## 6. Current evidence

Green suite run locally on this machine. The current suite has 194 passing
tests (51 suites), including the disposable PostgreSQL runtime flow and 35
transport tests that drive a real `node:http` server over `/api/v1` — 30
contract tests and 5 HTTP→service→PostgreSQL integration proofs. Backup/restore
and migration replay remain separately covered by focused tests.

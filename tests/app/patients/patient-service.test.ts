/**
 * Patient registration & intake application tests.
 *
 * Prove the Step-6 capability over the EXISTING domain identity contract:
 * creation, external identifiers, scope, IDOR resistance, idempotency,
 * audit, and identity-integrity invariants. Fresh fixture per test; the
 * in-memory registration repository mirrors the PostgreSQL uniqueness rules.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PatientService } from '../../../src/app/patients/patient-service';
import {
  InMemoryIdempotencyStore,
  InMemoryPatientRegistrationRepository,
} from '../../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../../src/app/errors';
import { requireSession } from '../../../src/app/context';
import { PatientIdentityService } from '../../../src/domain/patient/patient';
import { createFixture, FACILITY, ORG, sessionFor } from '../../app/helpers';
import { toBrandedId } from '../../../src/types/ids';
import type { FacilityDirectory } from '../../../src/app/ports';
import type { PatientId } from '../../../src/types/ids';

interface PatientFixture {
  readonly session: ReturnType<typeof sessionFor>;
  readonly audit: ReturnType<typeof createFixture>['audit'];
  readonly patients: PatientService;
  /** Shared backing store — lets tests build two sessions over one store. */
  readonly patientRepo: InMemoryPatientRegistrationRepository;
}

function makePatientFixture(
  session = sessionFor(),
  patientRepo = new InMemoryPatientRegistrationRepository(),
): PatientFixture {
  const lab = createFixture(session);
  // Reuse the SAME facility directory instance the laboratory services use,
  // so facility registration state is consistent across the fixture.
  const facilities = (
    lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const patients = new PatientService({
    patients: patientRepo,
    facilities,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
  });
  return { session: lab.session, audit: lab.audit, patients, patientRepo };
}

const REGISTRATION = {
  fullName: 'Synthetic Registrant',
  sex: 'F' as const,
  birthDate: '1991-03-14',
};

describe('patients: registration (application)', () => {
  it('creates a patient bound to the session facility and returns a DTO', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-2001' }],
    });
    assert.equal(dto.registeredAtFacilityId, FACILITY);
    assert.equal(dto.fullName, 'Synthetic Registrant');
    assert.equal(dto.sex, 'F');
    assert.equal(dto.birthDate, '1991-03-14');
    assert.equal(dto.externalReferences.length, 1);
    assert.equal(dto.externalReferences[0]!.facilityId, FACILITY);
  });

  it('rejects a missing session (fail-closed)', async () => {
    const fx = makePatientFixture();
    await assert.rejects(
      () => fx.patients.registerPatient(undefined, REGISTRATION),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /authenticated session/);
        return true;
      },
    );
  });

  it('rejects validation failures: empty name, bad sex, malformed birthDate', async () => {
    const fx = makePatientFixture();
    await assert.rejects(
      () => fx.patients.registerPatient(fx.session, { ...REGISTRATION, fullName: '  ' }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        fx.patients.registerPatient(fx.session, {
          ...REGISTRATION,
          sex: 'UNKNOWN-X' as never,
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        fx.patients.registerPatient(fx.session, {
          ...REGISTRATION,
          birthDate: 'March 4, 1991',
        }),
      ValidationError,
    );
  });

  it('rejects a duplicate external identifier with CONFLICT (identity never merges)', async () => {
    const fx = makePatientFixture();
    await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-DUP' }],
    });
    await assert.rejects(
      () =>
        fx.patients.registerPatient(fx.session, {
          ...REGISTRATION,
          fullName: 'Different Person',
          externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-DUP' }],
        }),
      ConflictError,
    );
  });

  it('rejects a forged organization (facility owned by another org)', async () => {
    const fx = makePatientFixture(
      sessionFor(FACILITY, toBrandedId('00000000-0000-4000-8000-000000000009')),
    );
    await assert.rejects(
      () => fx.patients.registerPatient(fx.session, REGISTRATION),
      (error: unknown) => error instanceof Error && /organization/i.test(error.message),
    );
  });

  it('derives registration scope from the session — client cannot choose it', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, REGISTRATION);
    // No client field exists to override the facility; the registered facility
    // is always the server-derived session facility.
    assert.equal(dto.registeredAtFacilityId, FACILITY);
  });
});

describe('patients: external identifiers (application)', () => {
  it('attaches an identifier to an existing patient and audits it', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, REGISTRATION);
    const updated = await fx.patients.attachExternalIdentifier(fx.session, {
      patientId: toBrandedId(dto.id) as PatientId,
      system: 'ENTERPRISE',
      value: 'ENT-77',
    });
    assert.equal(updated.externalReferences.length, 1);
    assert.equal(updated.externalReferences[0]!.system, 'ENTERPRISE');
  });

  it('denies identifier attachment to the viewer tier (registration capability)', async () => {
    const sharedRepo = new InMemoryPatientRegistrationRepository();
    const lab = createFixture();
    const facilities = (
      lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
    ).deps.facilities;
    const gated = new PatientService({
      patients: sharedRepo,
      facilities,
      audit: lab.audit,
      idempotency: new InMemoryIdempotencyStore(),
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const operator = { ...lab.session, roles: ['operator'] } as never;
    const dto = await gated.registerPatient(operator, REGISTRATION);
    const viewer = { ...lab.session, roles: ['viewer'] } as never;
    await assert.rejects(
      () =>
        gated.attachExternalIdentifier(viewer, {
          patientId: toBrandedId(dto.id) as PatientId,
          system: 'ENTERPRISE',
          value: 'ENT-VIEWER',
        }),
      ForbiddenError,
    );
    // The operator tier (registration capability) may attach.
    const updated = await gated.attachExternalIdentifier(operator, {
      patientId: toBrandedId(dto.id) as PatientId,
      system: 'ENTERPRISE',
      value: 'ENT-OPERATOR',
    });
    assert.equal(updated.externalReferences.length, 1);
  });

  it('rejects attaching to a patient in another facility (IDOR)', async () => {
    // One shared backing store, two sessions with different facilities — the
    // outsider session sees the same patient id but must be denied.
    const sharedRepo = new InMemoryPatientRegistrationRepository();
    const fx = makePatientFixture(undefined, sharedRepo);
    const dto = await fx.patients.registerPatient(fx.session, REGISTRATION);
    const outsider = makePatientFixture(
      sessionFor(toBrandedId('00000000-0000-4000-8000-000000000012')),
      sharedRepo,
    );
    await assert.rejects(
      () =>
        outsider.patients.attachExternalIdentifier(outsider.session, {
          patientId: toBrandedId(dto.id) as PatientId,
          system: 'ENTERPRISE',
          value: 'ENT-IDOR',
        }),
      (error: unknown) => error instanceof Error && error.name === 'ScopeMismatchError',
    );
  });

  it('rejects attaching an identifier already claimed by another patient', async () => {
    const fx = makePatientFixture();
    await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      externalReferences: [{ system: 'NATIONAL_ID', value: 'NID-1' }],
    });
    const second = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      fullName: 'Second Registrant',
    });
    await assert.rejects(
      () =>
        fx.patients.attachExternalIdentifier(fx.session, {
          patientId: toBrandedId(second.id) as PatientId,
          system: 'NATIONAL_ID',
          value: 'NID-1',
        }),
      ConflictError,
    );
  });
});

describe('patients: lookup (application)', () => {
  it('returns the patient within scope with references', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-LOOK' }],
    });
    const found = await fx.patients.getPatient(
      fx.session,
      toBrandedId(dto.id) as PatientId,
    );
    assert.equal(found.id, dto.id);
    assert.equal(found.externalReferences[0]!.value, 'MRN-LOOK');
  });

  it('rejects cross-facility lookup of a valid patient id (IDOR)', async () => {
    const sharedRepo = new InMemoryPatientRegistrationRepository();
    const fx = makePatientFixture(undefined, sharedRepo);
    const dto = await fx.patients.registerPatient(fx.session, REGISTRATION);
    const outsider = makePatientFixture(
      sessionFor(toBrandedId('00000000-0000-4000-8000-000000000012')),
      sharedRepo,
    );
    await assert.rejects(
      () =>
        outsider.patients.getPatient(outsider.session, toBrandedId(dto.id) as PatientId),
      (error: unknown) => error instanceof Error && error.name === 'ScopeMismatchError',
    );
  });

  it('returns NOT_FOUND for an unknown patient (no existence leak)', async () => {
    const fx = makePatientFixture();
    await assert.rejects(
      () =>
        fx.patients.getPatient(
          fx.session,
          toBrandedId('00000000-0000-4000-8000-0000000000ff') as PatientId,
        ),
      NotFoundError,
    );
  });
});

describe('patients: idempotency and audit (application)', () => {
  it('replays a keyed registration to the same patient without duplicates', async () => {
    const fx = makePatientFixture();
    const first = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      idempotencyKey: 'registration-1',
    });
    const replay = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      idempotencyKey: 'registration-1',
    });
    assert.equal(replay.id, first.id);
  });

  it('emits audit events for creation and identifier attachment', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, REGISTRATION);
    const createdEvents = fx.audit
      .list()
      .filter(
        (e: { objectType: string; action: string }) =>
          e.objectType === 'patient' && e.action === 'CREATED',
      );
    assert.equal(createdEvents.length, 1);

    await fx.patients.attachExternalIdentifier(fx.session, {
      patientId: toBrandedId(dto.id) as PatientId,
      system: 'ENTERPRISE',
      value: 'ENT-AUDIT',
    });
    const attachEvents = fx.audit
      .list()
      .filter(
        (e: { objectType: string; action: string }) =>
          e.objectType === 'patient-external-identifier',
      );
    assert.equal(attachEvents.length, 1);
  });

  it('does not duplicate audit events on idempotent replay', async () => {
    const fx = makePatientFixture();
    await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      idempotencyKey: 'audit-replay',
    });
    await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      idempotencyKey: 'audit-replay',
    });
    const createdEvents = fx.audit
      .list()
      .filter(
        (e: { objectType: string; action: string }) =>
          e.objectType === 'patient' && e.action === 'CREATED',
      );
    assert.equal(createdEvents.length, 1);
  });
});

describe('patients: identity invariants', () => {
  it('keeps external references scoped to the registering facility', async () => {
    const fx = makePatientFixture();
    const dto = await fx.patients.registerPatient(fx.session, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-SCOPE' }],
    });
    // The reference's facility is the session facility — the client never
    // supplies a facility for a reference.
    assert.equal(dto.externalReferences[0]!.facilityId, FACILITY);
  });

  it('preserves the existing single-identity contract (domain-level duplicate rejection)', () => {
    // The domain contract itself remains authoritative and unchanged.
    const identity = new PatientIdentityService();
    const ref = {
      system: 'HOSPITAL_MRN',
      value: 'MRN-DOM',
      facilityId: FACILITY,
    };
    const patient = identity.createPatient({
      id: toBrandedId('00000000-0000-4000-8000-0000000000d1') as PatientId,
      registeredAtFacilityId: FACILITY,
      fullName: 'Domain One',
      sex: 'M',
      externalReferences: [ref],
    });
    assert.throws(
      () =>
        identity.createPatient({
          id: toBrandedId('00000000-0000-4000-8000-0000000000d2') as PatientId,
          registeredAtFacilityId: FACILITY,
          fullName: 'Domain Two',
          sex: 'M',
          externalReferences: [ref],
        }),
      /already claimed/,
    );
    // The first patient is untouched by the rejected second registration.
    assert.equal(identity.findById(patient.id)?.fullName, 'Domain One');
  });

  it('requireSession throws for an actor-less session', () => {
    assert.throws(() =>
      requireSession({
        actor: { kind: 'USER', id: '' },
        userId: '',
        organizationId: ORG,
        facilityId: FACILITY,
      }),
    );
  });
});

/**
 * Patient registration — disposable PostgreSQL persistence tests.
 *
 * Proves the write-capable patient repository against the real schema
 * (migration 002 tables, migration 006 RLS context): atomic patient+reference
 * persistence, exact-reference conflict behavior, scope isolation through the
 * application service, durable idempotent replay, and audit persistence.
 * SQL is used as evidence of persistence, never as the HTTP/service contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { PatientService } from '../../src/app/patients/patient-service';
import {
  PostgresFacilityDirectory,
  PostgresPatientRegistrationRepository,
} from '../../src/infrastructure/database/repositories';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { PostgresIdempotencyStore } from '../../src/infrastructure/database/repositories';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { ConflictError, ScopeMismatchError } from '../../src/app/errors';
import type { AuditPort } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';

const PORT = 55443;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000019';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'registrar' },
    userId: 'registrar',
    roles: ['operator', 'viewer'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

const REGISTRATION = {
  fullName: 'Persisted Registrant',
  sex: 'F' as const,
  birthDate: '1993-11-02',
};

let db: Database;
let patients: PatientService;
let audit: AuditPort;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
  audit = runtime.patients['deps']['audit'];
  patients = new PatientService({
    patients: new PostgresPatientRegistrationRepository(db),
    facilities: new PostgresFacilityDirectory(db),
    audit,
    idempotency: new InMemoryIdempotencyStore(),
  });
});

after(async () => {
  await teardownTestDatabase();
});

describe('patients postgres: persistence', () => {
  it('persists a patient with external references atomically', async () => {
    const dto = await patients.registerPatient(session(), {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-1' }],
    });

    const row = await db.query<{
      full_name: string;
      registered_at_facility_id: string;
      sex: string;
      birth_date: Date;
    }>(
      'SELECT full_name, registered_at_facility_id, sex, birth_date FROM sdis.patients WHERE id = $1',
      [dto.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0]?.full_name, 'Persisted Registrant');
    assert.equal(row.rows[0]?.registered_at_facility_id, FACILITY);
    assert.equal(row.rows[0]?.sex, 'F');

    const refs = await db.query<{ system: string; value: string; facility_id: string }>(
      'SELECT system, value, facility_id FROM sdis.patient_external_identifiers WHERE patient_id = $1',
      [dto.id],
    );
    assert.equal(refs.rowCount, 1);
    assert.equal(refs.rows[0]?.system, 'HOSPITAL_MRN');
    assert.equal(refs.rows[0]?.facility_id, FACILITY);
  });

  it('enforces the exact-reference uniqueness constraint at the schema level', async () => {
    await patients.registerPatient(session(), {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-UNIQ' }],
    });
    // Service pre-check surfaces the conflict as the stable contract...
    await assert.rejects(
      () =>
        patients.registerPatient(session(), {
          ...REGISTRATION,
          fullName: 'Different Person',
          externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-UNIQ' }],
        }),
      ConflictError,
    );
    // ...and the schema constraint remains the last line of defense.
    const raw = await db
      .query(
        `INSERT INTO sdis.patient_external_identifiers (patient_id, system, value, facility_id)
             VALUES ($1, $2, $3, $4)`,
        [
          (
            await db.query<{ id: string }>(
              "SELECT id FROM sdis.patients WHERE full_name = 'Persisted Registrant' LIMIT 1",
            )
          ).rows[0]?.id,
          'HOSPITAL_MRN',
          'MRN-PG-UNIQ',
          FACILITY,
        ],
      )
      .catch((error: { code?: string }) => error);
    assert.equal((raw as { code?: string }).code, '23505');
  });

  it('round-trips external references on lookup', async () => {
    const dto = await patients.registerPatient(session(), REGISTRATION);
    await patients.attachExternalIdentifier(session(), {
      patientId: dto.id as never,
      system: 'ENTERPRISE',
      value: 'ENT-PG-1',
    });
    const found = await patients.getPatient(session(), dto.id as never);
    assert.equal(found.externalReferences.length, 1);
    assert.equal(found.externalReferences[0]?.value, 'ENT-PG-1');
  });

  it('isolates scope: another facility session cannot read or attach', async () => {
    const dto = await patients.registerPatient(session(), REGISTRATION);
    await assert.rejects(
      () => patients.getPatient(session(OTHER_FACILITY), dto.id as never),
      ScopeMismatchError,
    );
    await assert.rejects(
      () =>
        patients.attachExternalIdentifier(session(OTHER_FACILITY), {
          patientId: dto.id as never,
          system: 'ENTERPRISE',
          value: 'ENT-DENIED',
        }),
      ScopeMismatchError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () => patients.registerPatient(session(FACILITY, OTHER_ORG), REGISTRATION),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('persists audit events for registration and attachment', async () => {
    const dto = await patients.registerPatient(session(), {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-AUDIT' }],
    });
    await patients.attachExternalIdentifier(session(), {
      patientId: dto.id as never,
      system: 'ENTERPRISE',
      value: 'ENT-PG-AUDIT',
    });
    const patientAudit = await db.query<{ count: string; source_kind: string }>(
      `SELECT count(*)::text AS count, max(source_kind) AS source_kind
             FROM sdis.audit_events WHERE object_type = 'patient'`,
    );
    assert.ok(Number(patientAudit.rows[0]?.count) >= 1);
    assert.equal(patientAudit.rows[0]?.source_kind, 'HUMAN');
    const attachAudit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'patient-external-identifier'`,
    );
    assert.ok(Number(attachAudit.rows[0]?.count) >= 1);
  });

  it('replays durably: same patient, one row, no duplicate audit (Postgres store)', async () => {
    const durable = new PatientService({
      patients: new PostgresPatientRegistrationRepository(db),
      facilities: new PostgresFacilityDirectory(db),
      audit,
      idempotency: new PostgresIdempotencyStore(db),
    });
    const payload = {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-REPLAY' }],
      idempotencyKey: 'patient-durable-replay-1',
    };
    const first = await durable.registerPatient(session(), payload);
    const replay = await durable.registerPatient(session(), payload);
    assert.equal(replay.id, first.id);
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.patients WHERE id = $1',
      [first.id],
    );
    assert.equal(rows.rows[0]?.count, '1');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'patient' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1');
  });

  it('persists audit events for registration and attachment', async () => {
    const dto = await patients.registerPatient(session(), {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-PG-FLOW' }],
    });
    // Encounter creation is not a Step-6 capability; this row is setup evidence
    // so the order domain rule (encounter must belong to the patient) holds.
    const encounterId = '00000000-0000-4000-8000-0000000000c2';
    await db.query(
      `INSERT INTO sdis.encounters (id, patient_id, facility_id, started_at)
             VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [encounterId, dto.id, FACILITY],
    );
    // The patient created through the Step-6 capability is immediately usable
    // by the EXISTING laboratory order service — one identity source.
    const order = await runtime.orders.createOrder(session(), {
      patientId: dto.id as never,
      encounterId: encounterId as never,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: '2026-09-20T08:00:00.000Z',
    });
    assert.equal(order.patientId, dto.id);
  });
});

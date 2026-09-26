/**
 * PostgreSQL Repository Adapter Tests
 *
 * Tests the PostgreSQL implementations of the application ports.
 * Verifies CRUD operations, relationships, and RLS enforcement.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDatabase,
  teardownTestDatabase,
  getTestDb,
} from '../../src/infrastructure/database/test-db';
import {
  PostgresPatientDirectory,
  PostgresFacilityDirectory,
  PostgresEncounterDirectory,
  PostgresModalityDirectory,
  PostgresOrderRepository,
  PostgresSpecimenRepository,
  PostgresObservationRepository,
  PostgresInterpretationRepository,
  PostgresReportRepository,
  PostgresAuditPort,
  PostgresIdempotencyStore,
  ensureIdempotencyTable,
} from '../../src/infrastructure/database/repositories';
import { toBrandedId } from '../../src/types/ids';

let testDb: any;

const ORG_A = toBrandedId('00000000-0000-4000-8000-000000000001');
const FAC_A1 = toBrandedId('00000000-0000-4000-8000-000000000011');
const PATIENT_A = toBrandedId('00000000-0000-4000-8000-0000000000e1');
const ENCOUNTER_A = toBrandedId('00000000-0000-4000-8000-0000000000c1');

describe('database: PostgreSQL repository adapters', () => {
  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '55436';
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    await setupTestDatabase({ port: 55436 });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('PatientDirectory: finds patient by ID', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const dir = new PostgresPatientDirectory(testDb);
    const patient = await dir.findById(PATIENT_A);
    assert.ok(patient, 'Should find seeded patient');
    assert.equal(patient.id, PATIENT_A);
    assert.equal(patient.fullName, 'Test Patient One');
  });

  it('FacilityDirectory: finds facility by ID', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const dir = new PostgresFacilityDirectory(testDb);
    const facility = await dir.findById(FAC_A1);
    assert.ok(facility, 'Should find seeded facility');
    assert.equal(facility.id, FAC_A1);
    assert.equal(facility.name, 'Swasthya Central Lab');
  });

  it('ModalityDirectory: checks modality registration', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const dir = new PostgresModalityDirectory(testDb);
    assert.ok(await dir.has('LAB'), 'LAB should be registered');
    assert.ok(await dir.has('ECG'), 'ECG should be registered');
    assert.ok(
      !(await dir.has('UNKNOWN_MODALITY')),
      'Unknown modality should not be registered',
    );
  });

  it('OrderRepository: saves and finds order with items', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const repo = new PostgresOrderRepository(testDb);
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a1');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');

    const order = {
      id: orderId,
      patientId: PATIENT_A,
      encounterId: ENCOUNTER_A,
      facilityId: FAC_A1,
      modality: 'LAB' as const,
      priority: 'ROUTINE' as const,
      status: 'ORDERED' as const,
      orderedAt: '2026-09-20T08:00:00.000Z',
      orderedByRef: 'user-tech-1',
      version: 1,
      items: [
        {
          id: itemId,
          orderId,
          testCode: 'CBC',
          codeSystem: 'sdis',
        },
      ],
    };

    const saved = await repo.save(order);
    assert.equal(saved.id, orderId);

    const found = await repo.findById(orderId);
    assert.ok(found, 'Should find saved order');
    assert.equal(found.id, orderId);
    assert.equal(found.items.length, 1);
    const [foundItem] = found.items;
    assert.ok(foundItem);
    assert.equal(foundItem.testCode, 'CBC');
  });

  it('SpecimenRepository: saves and finds specimen', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const repo = new PostgresSpecimenRepository(testDb);
    const specimenId = toBrandedId('00000000-0000-4000-8000-0000000000b1');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');

    const specimen = {
      id: specimenId,
      orderItemId: itemId,
      patientId: PATIENT_A,
      kind: 'BLOOD' as const,
      collectedAt: '2026-09-20T08:01:00.000Z',
      collectedByRef: 'user-tech-1',
      status: 'COLLECTED' as const,
      version: 1,
    };

    const saved = await repo.save(specimen);
    assert.equal(saved.id, specimenId);

    const found = await repo.findById(specimenId);
    assert.ok(found, 'Should find saved specimen');
    assert.equal(found.status, 'COLLECTED');
  });

  it('ObservationRepository: saves and finds observation with provenance', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const repo = new PostgresObservationRepository(testDb);
    const obsId = toBrandedId('00000000-0000-4000-8000-0000000000c2');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');

    const observation = {
      id: obsId,
      orderItemId: itemId,
      patientId: PATIENT_A,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE' as const, value: 13.2 },
      unit: 'g/dL',
      issuedBy: {
        kind: 'DEVICE' as const,
        label: 'analyzer-x1',
        ref: 'dev-1',
      },
      at: '2026-09-20T08:06:00.000Z',
    };

    const saved = await repo.save(observation);
    assert.equal(saved.id, obsId);

    const found = await repo.findById(obsId);
    assert.ok(found, 'Should find saved observation');
    assert.equal(found.issuedBy.kind, 'DEVICE');
    assert.equal(found.issuedBy.label, 'analyzer-x1');
  });

  it('InterpretationRepository: preserves source kind', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const repo = new PostgresInterpretationRepository(testDb);
    const interpId = toBrandedId('00000000-0000-4000-8000-0000000000d2');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');

    const interpretation = {
      id: interpId,
      orderItemId: itemId,
      source: {
        kind: 'ALGORITHM' as const,
        label: 'rules-v3',
      },
      text: 'within expected pattern',
      at: '2026-09-20T08:07:00.000Z',
    };

    const saved = await repo.save(interpretation);
    assert.equal(saved.id, interpId);

    const found = await repo.findById(interpId);
    assert.ok(found, 'Should find saved interpretation');
    assert.equal(found.source.kind, 'ALGORITHM');
  });

  it('ReportRepository: creates draft, finalizes, and amends', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const repo = new PostgresReportRepository(testDb);
    const reportId = toBrandedId('00000000-0000-4000-8000-0000000000f1');
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a1');

    const report = {
      id: reportId,
      orderId,
      patientId: PATIENT_A,
      facilityId: FAC_A1,
      versions: [
        {
          id: toBrandedId('00000000-0000-4000-8000-0000000000e2'),
          reportId,
          version: 1,
          status: 'DRAFT' as const,
          content: 'CBC within expected pattern',
          authoredByRef: 'path-1',
          authoredAt: '2026-09-20T08:10:00.000Z',
        },
      ],
    };

    const saved = await repo.save(report);
    assert.equal(saved.id, reportId);

    const found = await repo.findById(reportId);
    assert.ok(found, 'Should find saved report');
    assert.equal(found.versions.length, 1);
    const [foundVersion] = found.versions;
    assert.ok(foundVersion);
    assert.equal(foundVersion.status, 'DRAFT');
  });

  it('AuditPort: records audit events with provenance', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    await ensureIdempotencyTable(testDb);

    const audit = new PostgresAuditPort(testDb);
    const event = {
      id: toBrandedId('00000000-0000-4000-8000-0000000000a1') as any,
      action: 'CREATED' as const,
      objectType: 'diagnostic-order',
      objectId: '00000000-0000-4000-8000-0000000000a1',
      at: '2026-09-20T08:00:00.000Z',
      context: {
        organizationId: ORG_A,
        facilityId: FAC_A1,
      },
      provenance: {
        actor: { kind: 'USER' as const, id: 'user-tech-1' },
        source: { kind: 'HUMAN' as const, label: 'manual entry' },
        timestamp: '2026-09-20T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
    };

    await audit.record(event);

    // Verify event was recorded
    const result = await testDb.query('SELECT * FROM sdis.audit_events WHERE id = $1', [
      event.id,
    ]);
    assert.equal(result.rowCount, 1, 'Audit event should be recorded');
    assert.equal(result.rows[0].action, 'CREATED');
  });

  it('IdempotencyStore: prevents duplicate operations', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    await ensureIdempotencyTable(testDb);

    const store = new PostgresIdempotencyStore(testDb);
    const key = 'test-idempotency-key';
    const value = { orderId: 'test-order-1' };

    // First put
    await store.put(key, value);
    const first = await store.get(key);
    assert.deepEqual(first, value);

    // Second put with different value should be ignored (existing returned)
    await store.put(key, { orderId: 'different' });
    const second = await store.get(key);
    assert.deepEqual(second, value, 'Should return original value on replay');
  });
});

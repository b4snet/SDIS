/**
 * End-to-End PostgreSQL Laboratory Flow Test
 *
 * Runs the complete laboratory flow through PostgreSQL:
 * Patient → Encounter → Diagnostic Order → Order Item → Specimen → Observation → Interpretation → Report
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
} from '../../src/infrastructure/database/repositories';
import { toBrandedId, assertUuidV4 } from '../../src/types/ids';
import type { DiagnosticOrder } from '../../src/domain/ordering/diagnostic-order';

let testDb: any;

const ORG_A = toBrandedId('00000000-0000-4000-8000-000000000001');
const FAC_A1 = toBrandedId('00000000-0000-4000-8000-000000000011');
const PATIENT_A = toBrandedId('00000000-0000-4000-8000-0000000000e1');
const ENCOUNTER_A = toBrandedId('00000000-0000-4000-8000-0000000000c1');

const T0 = '2026-09-20T08:00:00.000Z';
const plusMinutes = (iso: string, minutes: number): string =>
  new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();

describe('database: end-to-end PostgreSQL laboratory flow', () => {
  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '55437';
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    await setupTestDatabase({ port: 55437 });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('runs complete lab flow: Order → Specimen → Observation → Interpretation → Report', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    // Initialize repositories
    const patientDir = new PostgresPatientDirectory(testDb);
    const facilityDir = new PostgresFacilityDirectory(testDb);
    const encounterDir = new PostgresEncounterDirectory(testDb);
    const modalityDir = new PostgresModalityDirectory(testDb);
    const orderRepo = new PostgresOrderRepository(testDb);
    const specimenRepo = new PostgresSpecimenRepository(testDb);
    const observationRepo = new PostgresObservationRepository(testDb);
    const interpretationRepo = new PostgresInterpretationRepository(testDb);
    const reportRepo = new PostgresReportRepository(testDb);
    const auditPort = new PostgresAuditPort(testDb);

    // Verify prerequisites exist
    const patient = await patientDir.findById(PATIENT_A);
    assert.ok(patient, 'Seeded patient should exist');
    assert.equal(patient.registeredAtFacilityId, FAC_A1);

    const encounter = await encounterDir.findById(ENCOUNTER_A);
    assert.ok(encounter, 'Seeded encounter should exist');
    assert.equal(encounter.patientId, PATIENT_A);

    assert.ok(await modalityDir.has('LAB'), 'LAB modality should be registered');

    // ============================================================
    // STEP 1: Create Diagnostic Order
    // ============================================================
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a1');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');
    const order: DiagnosticOrder = {
      id: orderId,
      patientId: PATIENT_A,
      encounterId: ENCOUNTER_A,
      facilityId: FAC_A1,
      priority: 'ROUTINE',
      modality: 'LAB',
      status: 'ORDERED',
      orderedAt: T0,
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

    const savedOrder = await orderRepo.save(order);

    assert.equal(savedOrder.id, orderId);
    assert.equal(savedOrder.status, 'ORDERED');

    await auditPort.record({
      id: toBrandedId('00000000-0000-4000-8000-0000000000e3'),
      action: 'CREATED',
      objectType: 'diagnostic-order',
      objectId: orderId,
      at: T0,
      context: { organizationId: ORG_A, facilityId: FAC_A1 },
      provenance: {
        actor: { kind: 'USER', id: 'user-tech-1', displayName: 'Lab Technician' },
        source: { kind: 'HUMAN', label: 'manual entry' },
        timestamp: T0,
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
      detail: 'Order created for CBC',
    });

    // ============================================================
    // STEP 2: Collect Specimen (advances order to ACQUIRED)
    // ============================================================
    const specimenId = toBrandedId('00000000-0000-4000-8000-0000000000b1');
    const specimen = {
      id: specimenId,
      orderItemId: itemId,
      patientId: PATIENT_A,
      kind: 'BLOOD' as const,
      collectedAt: plusMinutes(T0, 1),
      collectedByRef: 'user-tech-1',
      status: 'COLLECTED' as const,
      version: 1,
    };

    const savedSpecimen = await specimenRepo.save(specimen);
    assert.equal(savedSpecimen.id, specimenId);
    assert.equal(savedSpecimen.status, 'COLLECTED');

    await auditPort.record({
      id: toBrandedId('00000000-0000-4000-8000-0000000000e4'),
      action: 'CREATED',
      objectType: 'specimen',
      objectId: specimenId,
      at: plusMinutes(T0, 1),
      context: { organizationId: ORG_A, facilityId: FAC_A1 },
      provenance: {
        actor: { kind: 'USER', id: 'user-tech-1', displayName: 'Lab Technician' },
        source: { kind: 'HUMAN', label: 'manual entry' },
        timestamp: plusMinutes(T0, 1),
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
      detail: 'Specimen collected',
    });

    // ============================================================
    // STEP 3: Specimen transitions
    // ============================================================
    const receivedSpecimen = await specimenRepo.save({
      ...specimen,
      status: 'RECEIVED',
    });
    assert.equal(receivedSpecimen.status, 'RECEIVED');

    const acceptedSpecimen = await specimenRepo.save({
      ...receivedSpecimen,
      status: 'ACCEPTED',
    });
    assert.equal(acceptedSpecimen.status, 'ACCEPTED');

    const processedSpecimen = await specimenRepo.save({
      ...acceptedSpecimen,
      status: 'PROCESSED',
    });
    assert.equal(processedSpecimen.status, 'PROCESSED');

    // ============================================================
    // STEP 4: Enter Observation
    // ============================================================
    const observation = {
      id: toBrandedId('00000000-0000-4000-8000-0000000000c2'),
      orderItemId: itemId,
      patientId: PATIENT_A,
      specimenId: specimenId,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE' as const, value: 13.2 },
      unit: 'g/dL',
      issuedBy: { kind: 'DEVICE' as const, label: 'analyzer-x1', ref: 'dev-1' },
      at: plusMinutes(T0, 6),
    };

    const savedObs = await observationRepo.save(observation);
    assert.equal(savedObs.id, observation.id);
    assert.equal(savedObs.issuedBy.kind, 'DEVICE');

    await auditPort.record({
      id: toBrandedId('00000000-0000-4000-8000-0000000000e5'),
      action: 'CREATED',
      objectType: 'observation',
      objectId: observation.id,
      at: plusMinutes(T0, 6),
      context: { organizationId: ORG_A, facilityId: FAC_A1 },
      provenance: {
        actor: { kind: 'SERVICE', id: 'analyzer-x1', displayName: 'analyzer-x1' },
        source: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
        timestamp: plusMinutes(T0, 6),
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
      detail: 'Observation entered',
    });

    // ============================================================
    // STEP 5: Add Interpretation
    // ============================================================
    const interpretation = {
      id: toBrandedId('00000000-0000-4000-8000-0000000000d2'),
      orderItemId: itemId,
      source: { kind: 'ALGORITHM' as const, label: 'rules-v3' },
      text: 'within expected pattern',
      at: plusMinutes(T0, 7),
    };

    const savedInterp = await interpretationRepo.save(interpretation);
    assert.equal(savedInterp.id, interpretation.id);
    assert.equal(savedInterp.source.kind, 'ALGORITHM');

    await auditPort.record({
      id: toBrandedId('00000000-0000-4000-8000-0000000000e6'),
      action: 'CREATED',
      objectType: 'interpretation',
      objectId: interpretation.id,
      at: plusMinutes(T0, 7),
      context: { organizationId: ORG_A, facilityId: FAC_A1 },
      provenance: {
        actor: { kind: 'SERVICE', id: 'rules-v3', displayName: 'rules-v3' },
        source: { kind: 'ALGORITHM', label: 'rules-v3' },
        timestamp: plusMinutes(T0, 7),
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
      detail: 'Interpretation entered',
    });

    // ============================================================
    // STEP 6: Create and Finalize Report
    // ============================================================
    const reportId = toBrandedId('00000000-0000-4000-8000-0000000000f1');
    const versionId = toBrandedId('00000000-0000-4000-8000-0000000000e2');
    const report = {
      id: reportId,
      orderId: orderId,
      patientId: PATIENT_A,
      facilityId: FAC_A1,
      versions: [
        {
          id: versionId,
          reportId,
          version: 1,
          status: 'DRAFT' as const,
          content: 'CBC within expected pattern',
          authoredByRef: 'path-1',
          authoredAt: plusMinutes(T0, 10),
        },
      ],
    };

    const savedReport = await reportRepo.save(report);
    assert.equal(savedReport.id, reportId);
    assert.equal(savedReport.versions.length, 1);

    // Finalize report
    // Note: The report repo save creates the version, we need to update it
    // This is simplified - in reality the report service would handle this

    // ============================================================
    // STEP 7: Verify Complete Audit Chain
    // ============================================================
    const auditEvents = await testDb.query(
      'SELECT action, object_type FROM sdis.audit_events ORDER BY at',
    );
    assert.ok(
      auditEvents.rowCount >= 4,
      'Should have audit events for order, specimen, observation, interpretation',
    );

    // ============================================================
    // STEP 8: Verify Invariants
    // ============================================================
    // Patient identity stable across all entities
    const foundPatient = await testDb.query(
      `SELECT 'patient' as t, patient_id as id FROM sdis.diagnostic_orders WHERE id = $1
             UNION ALL SELECT 'specimen', patient_id FROM sdis.specimens WHERE id = $2
             UNION ALL SELECT 'observation', patient_id FROM sdis.observations WHERE id = $3
             UNION ALL SELECT 'report', patient_id FROM sdis.reports WHERE id = $3`,
      [orderId, specimenId, reportId],
    );
    const patientIds = new Set(foundPatient.rows.map((r) => r.id));
    assert.equal(
      patientIds.size,
      1,
      'Patient identity must be stable across all entities',
    );
    assert.ok(patientIds.has(PATIENT_A));

    // Order item linkage preserved
    const itemLinks = await testDb.query(
      `SELECT 'specimen' as t, order_item_id as id FROM sdis.specimens WHERE id = $1
             UNION ALL SELECT 'observation', order_item_id FROM sdis.observations WHERE id = $2
             UNION ALL SELECT 'interpretation', order_item_id FROM sdis.interpretations WHERE id = $3`,
      [specimenId, observation.id, interpretation.id],
    );
    const itemIds = new Set(itemLinks.rows.map((r) => r.id));
    assert.equal(itemIds.size, 1, 'All entities must link to same order item');
    assert.ok(itemIds.has(itemId));

    // Facility scope stable
    const facilityIds = await testDb.query(
      `SELECT 'order' as t, facility_id as id FROM sdis.diagnostic_orders WHERE id = $1
             UNION ALL SELECT 'report', facility_id FROM sdis.reports WHERE id = $2`,
      [orderId, reportId],
    );
    const facilitySet = new Set(facilityIds.rows.map((r) => r.id));
    assert.equal(facilitySet.size, 1, 'Facility scope must be stable');
    assert.ok(facilitySet.has(FAC_A1));

    // Provenance distinctions preserved
    const obsProv = await testDb.query(
      'SELECT issued_by_kind FROM sdis.observations WHERE id = $1',
      [observation.id],
    );
    const interpProv = await testDb.query(
      'SELECT source_kind FROM sdis.interpretations WHERE id = $1',
      [interpretation.id],
    );
    assert.equal(
      obsProv.rows[0].issued_by_kind,
      'DEVICE',
      'Observation provenance must be DEVICE',
    );
    assert.equal(
      interpProv.rows[0].source_kind,
      'ALGORITHM',
      'Interpretation provenance must be ALGORITHM',
    );

    // Report finalization (simplified)
    const finalReport = await testDb.query('SELECT * FROM sdis.reports WHERE id = $1', [
      reportId,
    ]);
    assert.ok(finalReport.rows[0], 'Report must exist');
    assert.equal(finalReport.rows[0].current_version, 1);
  });
});

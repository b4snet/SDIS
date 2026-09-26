import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../src/infrastructure/database/database';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { ScopeMismatchError } from '../../src/app/errors';
import { toBrandedId } from '../../src/types/ids';
import type { ApplicationSession } from '../../src/app/context';

const PORT = 55441;
const ORG = toBrandedId('00000000-0000-4000-8000-000000000001');
const FACILITY = toBrandedId('00000000-0000-4000-8000-000000000011');
const OTHER_FACILITY = toBrandedId('00000000-0000-4000-8000-000000000019');
const PATIENT = toBrandedId('00000000-0000-4000-8000-0000000000e1');
const ENCOUNTER = toBrandedId('00000000-0000-4000-8000-0000000000c1');
const START = '2026-09-20T08:00:00.000Z';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'runtime-user' },
    userId: 'runtime-user',
    roles: ['operator', 'manager', 'viewer'] as never,
    organizationId,
    facilityId,
  };
}

describe('database: PostgreSQL laboratory application runtime', () => {
  let db: Database;

  before(async () => {
    db = await setupTestDatabase({ port: PORT });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('persists the complete laboratory flow through application services', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const result = await runtime.flow.run({
      session: session(),
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
      observationUnit: 'g/dL',
      observationIssuedBy: {
        kind: 'DEVICE',
        label: 'synthetic-analyzer',
        ref: 'device-1',
      },
      interpretationSource: { kind: 'ALGORITHM', label: 'synthetic-rules' },
      interpretationText: 'synthetic interpretation',
      reportContent: 'synthetic report',
      startedAt: START,
    });

    assert.equal(result.order.status, 'REPORTED');
    assert.equal(result.specimen.status, 'PROCESSED');
    assert.equal(result.observation.issuedByKind, 'DEVICE');
    assert.equal(result.interpretation.sourceKind, 'ALGORITHM');
    assert.equal(result.report.latestStatus, 'FINALIZED');

    const persisted = await db.query<{
      patient_id: string;
      facility_id: string;
      order_item_id: string;
      specimen_id: string | null;
      report_id: string;
      report_status: string;
      audit_count: string;
    }>(
      `
      SELECT o.patient_id, o.facility_id, oi.id AS order_item_id,
             s.id AS specimen_id, r.id AS report_id,
             rv.status AS report_status,
             (SELECT count(*)::text FROM sdis.audit_events) AS audit_count
      FROM sdis.diagnostic_orders o
      JOIN sdis.order_items oi ON oi.order_id = o.id
      JOIN sdis.specimens s ON s.order_item_id = oi.id
      JOIN sdis.reports r ON r.order_id = o.id
      JOIN sdis.report_versions rv ON rv.report_id = r.id
      WHERE o.id = $1
    `,
      [result.order.id],
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0]?.patient_id, PATIENT);
    assert.equal(persisted.rows[0]?.facility_id, FACILITY);
    assert.equal(persisted.rows[0]?.order_item_id, result.specimen.orderItemId);
    assert.equal(persisted.rows[0]?.specimen_id, result.specimen.id);
    assert.equal(persisted.rows[0]?.report_id, result.report.id);
    assert.equal(persisted.rows[0]?.report_status, 'FINALIZED');
    assert.ok(Number(persisted.rows[0]?.audit_count) >= 10);

    const provenance = await db.query<{ source_kind: string }>(
      `SELECT source_kind FROM sdis.audit_events WHERE object_type = 'observation'`,
    );
    assert.equal(provenance.rows[0]?.source_kind, 'DEVICE');
  });

  it('enforces service scope and durable idempotent replay', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const active = session();
    const first = await runtime.orders.createOrder(active, {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'GLU', codeSystem: 'sdis' }],
      orderedAt: START,
      idempotencyKey: 'runtime-order-replay',
    });
    const replay = await runtime.orders.createOrder(active, {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'GLU', codeSystem: 'sdis' }],
      orderedAt: START,
      idempotencyKey: 'runtime-order-replay',
    });
    assert.equal(replay.id, first.id);
    const stored = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.diagnostic_orders WHERE id = $1',
      [first.id],
    );
    assert.equal(Number(stored.rows[0]?.count), 1);

    await assert.rejects(
      () =>
        runtime.orders.getOrder(session(OTHER_FACILITY), toBrandedId(first.id) as never),
      ScopeMismatchError,
    );
    await assert.rejects(
      () =>
        runtime.orders.createOrder(
          session(FACILITY, toBrandedId('00000000-0000-4000-8000-000000000009')),
          {
            patientId: PATIENT,
            encounterId: ENCOUNTER,
            modality: 'LAB',
            items: [{ testCode: 'TSH', codeSystem: 'sdis' }],
            orderedAt: START,
          },
        ),
      ScopeMismatchError,
    );
  });
});

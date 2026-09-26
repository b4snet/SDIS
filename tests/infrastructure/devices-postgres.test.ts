/**
 * Device ingestion — disposable PostgreSQL tests.
 *
 * Proves migration 010 from an empty database, acquisition persistence with
 * device/adapter/timestamp metadata, DEVICE provenance persisted into real
 * observation rows, tenant/facility isolation, and durable keyed replay
 * without duplicate acquisitions, observations, or audit events.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { DeviceIngestionService } from '../../src/app/devices/device-ingestion-service';
import { PostgresDeviceIngestionRepository } from '../../src/infrastructure/database/device-repository';
import {
  PostgresAuditPort,
  PostgresFacilityDirectory,
  PostgresIdempotencyStore,
} from '../../src/infrastructure/database/repositories';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import {
  DeviceRegistry,
  type DeviceAdapter,
} from '../../src/domain/devices/device-registry';
import { ForbiddenError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId } from '../../src/types/ids';
import type { DeviceId } from '../../src/types/ids';

const PORT = 55446;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const ORG = '00000000-0000-4000-8000-000000000001';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';
const DEVICE = toBrandedId('00000000-0000-4000-8000-0000000000a1') as DeviceId;

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'SERVICE', id: 'device-gateway' },
    userId: 'device-gateway',
    roles: ['operator', 'viewer'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

const adapter: DeviceAdapter = {
  adapterId: 'adapter-hema-1',
  protocol: 'VENDOR-X/1.0',
  source: { kind: 'DEVICE', label: 'analyzer-hema-x' },
  normalize: (a) => ({
    deviceId: a.deviceId,
    source: { kind: 'DEVICE', label: 'analyzer-hema-x', ref: a.deviceId },
    observations: [
      {
        code: 'GLUCOSE',
        codeSystem: 'sdis',
        value: (a.rawPayload as { glucoseMgDl: number }).glucoseMgDl,
        unit: 'mg/dL',
        at: a.acquiredAt,
      },
    ],
  }),
};

let db: Database;
let service: DeviceIngestionService;
let repo: PostgresDeviceIngestionRepository;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
  repo = new PostgresDeviceIngestionRepository(db);
  const registry = new DeviceRegistry();
  registry.registerAdapter(adapter);
  service = new DeviceIngestionService({
    registry,
    repository: repo,
    observations: runtime.observations,
    orders: runtime.orders,
    facilities: new PostgresFacilityDirectory(db),
    audit: new PostgresAuditPort(db),
    idempotency: new PostgresIdempotencyStore(db),
  });
  await db.query(
    `INSERT INTO sdis.devices (id, facility_id, name, model, modality, kind)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [DEVICE, FACILITY, 'Hema-X', 'HemaX-100', 'LAB', 'ANALYZER'],
  );
});

after(async () => {
  await teardownTestDatabase();
});

async function createLabOrder(): Promise<{ orderId: string; itemId: string }> {
  const order = await runtime.orders.createOrder(session(), {
    patientId: toBrandedId(PATIENT) as never,
    encounterId: toBrandedId(ENCOUNTER) as never,
    modality: 'LAB',
    items: [{ testCode: 'GLUCOSE', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  });
  return { orderId: order.id, itemId: order.items[0]!.id };
}

describe('devices postgres: ingestion', () => {
  it('migration 010 created both tables with RLS policies from an empty database', async () => {
    const devices = await db.query(`SELECT to_regclass('sdis.devices') AS reg`);
    assert.ok(devices.rows[0]?.reg);
    const acquisitions = await db.query(
      `SELECT to_regclass('sdis.device_acquisitions') AS reg`,
    );
    assert.ok(acquisitions.rows[0]?.reg);
    const policies = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy
             WHERE polrelid IN ('sdis.devices'::regclass, 'sdis.device_acquisitions'::regclass)`,
    );
    assert.ok((policies.rowCount ?? 0) >= 4, 'RLS policies must exist');
  });

  it('persists a raw acquisition with device/adapter/timestamp metadata', async () => {
    const dto = await service.ingest(session(), {
      deviceId: DEVICE,
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T04:00:00.000Z',
      rawPayload: { glucoseMgDl: 98 },
      ingestionKey: 'pg-ingest-1',
    });
    const row = await db.query<{
      device_id: string;
      adapter_id: string;
      acquired_at: string;
      raw_payload: { glucoseMgDl: number };
      facility_id: string;
    }>(
      `SELECT device_id, adapter_id, acquired_at, raw_payload, facility_id
             FROM sdis.device_acquisitions WHERE id = $1`,
      [dto.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0]?.device_id, DEVICE);
    assert.equal(row.rows[0]?.adapter_id, 'adapter-hema-1');
    assert.equal(row.rows[0]?.facility_id, FACILITY);
    assert.equal(row.rows[0]?.raw_payload.glucoseMgDl, 98); // payload verbatim
  });

  it('persists DEVICE provenance into real observation rows via the observation service', async () => {
    const { itemId } = await createLabOrder();
    await service.ingest(session(), {
      deviceId: DEVICE,
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T05:00:00.000Z',
      rawPayload: { glucoseMgDl: 105 },
      orderItemId: itemId as never,
      patientId: toBrandedId(PATIENT) as never,
      ingestionKey: 'pg-ingest-2',
    });
    const row = await db.query<{
      issued_by_kind: string;
      issued_by_label: string;
      issued_by_ref: string;
      value_numeric: string;
    }>(
      `SELECT issued_by_kind, issued_by_label, issued_by_ref, value_numeric
             FROM sdis.observations WHERE order_item_id = $1`,
      [itemId],
    );
    assert.equal(row.rows[0]?.issued_by_kind, 'DEVICE'); // never collapsed
    assert.equal(row.rows[0]?.issued_by_label, 'analyzer-hema-x');
    assert.equal(row.rows[0]?.issued_by_ref, DEVICE); // device identity kept
    assert.equal(Number(row.rows[0]?.value_numeric), 105);
  });

  it('keeps facility boundaries: another-facility device is rejected', async () => {
    await db.query(
      `INSERT INTO sdis.devices (id, facility_id, name, modality, kind)
           VALUES ('00000000-0000-4000-8000-0000000000a3', '00000000-0000-4000-8000-000000000012',
                   'Remote Analyzer', 'LAB', 'ANALYZER') ON CONFLICT (id) DO NOTHING`,
    );
    await assert.rejects(
      () =>
        service.ingest(session(), {
          deviceId: toBrandedId('00000000-0000-4000-8000-0000000000a3') as DeviceId,
          adapterId: 'adapter-hema-1',
          acquiredAt: '2026-09-21T04:00:00.000Z',
          rawPayload: {},
          ingestionKey: 'pg-ingest-cross-facility',
        }),
      ForbiddenError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () =>
        service.ingest(session(FACILITY, '00000000-0000-4000-8000-000000000009'), {
          deviceId: DEVICE,
          adapterId: 'adapter-hema-1',
          acquiredAt: '2026-09-21T04:00:00.000Z',
          rawPayload: {},
          ingestionKey: 'pg-ingest-forged',
        }),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('persists an IMPORTED audit event with DEVICE source', async () => {
    const dto = await service.ingest(session(), {
      deviceId: DEVICE,
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T06:00:00.000Z',
      rawPayload: { glucoseMgDl: 99 },
      ingestionKey: 'pg-ingest-audit',
    });
    const audit = await db.query<{ source_kind: string; action: string }>(
      `SELECT source_kind, action FROM sdis.audit_events
             WHERE object_type = 'device-acquisition' AND object_id = $1`,
      [dto.id],
    );
    assert.equal(audit.rows[0]?.source_kind, 'DEVICE');
    assert.equal(audit.rows[0]?.action, 'IMPORTED');
  });

  it('replays durably: one acquisition, one observation, one audit event', async () => {
    const { itemId } = await createLabOrder();
    const input = {
      deviceId: DEVICE,
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T07:00:00.000Z',
      rawPayload: { glucoseMgDl: 110 },
      orderItemId: itemId as never,
      patientId: toBrandedId(PATIENT) as never,
      ingestionKey: 'pg-ingest-replay-1',
    };
    const first = await service.ingest(session(), input);
    const replay = await service.ingest(session(), input);
    assert.equal(replay.id, first.id);
    const acquisitions = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.device_acquisitions WHERE ingestion_key = $1',
      ['pg-ingest-replay-1'],
    );
    assert.equal(acquisitions.rows[0]?.count, '1');
    const observations = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.observations WHERE order_item_id = $1',
      [itemId],
    );
    assert.equal(observations.rows[0]?.count, '1');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'device-acquisition' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1');
  });
});

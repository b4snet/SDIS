/**
 * Device ingestion HTTP contract tests.
 *
 * Real `node:http` server over the application services (in-memory adapters):
 * ingestion against a real order created through the same server — with the
 * mandated error envelope, fail-closed 401, scope 403, validation 422,
 * not-found 404, and leakage assertions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { DeviceIngestionService } from '../../src/app/devices/device-ingestion-service';
import { InMemoryDeviceIngestionRepository } from '../../src/app/in-memory-devices';
import {
  DeviceRegistry,
  type DeviceAdapter,
} from '../../src/domain/devices/device-registry';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  createFixture,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  OTHER_ORG,
} from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import { toBrandedId } from '../../src/types/ids';
import type { DeviceId } from '../../src/types/ids';

const DEVICE_ID = toBrandedId('00000000-0000-4000-8000-0000000000a1') as DeviceId;

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

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let repo: InMemoryDeviceIngestionRepository;
let lab: ReturnType<typeof createFixture>;

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
    body: options.body,
  });
  const text = await response.text();
  const headers: Record<string, string | string[] | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text };
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return request('POST', path, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

before(async () => {
  lab = createFixture();
  repo = new InMemoryDeviceIngestionRepository();
  repo.registerDevice({
    id: DEVICE_ID,
    name: 'Hema-X',
    modality: 'LAB',
    kind: 'ANALYZER',
    facilityId: FACILITY,
  });
  const registry = new DeviceRegistry();
  registry.registerAdapter(adapter);
  const devices = new DeviceIngestionService({
    registry,
    repository: repo,
    observations: lab.observations,
    orders: lab.orders,
    facilities: (lab.orders as unknown as { deps: { facilities: FacilityDirectory } })
      .deps.facilities,
    audit: lab.audit,
    idempotency: (lab.orders as unknown as { deps: { idempotency: unknown } }).deps
      .idempotency as never,
  });
  const active = sessionFor();
  // Staff role claims (Step 27 RBAC): device ingestion and the nested
  // observation entry fail closed for role-less sessions.
  (active as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
  sessionResolver = async () => active;
  const router = createRouter({
    runtime: {
      orders: lab.orders,
      specimens: lab.specimens,
      observations: lab.observations,
      interpretations: lab.interpretations,
      reports: lab.reports,
      devices,
    },
  });
  const httpServer = createSdisHttpServer({
    router,
    sessionResolver: (headers: Record<string, string | string[] | undefined>) =>
      sessionResolver(headers),
  });
  server = httpServer;
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function createOrderOverHttp(): Promise<{ orderId: string; itemId: string }> {
  const response = await post('/api/v1/diagnostic-orders', {
    patientId: lab.patientId,
    encounterId: lab.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'GLUCOSE', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  });
  assert.equal(response.status, 201);
  const order = jsonOf(response.text);
  return { orderId: order.id, itemId: order.items[0].id };
}

describe('devices http: ingestion', () => {
  it('ingests a device acquisition with 201 and the contracted DTO shape', async () => {
    const { itemId } = await createOrderOverHttp();
    const response = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, {
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T04:00:00.000Z',
      rawPayload: { glucoseMgDl: 98 },
      orderItemId: itemId,
      patientId: lab.patientId,
      ingestionKey: 'http-ingest-1',
    });
    assert.equal(response.status, 201);
    const dto = jsonOf(response.text);
    assert.deepEqual(Object.keys(dto).sort(), [
      'acquiredAt',
      'adapterId',
      'deviceId',
      'facilityId',
      'id',
      'ingestedAt',
      'modality',
      'observationCount',
      'orderItemId',
      'patientId',
    ]);
    assert.equal(dto.observationCount, 1);
    assert.equal(dto.modality, 'LAB');
  });

  it('401s when no session resolves (fail closed)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, {
        adapterId: 'adapter-hema-1',
        acquiredAt: '2026-09-21T04:00:00.000Z',
        rawPayload: {},
        ingestionKey: 'http-ingest-unauth',
      });
      assert.equal(response.status, 401);
      assert.equal(jsonOf(response.text).error.code, 'UNAUTHENTICATED');
    } finally {
      sessionResolver = previous;
    }
  });

  it('404s an unregistered device with the stable NOT_FOUND code', async () => {
    const response = await post(
      `/api/v1/devices/${'00000000-0000-4000-8000-0000000000ff'}/acquisitions`,
      {
        adapterId: 'adapter-hema-1',
        acquiredAt: '2026-09-21T04:00:00.000Z',
        rawPayload: {},
        ingestionKey: 'http-ingest-unknown-device',
      },
    );
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });

  it('403s a device registered in another facility', async () => {
    repo.registerDevice({
      id: toBrandedId('00000000-0000-4000-8000-0000000000a4') as DeviceId,
      name: 'Remote Analyzer',
      modality: 'LAB',
      kind: 'ANALYZER',
      facilityId: OTHER_FACILITY,
    });
    const response = await post(
      `/api/v1/devices/${'00000000-0000-4000-8000-0000000000a4'}/acquisitions`,
      {
        adapterId: 'adapter-hema-1',
        acquiredAt: '2026-09-21T04:00:00.000Z',
        rawPayload: {},
        ingestionKey: 'http-ingest-cross-facility',
      },
    );
    assert.equal(response.status, 403);
  });

  it('403s a forged tenant', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => sessionFor(FACILITY, OTHER_ORG);
    try {
      const response = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, {
        adapterId: 'adapter-hema-1',
        acquiredAt: '2026-09-21T04:00:00.000Z',
        rawPayload: {},
        ingestionKey: 'http-ingest-forged',
      });
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('422s invalid payloads (missing adapter, bad timestamp, missing key)', async () => {
    for (const bad of [
      { acquiredAt: '2026-09-21T04:00:00.000Z', rawPayload: {}, ingestionKey: 'k1' },
      {
        adapterId: 'adapter-hema-1',
        acquiredAt: 'not-a-timestamp',
        rawPayload: {},
        ingestionKey: 'k2',
      },
      {
        adapterId: 'adapter-hema-1',
        acquiredAt: '2026-09-21T04:00:00.000Z',
        rawPayload: {},
      },
    ]) {
      const response = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, bad);
      assert.equal(response.status, 422);
      assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
    }
  });

  it('replays an identical ingestion idempotently over HTTP', async () => {
    const payload = {
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T05:00:00.000Z',
      rawPayload: { glucoseMgDl: 101 },
      ingestionKey: 'http-ingest-replay-1',
    };
    const first = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, payload);
    assert.equal(first.status, 201);
    const replay = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, payload);
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, jsonOf(first.text).id);
    assert.equal(jsonOf(replay.text).observationCount, 0); // raw-only replay
  });

  it('never leaks internals: no SQL, stacks, or audit fields in responses/errors', async () => {
    const created = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, {
      adapterId: 'adapter-hema-1',
      acquiredAt: '2026-09-21T06:00:00.000Z',
      rawPayload: { glucoseMgDl: 100 },
      ingestionKey: 'http-ingest-leak',
    });
    const text = created.text.toLowerCase();
    assert.ok(!text.includes('select '));
    assert.ok(!text.includes('postgres'));
    assert.ok(!text.includes('ingestion_key'));
    const failure = await post(`/api/v1/devices/${DEVICE_ID}/acquisitions`, {
      adapterId: 'adapter-hema-1',
    });
    assert.equal(failure.status, 422);
    assert.ok(!failure.text.toLowerCase().includes('stack'));
  });
});

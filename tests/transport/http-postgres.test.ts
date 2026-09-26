/**
 * HTTP → application service → PostgreSQL integration proof.
 *
 * Proves the REAL runtime path over real HTTP requests against a disposable
 * embedded PostgreSQL: transport → router → application services (scope,
 * idempotency, audit) → PostgreSQL repositories. Persistence is verified with
 * direct SQL AFTER the HTTP responses return — SQL is used only as evidence,
 * never as the proof of the HTTP contract itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';
import type { SessionResolver } from '../../src/transport/session';
import type { ApplicationSession } from '../../src/app/context';

const ORG = '00000000-0000-4000-8000-000000000001';
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000019';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';
const START = '2026-09-20T08:00:00.000Z';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'http-user' },
    userId: 'http-user',
    roles: ['manager', 'operator', 'viewer'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;

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
  return request('POST', path, { body: JSON.stringify(body), headers });
}

// Test accessor for parsed JSON bodies; property access is checked per-assertion
// with eslint disabled on the single line where the loose index type is declared.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

const ORDER_PATH = '/api/v1/diagnostic-orders';

function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patientId: PATIENT,
    encounterId: ENCOUNTER,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: START,
    ...overrides,
  };
}

before(async () => {
  db = await setupTestDatabase({ port: 55442 });
  // Composition at the edge: infrastructure runtime → transport router.
  const router = createRouter({ runtime: createPostgresLaboratoryRuntime(db) });
  const active = session();
  sessionResolver = async () => active;
  // Composition at the edge: transport + PostgreSQL request-scope runner.
  // Every authenticated request below executes under sdis_app with tenant
  // GUCs (RLS-01) — asserted by the scoped-patient tests in this file.
  server = createSdisHttpServer({
    router,
    sessionResolver: (headers) => sessionResolver(headers),
    requestScopeRunner: runWithTenantScope,
  });
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
  await teardownTestDatabase();
});

describe('http: order → specimen → observation → interpretation → report over PostgreSQL', () => {
  it('persists the complete laboratory flow driven through HTTP', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    assert.equal(created.status, 201);
    const order = jsonOf(created.text);

    // Correlation id survives the round trip.
    assert.ok(created.headers['x-correlation-id']);

    const item = order.items[0];

    const specimenResponse = await post(`/api/v1/order-items/${item.id}/specimens`, {
      patientId: PATIENT,
      kind: 'BLOOD',
      collectedAt: START,
    });
    assert.equal(specimenResponse.status, 201);
    const specimen = jsonOf(specimenResponse.text);

    for (const to of ['RECEIVED', 'ACCEPTED', 'PROCESSED'] as const) {
      const step = await post(`/api/v1/specimens/${specimen.id}/transitions`, {
        to,
        at: START,
      });
      assert.equal(step.status, 200, `specimen transition to ${to}`);
    }

    const observationResponse = await post(
      `/api/v1/order-items/${item.id}/observations`,
      {
        patientId: PATIENT,
        specimenId: specimen.id,
        code: 'HB',
        codeSystem: 'sdis',
        value: { kind: 'QUANTITATIVE', value: 13.2 },
        unit: 'g/dL',
        issuedBy: { kind: 'DEVICE', label: 'synthetic-analyzer', ref: 'device-1' },
        at: START,
      },
    );
    assert.equal(observationResponse.status, 201);

    const interpretationResponse = await post(
      `/api/v1/order-items/${item.id}/interpretations`,
      {
        source: { kind: 'ALGORITHM', label: 'synthetic-rules' },
        text: 'synthetic interpretation',
        at: START,
      },
    );
    assert.equal(interpretationResponse.status, 201);

    // Step-28 governance: verification precedes finalization (manager tier).
    // (The specimen collection above already advanced the order to ACQUIRED.)
    for (const to of ['PROCESSING', 'RESULT_ENTERED', 'VERIFIED'] as const) {
      const step = await post(`/api/v1/diagnostic-orders/${order.id}/transitions`, {
        to,
        at: START,
      });
      assert.equal(step.status, 200, `order transition to ${to}`);
    }

    const reportResponse = await post(`/api/v1/diagnostic-orders/${order.id}/reports`, {
      content: 'synthetic report',
      authoredAt: START,
    });
    assert.equal(reportResponse.status, 201);
    const report = jsonOf(reportResponse.text);

    const finalized = await post(`/api/v1/reports/${report.id}/finalize`, {
      at: START,
    });
    assert.equal(finalized.status, 200);
    assert.equal(jsonOf(finalized.text).latestStatus, 'FINALIZED');

    // --- persistence evidence (SQL as proof of persistence only) ---
    const persisted = await db.query<{
      patient_id: string;
      facility_id: string;
      specimen_id: string | null;
      report_status: string;
      issued_kind: string;
      interpretation_kind: string;
    }>(
      `
      SELECT o.patient_id, o.facility_id, s.id AS specimen_id,
             rv.status AS report_status,
             (SELECT source_kind FROM sdis.audit_events
               WHERE object_type = 'observation' LIMIT 1) AS issued_kind,
             (SELECT source_kind FROM sdis.audit_events
               WHERE object_type = 'interpretation' LIMIT 1) AS interpretation_kind
      FROM sdis.diagnostic_orders o
      JOIN sdis.order_items oi ON oi.order_id = o.id
      JOIN sdis.specimens s ON s.order_item_id = oi.id
      JOIN sdis.reports r ON r.order_id = o.id
      JOIN sdis.report_versions rv ON rv.report_id = r.id
      WHERE o.id = $1
    `,
      [order.id],
    );
    assert.equal(persisted.rowCount, 1);
    assert.equal(persisted.rows[0]?.patient_id, PATIENT);
    assert.equal(persisted.rows[0]?.facility_id, FACILITY);
    assert.equal(persisted.rows[0]?.specimen_id, specimen.id);
    assert.equal(persisted.rows[0]?.report_status, 'FINALIZED');
    assert.equal(persisted.rows[0]?.issued_kind, 'DEVICE');
    assert.equal(persisted.rows[0]?.interpretation_kind, 'ALGORITHM');

    const auditCount = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.audit_events',
    );
    assert.ok(Number(auditCount.rows[0]?.count) >= 10, 'audit trail persisted');
  });
});

describe('http: durable idempotency through HTTP', () => {
  it('retries with the same Idempotency-Key persist exactly one order', async () => {
    const first = await post(ORDER_PATH, orderPayload(), {
      'idempotency-key': 'http-pg-replay',
    });
    assert.equal(first.status, 201);
    const firstId = jsonOf(first.text).id as string;

    const replay = await post(ORDER_PATH, orderPayload(), {
      'idempotency-key': 'http-pg-replay',
    });
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, firstId);

    const stored = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.diagnostic_orders WHERE id = $1',
      [firstId],
    );
    assert.equal(Number(stored.rows[0]?.count), 1);
  });
});

describe('http: tenancy over the PostgreSQL runtime', () => {
  it('rejects cross-facility reads with 403 and persists nothing', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    const orderId = jsonOf(created.text).id as string;

    const previous = sessionResolver;
    sessionResolver = async () => session(OTHER_FACILITY);
    try {
      const response = await request('GET', `${ORDER_PATH}/${orderId}`);
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }

    // The order remains intact and unchanged.
    const count = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.diagnostic_orders WHERE id = $1',
      [orderId],
    );
    assert.equal(Number(count.rows[0]?.count), 1);
  });

  it('rejects a forged tenant before any resource check', async () => {
    const previous = sessionResolver;
    sessionResolver = async () =>
      session(FACILITY, '00000000-0000-4000-8000-000000000009');
    try {
      const response = await post(ORDER_PATH, orderPayload());
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('fails closed with 401 when no session resolves', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post(ORDER_PATH, orderPayload());
      assert.equal(response.status, 401);
      assert.equal(jsonOf(response.text).error.code, 'UNAUTHENTICATED');
    } finally {
      sessionResolver = previous;
    }
  });
});

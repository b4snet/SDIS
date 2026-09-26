/**
 * Step 34 — production-style smoke chain (§39) over the REAL runtime path.
 *
 * Disposable embedded PostgreSQL + real HTTP server + real application
 * services + real repositories. Synthetic data ONLY (seed fixtures and
 * "SMOKE"-labeled records) — never production data.
 *
 * Chain under proof:
 *
 *   process starts → configuration validates → health works → database
 *   connects → authentication works → tenant/facility scope works →
 *   patient access works → order workflow → specimen workflow → result
 *   workflow → QC workflow → inventory workflow → audit exists
 *
 * The audit step reads the ledger with direct SQL — SQL is evidence only;
 * every other proof goes through the public HTTP contract.
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
import { createPostgresReadinessProbe } from '../../src/infrastructure/database/health-probe';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import { unauthenticatedSessionResolver } from '../../src/transport/session';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';
import { validateStartupConfig } from '../../src/runtime/process';
import {
  createMetricsRegistry,
  type MetricsRegistry,
} from '../../src/core/observability/metrics';
import type { SessionResolver } from '../../src/transport/session';
import type { ApplicationSession } from '../../src/app/context';

const ORG = '00000000-0000-4000-8000-000000000001';
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000019';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';
const START = '2026-09-24T03:00:00.000Z';

function session(facilityId = FACILITY): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'smoke-operator' },
    userId: 'smoke-operator',
    roles: ['manager', 'operator', 'viewer'] as never,
    organizationId: ORG as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let metrics: MetricsRegistry;

interface Response {
  readonly status: number;
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
  return { status: response.status, text: await response.text() };
}

function post(path: string, body: unknown): Promise<Response> {
  return request('POST', path, { body: JSON.stringify(body) });
}

// Test accessor for parsed JSON bodies; property access is checked per-assertion
// with eslint disabled on the single line where the loose index type is declared.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

before(async () => {
  db = await setupTestDatabase({ port: 55444 });
  metrics = createMetricsRegistry();
  // The startup gate must accept the deployment's configuration before the
  // server binds — proven here exactly as an operator would run it.
  validateStartupConfig({ env: {} });
  const router = createRouter({ runtime: createPostgresLaboratoryRuntime(db) });
  const active = session();
  sessionResolver = async () => active;
  server = createSdisHttpServer({
    router,
    sessionResolver: (headers) => sessionResolver(headers),
    readinessProbes: { postgres: createPostgresReadinessProbe(db) },
    metrics,
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

describe('smoke: runtime, health & security boundaries', () => {
  it('process is alive, database is ready, metrics series are exposed', async () => {
    const healthz = await request('GET', '/healthz');
    assert.equal(healthz.status, 200);
    assert.equal(jsonOf(healthz.text).status, 'ok'); // liveness: process-local

    const readyz = await request('GET', '/readyz');
    assert.equal(readyz.status, 200);
    assert.deepEqual(jsonOf(readyz.text).dependencies, { postgres: 'ok' });

    const metricsRes = await request('GET', '/metrics');
    assert.equal(metricsRes.status, 200);
    const series = jsonOf(metricsRes.text).metrics as Record<string, number>;
    // Each request is observed synchronously before its own response flushes,
    // so a LATER request's snapshot always sees earlier traffic; one extra
    // probe guarantees the final read sees the whole probe sequence.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await request('GET', '/healthz');
    const settled = await request('GET', '/metrics');
    const settledSeries = jsonOf(settled.text).metrics as Record<string, number>;
    assert.ok(
      (settledSeries['sdis_http_requests_total|GET|2xx'] ?? 0) >= 4,
      `expected the probe traffic to be counted, got ${JSON.stringify(series)}`,
    );
    assert.ok(
      (settledSeries['sdis_readiness_probes_total|postgres|ok'] ?? 0) >= 1,
      'readiness probes must feed the alertable dependency series',
    );
  });

  it('authentication works: absent credentials fail closed, a session serves', async () => {
    const previous = sessionResolver;
    sessionResolver = unauthenticatedSessionResolver;
    try {
      const denied = await request('GET', `/api/v1/patients/${PATIENT}`);
      assert.equal(denied.status, 401);
    } finally {
      sessionResolver = previous;
    }
    const allowed = await request('GET', `/api/v1/patients/${PATIENT}`);
    assert.equal(allowed.status, 200);
  });

  it('tenant/facility scope works: a foreign-facility session cannot read the patient', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => session(OTHER_FACILITY);
    try {
      const foreign = await request('GET', `/api/v1/patients/${PATIENT}`);
      assert.ok(
        foreign.status === 403 || foreign.status === 404,
        `expected 403/404 (fail-closed), got ${foreign.status}`,
      );
    } finally {
      sessionResolver = previous;
    }
  });
});

describe('smoke: clinical & operational workflow chain', () => {
  it('register → order → collect → accession → result → verify → hold → release → finalize', async () => {
    // ---- patient registration: a duplicate claimed identity is rejected ----
    const registered = await post('/api/v1/patients', {
      fullName: 'SMOKE Duplicate Rejection',
      sex: 'F',
      birthDate: '1992-02-02',
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'SMOKE-MRN-1' }],
    });
    assert.equal(registered.status, 201, registered.text);
    const repeat = await post('/api/v1/patients', {
      fullName: 'SMOKE Duplicate Rejection',
      sex: 'F',
      birthDate: '1992-02-02',
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'SMOKE-MRN-1' }],
    });
    assert.equal(
      repeat.status,
      409,
      `expected duplicate rejection, got ${repeat.status}`,
    );

    // ---- order workflow (seeded patient/encounter pair) ---------------------
    const orderRes = await post('/api/v1/diagnostic-orders', {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'SMK', codeSystem: 'sdis' }],
      orderedAt: '2000-01-01T00:00:00.000Z',
    });
    assert.equal(orderRes.status, 201, orderRes.text);
    const order = jsonOf(orderRes.text);
    const item = order['items'][0] as Record<string, unknown>;

    // ---- specimen workflow: collect, then accession at RECEIVED -------------
    const specimenRes = await post(`/api/v1/order-items/${item['id']}/specimens`, {
      orderItemId: item['id'],
      patientId: PATIENT,
      kind: 'BLOOD',
      collectedAt: START,
    });
    assert.equal(specimenRes.status, 201, specimenRes.text);
    const specimen = jsonOf(specimenRes.text);
    const received = await post(`/api/v1/specimens/${specimen['id']}/transitions`, {
      to: 'RECEIVED',
      at: START,
    });
    assert.equal(received.status, 200, received.text);
    const accession = jsonOf(received.text)['accessionNumber'] as string;
    assert.match(accession, /^SDIS-\d{4}-\d{8}$/); // accession identity assigned

    // ---- order workflow: advance (collection auto-acquired the order) -------
    for (const to of ['PROCESSING', 'RESULT_ENTERED', 'VERIFIED']) {
      const step = await post(`/api/v1/diagnostic-orders/${order['id']}/transitions`, {
        to,
        at: START,
      });
      assert.equal(step.status, 200, `${to}: ${step.text}`);
    }

    // ---- result workflow ----------------------------------------------------
    const observationRes = await post(`/api/v1/order-items/${item['id']}/observations`, {
      patientId: PATIENT,
      specimenId: specimen['id'],
      code: 'SMK',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 7.5 },
      unit: 'mmol/L',
      issuedBy: { kind: 'DEVICE', label: 'smoke-analyzer', ref: 'smoke-1' },
      at: START,
    });
    assert.equal(observationRes.status, 201, observationRes.text);
    const interpretationRes = await post(
      `/api/v1/order-items/${item['id']}/interpretations`,
      {
        source: { kind: 'ALGORITHM', label: 'smoke-rules' },
        text: 'SMOKE synthetic interpretation',
        at: START,
      },
    );
    assert.equal(interpretationRes.status, 201, interpretationRes.text);

    // ---- report + QC hold boundary ------------------------------------------
    const reportRes = await post(`/api/v1/diagnostic-orders/${order['id']}/reports`, {
      content: 'SMOKE synthetic report.',
      authoredAt: START,
    });
    assert.equal(reportRes.status, 201, reportRes.text);
    const report = jsonOf(reportRes.text);

    const holdRes = await post('/api/v1/quality/records', {
      family: 'IQC',
      referenceType: 'smoke-analyzer',
      at: START,
      hold: { reason: 'SMOKE IQC out of range' },
    });
    assert.equal(holdRes.status, 201, holdRes.text);
    const hold = jsonOf(holdRes.text)['hold'] as Record<string, unknown>;

    const finalizeHeld = await post(`/api/v1/reports/${report['id']}/finalize`, {
      finalizerRef: 'Dr. Smoke',
      at: START,
    });
    assert.equal(finalizeHeld.status, 409); // analytical hold gates finalization

    const releaseRes = await post('/api/v1/quality/holds/release', {
      holdId: hold['id'],
      at: START,
    });
    assert.equal(releaseRes.status, 200, releaseRes.text);

    const finalizeRes = await post(`/api/v1/reports/${report['id']}/finalize`, {
      finalizerRef: 'Dr. Smoke',
      at: START,
    });
    assert.equal(finalizeRes.status, 200, finalizeRes.text);

    const reportRead = await request('GET', `/api/v1/reports/${report['id']}`);
    assert.equal(reportRead.status, 200);
    assert.ok(reportRead.text.includes('FINALIZED')); // finalized history readable
  });

  it('inventory workflow: receipt → issue → consistent non-negative balance', async () => {
    const itemRes = await post('/api/v1/inventory/items', {
      sku: 'SMOKE-RG-1',
      name: 'SMOKE synthetic reagent',
      category: 'REAGENT',
    });
    assert.equal(itemRes.status, 201, itemRes.text);
    const item = jsonOf(itemRes.text);

    const lotRes = await post('/api/v1/inventory/receive', {
      itemId: item['id'],
      lotNumber: 'SMOKE-LOT-1',
      expiryDate: '2099-01-01',
      quantity: 5,
    });
    assert.equal(lotRes.status, 201, lotRes.text);

    const issue = await post('/api/v1/inventory/issue', {
      batchId: jsonOf(lotRes.text)['batchId'],
      quantity: 2,
      movementType: 'OUT',
      reason: 'SMOKE consumption',
    });
    assert.equal(issue.status, 201, issue.text);

    // Stock floor: an over-consuming issue must not drive the balance negative.
    const overdraw = await post('/api/v1/inventory/issue', {
      batchId: jsonOf(lotRes.text)['batchId'],
      quantity: 99,
      movementType: 'OUT',
      reason: 'SMOKE overdraw attempt',
    });
    assert.ok(
      [409, 422].includes(overdraw.status),
      `expected 409/422, got ${overdraw.status}`,
    );

    const balance = await request('GET', `/api/v1/inventory/items/${item['id']}/lots`);
    assert.equal(balance.status, 200);
    const lot = jsonOf(balance.text).lots.find(
      (l: { lot: { lotNumber: string } }) => l.lot.lotNumber === 'SMOKE-LOT-1',
    );
    assert.ok(lot, 'SMOKE-LOT-1 must appear in the balance');
    assert.equal(lot.balance, 3); // derived ledger balance: 5 − 2, never negative
  });

  it('audit trail exists for the exercised workflow (read-only evidence)', async () => {
    const result = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
       WHERE organization_id = $1::uuid AND facility_id = $2::uuid`,
      [ORG, FACILITY],
    );
    const audits = Number(result.rows[0]?.count ?? 0);
    assert.ok(
      audits >= 6,
      `expected the smoke workflow to leave >= 6 audit events, found ${audits}`,
    );
  });
});

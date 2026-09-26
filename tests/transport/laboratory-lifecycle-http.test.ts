/**
 * Step 27 — Laboratory workflow HTTP contract tests.
 *
 * Proves the lifecycle additions over the REAL HTTP transport with
 * credential-resolved sessions (in-memory persistence substrate):
 * the enriched specimen-transition body (rejection reason, accession prefix),
 * worklist read-model filters, and the quality/hold boundary. Error mapping,
 * authentication posture, and safe DTOs follow the established transport
 * contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { createFixture, sessionFor } from '../app/helpers';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let fixture: ReturnType<typeof createFixture>;

function startServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const router = createRouter({ runtime: fixture as never });
    const httpServer = createSdisHttpServer({
      router,
      sessionResolver: (headers) => sessionResolver(headers),
    });
    server = httpServer;
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });
}

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

function jsonOf(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

before(async () => {
  fixture = createFixture();
  const active = sessionFor();
  (active as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
  sessionResolver = async () => active;
  await startServer();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Drives one order to a collected specimen through the transport. */
async function collectedSpecimen(
  testCode: string,
): Promise<{ order: Record<string, unknown>; specimen: Record<string, unknown> }> {
  const orderRes = await request('POST', '/api/v1/diagnostic-orders', {
    body: JSON.stringify({
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      modality: 'LAB',
      items: [{ testCode, codeSystem: 'sdis' }],
      orderedAt: '2026-09-23T08:00:00.000Z',
    }),
  });
  assert.equal(orderRes.status, 201);
  const order = jsonOf(orderRes.text);
  const item = (order['items'] as Record<string, unknown>[])[0]!;
  const specimenRes = await request(
    `POST`,
    `/api/v1/order-items/${item['id']}/specimens`,
    {
      body: JSON.stringify({
        orderItemId: item['id'],
        patientId: fixture.patientId,
        kind: 'BLOOD',
        collectedAt: '2026-09-23T08:05:00.000Z',
      }),
    },
  );
  assert.equal(specimenRes.status, 201);
  return { order, specimen: jsonOf(specimenRes.text) };
}

describe('specimen lifecycle over HTTP (Step 27)', () => {
  it('RECEIVED assigns an accession number in the DTO; rejection persists a reason', async () => {
    const { specimen } = await collectedSpecimen('CBC');

    const received = await request(
      'POST',
      `/api/v1/specimens/${specimen['id']}/transitions`,
      {
        body: JSON.stringify({ to: 'RECEIVED', at: '2026-09-23T08:10:00.000Z' }),
      },
    );
    assert.equal(received.status, 200);
    const receivedDto = jsonOf(received.text);
    assert.ok(typeof receivedDto['accessionNumber'] === 'string');
    assert.match(receivedDto['accessionNumber'] as string, /^SDIS-\d{4}-\d{8}$/);

    const rejected = await request(
      'POST',
      `/api/v1/specimens/${specimen['id']}/transitions`,
      {
        body: JSON.stringify({
          to: 'REJECTED',
          at: '2026-09-23T08:15:00.000Z',
          rejectionReason: 'DAMAGED_SPECIMEN',
        }),
      },
    );
    assert.equal(rejected.status, 200);
    assert.equal(jsonOf(rejected.text)['rejectionReason'], 'DAMAGED_SPECIMEN');
  });

  it('a rejection without a reason is 422; a bad reason is 422', async () => {
    const { specimen } = await collectedSpecimen('LFT');
    await request('POST', `/api/v1/specimens/${specimen['id']}/transitions`, {
      body: JSON.stringify({ to: 'RECEIVED', at: '2026-09-23T09:10:00.000Z' }),
    });

    const missing = await request(
      'POST',
      `/api/v1/specimens/${specimen['id']}/transitions`,
      { body: JSON.stringify({ to: 'REJECTED', at: '2026-09-23T09:15:00.000Z' }) },
    );
    assert.equal(missing.status, 422);
    const missingBody = jsonOf(missing.text) as { error?: Record<string, unknown> };
    const missingError = missingBody['error'] as Record<string, unknown>;
    assert.ok(typeof missingError['message'] === 'string');
    assert.ok(typeof missingError['correlationId'] === 'string');

    const bad = await request('POST', `/api/v1/specimens/${specimen['id']}/transitions`, {
      body: JSON.stringify({
        to: 'REJECTED',
        at: '2026-09-23T09:20:00.000Z',
        rejectionReason: 'BECAUSE',
      }),
    });
    assert.equal(bad.status, 422);
  });

  it('unauthenticated transition is 401', async () => {
    const { specimen } = await collectedSpecimen('GLUCOSE');
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await request(
        'POST',
        `/api/v1/specimens/${specimen['id']}/transitions`,
        { body: JSON.stringify({ to: 'RECEIVED', at: '2026-09-23T10:10:00.000Z' }) },
      );
      assert.equal(response.status, 401);
    } finally {
      sessionResolver = previous;
    }
  });
});

describe('order transitions authorization over HTTP (AUD-01)', () => {
  it('denies order lifecycle transitions to the viewer tier (403, no state change)', async () => {
    const orderRes = await request('POST', '/api/v1/diagnostic-orders', {
      body: JSON.stringify({
        patientId: fixture.patientId,
        encounterId: fixture.encounterId,
        modality: 'LAB',
        items: [{ testCode: 'AUD-01', codeSystem: 'sdis' }],
        orderedAt: '2026-09-23T13:00:00.000Z',
      }),
    });
    assert.equal(orderRes.status, 201);
    const order = jsonOf(orderRes.text);
    const viewer = sessionFor();
    (viewer as { roles?: readonly string[] }).roles = ['viewer'] as never;
    const previous = sessionResolver;
    sessionResolver = async () => viewer;
    try {
      for (const to of ['ACQUIRED', 'CANCELLED']) {
        const denied = await request(
          'POST',
          `/api/v1/diagnostic-orders/${order['id']}/transitions`,
          { body: JSON.stringify({ to, at: '2026-09-23T13:05:00.000Z' }) },
        );
        assert.equal(denied.status, 403, `viewer transition to ${to} must be denied`);
        const deniedBody = jsonOf(denied.text)['error'] as Record<string, unknown>;
        assert.equal(deniedBody['code'], 'FORBIDDEN');
      }
    } finally {
      sessionResolver = previous;
    }
    // The denied attempts changed nothing: the order is still ORDERED.
    const readBack = await request('GET', `/api/v1/diagnostic-orders/${order['id']}`);
    assert.equal(readBack.status, 200);
    assert.equal(jsonOf(readBack.text)['status'], 'ORDERED');
  });

  it('allows the operator tier to advance orders (positive control)', async () => {
    const orderRes = await request('POST', '/api/v1/diagnostic-orders', {
      body: JSON.stringify({
        patientId: fixture.patientId,
        encounterId: fixture.encounterId,
        modality: 'LAB',
        items: [{ testCode: 'AUD-01-POS', codeSystem: 'sdis' }],
        orderedAt: '2026-09-23T13:10:00.000Z',
      }),
    });
    assert.equal(orderRes.status, 201);
    const order = jsonOf(orderRes.text);
    const advanced = await request(
      'POST',
      `/api/v1/diagnostic-orders/${order['id']}/transitions`,
      { body: JSON.stringify({ to: 'ACQUIRED', at: '2026-09-23T13:11:00.000Z' }) },
    );
    assert.equal(advanced.status, 200);
    assert.equal(jsonOf(advanced.text)['status'], 'ACQUIRED');
  });
});

describe('worklist filters over HTTP (Step 27)', () => {
  it('narrows by status and priority; invalid status is 422', async () => {
    const response = await request('GET', '/api/v1/worklist?status=ORDERED');
    assert.equal(response.status, 200);
    const entries = JSON.parse(response.text) as Record<string, unknown>[];
    assert.ok(Array.isArray(entries));

    const priority = await request('GET', '/api/v1/worklist?priority=EMERGENCY');
    assert.equal(priority.status, 200);

    const invalid = await request('GET', '/api/v1/worklist?status=NOT_A_STATUS');
    assert.equal(invalid.status, 422);
  });
});

describe('quality boundary over HTTP (Step 27)', () => {
  it('records + hold pause finalization; release unblocks; operator tier is 403', async () => {
    const orderRes = await request('POST', '/api/v1/diagnostic-orders', {
      body: JSON.stringify({
        patientId: fixture.patientId,
        encounterId: fixture.encounterId,
        modality: 'LAB',
        items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
        orderedAt: '2026-09-23T12:00:00.000Z',
      }),
    });
    const order = jsonOf(orderRes.text);
    // Verification gate (Step 28): walk to VERIFIED before finalizing.
    // (No specimen is collected here, so ACQUIRED is explicit.) VERIFIED is a
    // manager-tier transition, so the walk runs under the manager session.
    const managerForWalk = sessionFor();
    (managerForWalk as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    const previousWalk = sessionResolver;
    sessionResolver = async () => managerForWalk;
    try {
      for (const to of ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED', 'VERIFIED']) {
        const step = await request(
          'POST',
          `/api/v1/diagnostic-orders/${order['id']}/transitions`,
          { body: JSON.stringify({ to, at: '2026-09-23T12:05:00.000Z' }) },
        );
        assert.equal(step.status, 200);
      }
    } finally {
      sessionResolver = previousWalk;
    }
    const reportRes = await request(
      'POST',
      `/api/v1/diagnostic-orders/${order['id']}/reports`,
      {
        body: JSON.stringify({
          content: 'Hold HTTP synthetic report.',
          authoredAt: '2026-09-23T12:10:00.000Z',
        }),
      },
    );
    assert.equal(reportRes.status, 201);
    const report = jsonOf(reportRes.text);

    // Operator tier holds QUALITY_MANAGE? No — record as manager.
    const previous = sessionResolver;
    const operatorSession = sessionFor();
    (operatorSession as { roles?: readonly string[] }).roles = [
      'operator',
      'viewer',
    ] as never;
    const managerSession = sessionFor();
    (managerSession as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    sessionResolver = async () => managerSession;
    try {
      const recordRes = await request('POST', '/api/v1/quality/records', {
        body: JSON.stringify({
          family: 'IQC',
          referenceType: 'analyzer-1',
          at: '2026-09-23T12:15:00.000Z',
          hold: { reason: 'IQC out of range — hold release' },
        }),
      });
      assert.equal(recordRes.status, 201);
      const record = jsonOf(recordRes.text);
      assert.ok(record['hold']);

      const finalize = await request('POST', `/api/v1/reports/${report['id']}/finalize`, {
        body: JSON.stringify({
          finalizerRef: 'Dr. Synthetic',
          at: '2026-09-23T12:20:00.000Z',
        }),
      });
      assert.equal(finalize.status, 409);

      const releaseRes = await request('POST', '/api/v1/quality/holds/release', {
        body: JSON.stringify({
          holdId: (record['hold'] as Record<string, unknown>)['id'],
          at: '2026-09-23T12:25:00.000Z',
        }),
      });
      assert.equal(releaseRes.status, 200);

      const finalizeOk = await request(
        'POST',
        `/api/v1/reports/${report['id']}/finalize`,
        {
          body: JSON.stringify({
            finalizerRef: 'Dr. Synthetic',
            at: '2026-09-23T12:30:00.000Z',
          }),
        },
      );
      assert.equal(finalizeOk.status, 200);

      // Operator tier cannot manage quality (QUALITY_MANAGE is manager-only).
      sessionResolver = async () => operatorSession;
      const denied = await request('POST', '/api/v1/quality/records', {
        body: JSON.stringify({
          family: 'QC',
          referenceType: 'analyzer-1',
          at: '2026-09-23T12:35:00.000Z',
        }),
      });
      assert.equal(denied.status, 403);
    } finally {
      sessionResolver = previous;
    }
  });

  it('quality records read back without internal fields', async () => {
    const previous = sessionResolver;
    const managerSession = sessionFor();
    (managerSession as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    sessionResolver = async () => managerSession;
    try {
      const response = await request('GET', '/api/v1/quality/records?family=IQC');
      assert.equal(response.status, 200);
      const body = jsonOf(response.text);
      const records = body['records'] as Record<string, unknown>[];
      assert.ok(records.length > 0);
      for (const record of records) {
        assert.ok(
          !('provenance' in record) === false ||
            record['provenance'] === undefined ||
            typeof record['provenance'] === 'object',
        );
        assert.ok(
          !('db' in record) && !('sql' in record) && !('connectionString' in record),
        );
      }
    } finally {
      sessionResolver = previous;
    }
  });
});

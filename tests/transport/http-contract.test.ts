/**
 * HTTP transport contract tests.
 *
 * These tests independently establish the transport contract over the REAL
 * application services (in-memory adapters as the persistence substrate):
 * validation, authentication posture, tenancy/facility scope, IDOR resistance,
 * error shape, idempotency, and data-leakage prevention. No self-validating
 * mocks: a real `node:http` server is started on an ephemeral port and driven
 * with real requests.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { createFixture, sessionFor, T0 } from '../app/helpers';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: {
    body?: string;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': options.contentType ?? 'application/json' }
        : {}),
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

// Test accessor for parsed JSON bodies; property access is checked per-assertion
// with eslint disabled on the single line where the loose index type is declared.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

const ORDER_PATH = '/api/v1/diagnostic-orders';

function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patientId: '00000000-0000-4000-8000-0000000000e1',
    encounterId: '00000000-0000-4000-8000-0000000000c1',
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: T0,
    ...overrides,
  };
}

before(async () => {
  fixture = createFixture();
  // The harness plugs a controlled session source into the single documented
  // seam — this mirrors exactly what a future authentication boundary would do.
  // Staff role claims (Step 27 RBAC): the laboratory services fail closed for
  // role-less sessions, so the harness session carries the operator tier.
  const active = sessionFor();
  (active as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
  sessionResolver = async () => active;
  await startServer();
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// Transport: validation, encoding, media type, size
// ---------------------------------------------------------------------------

describe('transport: request validation', () => {
  it('accepts a valid POST /diagnostic-orders with 201 and a DTO body', async () => {
    const response = await post(ORDER_PATH, orderPayload());
    assert.equal(response.status, 201);
    const order = jsonOf(response.text);
    assert.equal(order.status, 'ORDERED');
    assert.equal(order.facilityId, '00000000-0000-4000-8000-000000000011');
    assert.ok(Array.isArray(order.items) && order.items.length === 1);
  });

  it('rejects malformed JSON with 400 in the mandated error shape', async () => {
    const response = await post(ORDER_PATH, '{"patientId": ');
    assert.equal(response.status, 400);
    const body = jsonOf(response.text);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.equal(typeof body.error.correlationId, 'string');
    assert.deepEqual(body.error.details, []);
  });

  it('rejects a non-object JSON body with 422', async () => {
    const response = await post(ORDER_PATH, '[1,2,3]');
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('rejects missing required fields with 422', async () => {
    const response = await post(ORDER_PATH, { patientId: 'x' });
    assert.equal(response.status, 422);
    const message = jsonOf(response.text).error.message as string;
    assert.match(message, /patientId/);
  });

  it('rejects non-UUID v4 identifiers with 422 (format-only check)', async () => {
    const response = await post(ORDER_PATH, orderPayload({ patientId: 'not-a-uuid' }));
    assert.equal(response.status, 422);
    const message = jsonOf(response.text).error.message as string;
    assert.match(message, /UUID v4/);
  });

  it('rejects unsupported content types with 415', async () => {
    const response = await request('POST', ORDER_PATH, {
      body: 'patient=Bond',
      contentType: 'application/x-www-form-urlencoded',
    });
    assert.equal(response.status, 415);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('rejects oversized request bodies with 413', async () => {
    const response = await post(ORDER_PATH, {
      ...orderPayload(),
      padding: 'x'.repeat(100 * 1024),
    });
    assert.equal(response.status, 413);
  });

  it('accepts a large body still under the 64 KiB limit', async () => {
    const response = await post(ORDER_PATH, {
      ...orderPayload(),
      padding: 'x'.repeat(60 * 1024),
    });
    assert.equal(response.status, 201);
  });

  it('rejects unknown routes with 404 and stable NOT_FOUND code', async () => {
    const response = await request('GET', '/api/v1/none-such');
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });

  it('rejects non-API prefixes with 404', async () => {
    const response = await request('GET', '/diagnostic-orders');
    assert.equal(response.status, 404);
  });

  it('rejects unsupported methods with 405', async () => {
    const response = await fetch(`${baseUrl}${ORDER_PATH}`, { method: 'PUT' });
    assert.equal(response.status, 405);
  });

  it('echoes correlation ids and mints them when absent', async () => {
    const minted = await post(ORDER_PATH, orderPayload());
    assert.ok(minted.headers['x-correlation-id']);
    const echoed = await post(ORDER_PATH, orderPayload(), {
      'x-correlation-id': 'trace-42',
    });
    assert.equal(echoed.headers['x-correlation-id'], 'trace-42');
  });

  it('mints a fresh correlation id for unsafe inbound tokens', async () => {
    // Safe tokens are printable ASCII \x21-\x7E up to 128 chars; anything else
    // (here: over-long, or containing a space) is replaced by a minted id.
    const tooLong = await post(ORDER_PATH, orderPayload(), {
      'x-correlation-id': 'x'.repeat(200),
    });
    const tooLongEcho = tooLong.headers['x-correlation-id'];
    assert.ok(tooLongEcho);
    assert.notEqual(tooLongEcho, 'x'.repeat(200));

    const withSpace = await post(ORDER_PATH, orderPayload(), {
      'x-correlation-id': 'trace 42',
    });
    assert.notEqual(withSpace.headers['x-correlation-id'], 'trace 42');
  });
});

// ---------------------------------------------------------------------------
// Authentication: unauthenticated / invalid / authenticated
// ---------------------------------------------------------------------------

describe('transport: authentication posture', () => {
  it('401s every request when no session resolves (fail closed)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post(ORDER_PATH, orderPayload());
      assert.equal(response.status, 401);
      const body = jsonOf(response.text);
      assert.equal(body.error.code, 'UNAUTHENTICATED');
      assert.equal(body.error.message, 'Authentication is required');
      // The message is neutral: it never claims the authentication boundary is
      // "not yet integrated", nor does it distinguish absent/invalid/unknown
      // credentials (AUTH-01). 401 responses carry a `WWW-Authenticate: Bearer`
      // challenge (AUTH-04) identifying the accepted authentication scheme.
      assert.equal(response.headers['www-authenticate'], 'Bearer');
    } finally {
      sessionResolver = previous;
    }
  });

  it('401s unauthenticated GETs too — no read bypass', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await request(
        'GET',
        `${ORDER_PATH}/00000000-0000-4000-8000-0000000000e1`,
      );
      assert.equal(response.status, 401);
    } finally {
      sessionResolver = previous;
    }
  });

  it('keeps the application contract authoritative when a session exists', async () => {
    // With a session, a VALID-shape payload still hits the application
    // boundary and its errors surface with application semantics.
    const response = await post(
      ORDER_PATH,
      orderPayload({ encounterId: '00000000-0000-4000-8000-0000000000c2' }),
    );
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });
});

// ---------------------------------------------------------------------------
// Tenancy / facility scope / IDOR
// ---------------------------------------------------------------------------

describe('transport: tenancy and facility scope', () => {
  it('accepts a valid in-scope request', async () => {
    const response = await post(ORDER_PATH, orderPayload());
    assert.equal(response.status, 201);
  });

  it('rejects a forged tenant (facility owned by another organization)', async () => {
    const previous = sessionResolver;
    // A future auth boundary derives scope server-side; a forged organization
    // on an otherwise valid facility must fail closed at the application edge.
    const forged = sessionFor(
      '00000000-0000-4000-8000-000000000011' as never,
      '00000000-0000-4000-8000-000000000009' as never,
    );
    (forged as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
    sessionResolver = async () => forged;
    try {
      const response = await post(ORDER_PATH, orderPayload());
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('rejects a wrong facility (resource owned by another facility)', async () => {
    const previous = sessionResolver;
    // Facility 0012 belongs to the SAME organization — proves the facility
    // check is not merely the tenant check.
    const foreign = sessionFor('00000000-0000-4000-8000-000000000012' as never);
    (foreign as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
    sessionResolver = async () => foreign;
    try {
      const response = await post(ORDER_PATH, orderPayload());
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('is IDOR-resistant on reads: another facility cannot fetch the order', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    const orderId = jsonOf(created.text).id as string;
    const previous = sessionResolver;
    sessionResolver = async () =>
      sessionFor('00000000-0000-4000-8000-000000000012' as never);
    try {
      const response = await request('GET', `${ORDER_PATH}/${orderId}`);
      assert.equal(response.status, 403);
    } finally {
      sessionResolver = previous;
    }
  });

  it('is IDOR-resistant on reads: an unknown id is NOT_FOUND, not a leak', async () => {
    const response = await request(
      'GET',
      `${ORDER_PATH}/00000000-0000-4000-8000-0000000000ff`,
    );
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });

  it('rejects forged patient/encounter combinations through the service', async () => {
    // Encounter c2 belongs to the OTHER patient — the application boundary must
    // reject the pairing even though both ids are individually valid UUID v4s.
    const response = await post(
      ORDER_PATH,
      orderPayload({ encounterId: '00000000-0000-4000-8000-0000000000c2' }),
    );
    assert.equal(response.status, 422);
  });

  it('rejects unknown patients with 404 through the service', async () => {
    const response = await post(
      ORDER_PATH,
      orderPayload({ patientId: '00000000-0000-4000-8000-0000000000ee' }),
    );
    assert.equal(response.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Domain execution over HTTP
// ---------------------------------------------------------------------------

describe('transport: laboratory domain execution', () => {
  it('drives order → specimen → observation → interpretation → report', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    const order = jsonOf(created.text);
    const orderItem = order.items[0];

    const specimenResponse = await post(`/api/v1/order-items/${orderItem.id}/specimens`, {
      patientId: order.patientId,
      kind: 'BLOOD',
      collectedAt: T0,
    });
    assert.equal(specimenResponse.status, 201);
    const specimen = jsonOf(specimenResponse.text);
    assert.equal(specimen.status, 'COLLECTED');

    const transition = await post(`/api/v1/specimens/${specimen.id}/transitions`, {
      to: 'RECEIVED',
      at: T0,
    });
    assert.equal(transition.status, 200);
    assert.equal(jsonOf(transition.text).status, 'RECEIVED');

    const observationResponse = await post(
      `/api/v1/order-items/${orderItem.id}/observations`,
      {
        patientId: order.patientId,
        specimenId: specimen.id,
        code: 'HB',
        codeSystem: 'sdis',
        value: { kind: 'QUANTITATIVE', value: 13.2 },
        unit: 'g/dL',
        issuedBy: { kind: 'DEVICE', label: 'synthetic-analyzer' },
        at: T0,
      },
    );
    assert.equal(observationResponse.status, 201);
    const observation = jsonOf(observationResponse.text);
    assert.equal(observation.issuedByKind, 'DEVICE');

    const interpretationResponse = await post(
      `/api/v1/order-items/${orderItem.id}/interpretations`,
      {
        source: { kind: 'HUMAN', label: 'pathologist' },
        text: 'synthetic reading',
        at: T0,
      },
    );
    assert.equal(interpretationResponse.status, 201);

    const interpretations = await request(
      'GET',
      `/api/v1/order-items/${orderItem.id}/interpretations`,
    );
    assert.equal(interpretations.status, 200);
    assert.equal(jsonOf(interpretations.text).length, 1);

    const observations = await request(
      'GET',
      `/api/v1/order-items/${orderItem.id}/observations`,
    );
    assert.equal(observations.status, 200);
    assert.equal(jsonOf(observations.text).length, 1);

    // Verification gate (Step 28): the order is walked to VERIFIED over HTTP
    // before the report finalizes (VERIFIED requires the manager tier).
    // Specimen collection above already moved the order to ACQUIRED.
    for (const to of ['PROCESSING', 'RESULT_ENTERED']) {
      const step = await post(`/api/v1/diagnostic-orders/${order.id}/transitions`, {
        to,
        at: T0,
      });
      assert.equal(step.status, 200);
    }
    const previousSession = sessionResolver;
    const managerSession = sessionFor();
    (managerSession as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    sessionResolver = async () => managerSession;
    const verify = await post(`/api/v1/diagnostic-orders/${order.id}/transitions`, {
      to: 'VERIFIED',
      at: T0,
    });
    assert.equal(verify.status, 200);
    const verifyBody = jsonOf(verify.text) as { verifiedByRef?: string };
    assert.equal(
      verifyBody.verifiedByRef,
      'user-tech-1',
      'verifier is the session actor',
    );
    sessionResolver = previousSession;

    const reportResponse = await post(`/api/v1/diagnostic-orders/${order.id}/reports`, {
      content: 'synthetic report',
      authoredAt: T0,
    });
    assert.equal(reportResponse.status, 201);
    const report = jsonOf(reportResponse.text);

    const finalized = await post(`/api/v1/reports/${report.id}/finalize`, {
      at: T0,
    });
    assert.equal(finalized.status, 200);
    assert.equal(jsonOf(finalized.text).latestStatus, 'FINALIZED');

    // Finalized reports are immutable: a second finalize is a 409 CONFLICT.
    const refinalize = await post(`/api/v1/reports/${report.id}/finalize`, {
      at: T0,
    });
    assert.equal(refinalize.status, 409);
    assert.equal(jsonOf(refinalize.text).error.code, 'CONFLICT');

    // Amendment creates a superseding version (never a silent overwrite).
    // Manager tier + bounded reason (Step 28 governance).
    sessionResolver = async () => managerSession;
    const amended = await post(`/api/v1/reports/${report.id}/amendments`, {
      content: 'amended synthetic report',
      authoredAt: T0,
      amendmentReason: 'TRANSCRIPTION_CORRECTION',
    });
    sessionResolver = previousSession;
    assert.equal(amended.status, 200);
    const amendedReport = jsonOf(amended.text);
    assert.equal(amendedReport.latestVersion, 2);
    assert.equal(amendedReport.versions.length, 2);
    assert.ok(amendedReport.versions[1].supersedesVersionId);
    assert.equal(amendedReport.versions[1].amendmentReason, 'TRANSCRIPTION_CORRECTION');
    // Versioned CONTENT flows end-to-end (report-content DTO versioning,
    // BASELINE-01): v1 keeps the original text, v2 the amendment — no silent
    // overwrite and no content-less version objects at the HTTP boundary.
    assert.equal(amendedReport.versions[0].content, 'synthetic report');
    assert.equal(amendedReport.versions[1].content, 'amended synthetic report');

    // Scope-checked read-back of the report resource (GET /reports/{id}).
    const readBack = await request('GET', `/api/v1/reports/${report.id}`);
    assert.equal(readBack.status, 200);
    assert.equal(jsonOf(readBack.text).latestVersion, 2);
  });

  it('rejects invalid lifecycle transitions with 409 from the domain state machine', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    const order = jsonOf(created.text);
    // ORDERED -> FINALIZED is not a legal transition (the domain machine
    // requires verification first); the operator harness surfaces the domain
    // 409 (VERIFIED itself is manager-gated and would 403 here).
    const response = await post(`/api/v1/diagnostic-orders/${order.id}/transitions`, {
      to: 'FINALIZED',
      at: T0,
    });
    assert.equal(response.status, 409);
    assert.equal(jsonOf(response.text).error.code, 'INVALID_STATE_TRANSITION');
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('transport: idempotency', () => {
  it('replays the same Idempotency-Key header to the same order (no duplicate)', async () => {
    const first = await post(ORDER_PATH, orderPayload({ orderedAt: T0 }), {
      'idempotency-key': 'retry-1',
    });
    assert.equal(first.status, 201);
    const second = await post(ORDER_PATH, orderPayload({ orderedAt: T0 }), {
      'idempotency-key': 'retry-1',
    });
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
  });

  it('prefers the Idempotency-Key header over a body field', async () => {
    const first = await post(ORDER_PATH, orderPayload({ idempotencyKey: 'body-key' }), {
      'idempotency-key': 'header-wins',
    });
    const second = await post(ORDER_PATH, orderPayload({ idempotencyKey: 'body-key' }), {
      'idempotency-key': 'header-wins',
    });
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
  });

  it('does not collapse distinct keys into one order', async () => {
    const first = await post(ORDER_PATH, orderPayload({ orderedAt: T0 }), {
      'idempotency-key': 'distinct-1',
    });
    const second = await post(ORDER_PATH, orderPayload({ orderedAt: T0 }), {
      'idempotency-key': 'distinct-2',
    });
    assert.notEqual(jsonOf(second.text).id, jsonOf(first.text).id);
  });

  it('keeps specimen collection idempotent through the same mechanism', async () => {
    const created = await post(ORDER_PATH, orderPayload({ orderedAt: T0 }));
    const item = jsonOf(created.text).items[0];
    const payload = {
      patientId: jsonOf(created.text).patientId,
      kind: 'SERUM',
      collectedAt: T0,
    };
    const first = await post(`/api/v1/order-items/${item.id}/specimens`, payload, {
      'idempotency-key': 'specimen-retry',
    });
    const second = await post(`/api/v1/order-items/${item.id}/specimens`, payload, {
      'idempotency-key': 'specimen-retry',
    });
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
  });
});

// ---------------------------------------------------------------------------
// Data leakage: no internals, no audit internals, no unnecessary PHI
// ---------------------------------------------------------------------------

describe('transport: data leakage prevention', () => {
  it('exposes only DTO fields on orders (no audit internals, no hidden ids)', async () => {
    const response = await post(ORDER_PATH, orderPayload());
    const order = jsonOf(response.text);
    assert.deepEqual(Object.keys(order).sort(), [
      'encounterId',
      'facilityId',
      'id',
      'items',
      'modality',
      'orderedAt',
      'orderedByRef',
      'patientId',
      // Step 21: operational workflow priority is part of the order contract.
      'priority',
      'status',
    ]);
    assert.deepEqual(Object.keys(order.items[0]).sort(), [
      'codeSystem',
      'id',
      'testCode',
    ]);
  });

  it('carries provenance source kind, never raw provenance objects', async () => {
    const created = await post(ORDER_PATH, orderPayload());
    const item = jsonOf(created.text).items[0];
    const response = await post(`/api/v1/order-items/${item.id}/observations`, {
      patientId: jsonOf(created.text).patientId,
      code: 'GLU',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 5.5 },
      issuedBy: { kind: 'DEVICE', label: 'analyzer-9', ref: 'dev-9' },
      at: T0,
    });
    const observation = jsonOf(response.text);
    assert.equal(observation.issuedByKind, 'DEVICE');
    assert.equal(observation.issuedByRef, 'dev-9');
    assert.equal(observation['issuedBy'], undefined);
    assert.equal(observation['provenance'], undefined);
    assert.equal(observation['actor'], undefined);
  });

  it('never returns stack traces, SQL, or infrastructure detail on failures', async () => {
    const response = await post(ORDER_PATH, orderPayload({ modality: 'NOPE' }));
    const body = jsonOf(response.text);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    const text = response.text.toLowerCase();
    assert.ok(!text.includes('select '), 'no SQL fragments in errors');
    assert.ok(!text.includes('stack'), 'no stack traces in errors');
    assert.ok(!text.includes('postgres'), 'no database detail in errors');
    assert.ok(!text.includes('password'), 'no credentials in errors');
  });
});

// ---------------------------------------------------------------------------
// Unexpected internal failures: generic 500, never internals
// ---------------------------------------------------------------------------

describe('transport: unexpected failures collapse to a generic 500', () => {
  let failingServer: Server;
  let failingUrl: string;

  before(async () => {
    // A router that throws a non-application error forces the 500 collapse
    // path in server.ts → serializeError.
    const router = async () => {
      throw new Error('boom: secret stack detail');
    };
    const httpServer = createSdisHttpServer({ router });
    failingServer = httpServer;
    await new Promise<void>((resolve, reject) => {
      failingServer.listen(0, '127.0.0.1', () => {
        const address = failingServer.address() as AddressInfo;
        failingUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
      failingServer.on('error', reject);
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => failingServer.close(() => resolve()));
  });

  it('maps a non-application failure to 500 INTERNAL with a generic message', async () => {
    const response = await fetch(`${failingUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 500);
    const text = await response.text();
    const body = jsonOf(text);
    assert.equal(body.error.code, 'INTERNAL');
    assert.equal(body.error.message, 'Internal application error');
    assert.deepEqual(body.error.details, []);
    assert.equal(typeof body.error.correlationId, 'string');
    assert.ok(!text.includes('boom'), 'no internal message leaked');
    assert.ok(!text.includes('stack'), 'no stack traces leaked');
  });
});

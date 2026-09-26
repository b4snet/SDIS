/**
 * Priority & worklist HTTP contract tests (Step 21).
 *
 * Proves the emergency-priority capability over the REAL HTTP transport:
 * creation with priority, invalid-vocabulary rejection, authorized priority
 * change with idempotent replay, cross-facility scope rejection, worklist
 * read under ORDER_READ, and the error-contract / no-leakage guarantees.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { OrderService } from '../../src/app/laboratory/order-service';
import { WorklistService } from '../../src/app/laboratory/worklist-service';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  PATIENT_ID,
  ENCOUNTER_ID,
  at,
  type LabFixture,
} from '../app/helpers';
import type { ApplicationSession } from '../../src/app/context';

interface Response {
  readonly status: number;
  readonly text: string;
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let activeSession: ApplicationSession;
let fixture: LabFixture;
let authz: AuthorizationService;
let worklist: WorklistService;
let orderCount = 0;

/** Creates a deterministic order through the canonical application service. */
async function seedOrder(priority?: string): Promise<string> {
  orderCount += 1;
  const order = await fixture.orders.createOrder(activeSession, {
    patientId: PATIENT_ID,
    encounterId: ENCOUNTER_ID,
    modality: 'LAB',
    items: [{ testCode: 'SYN-TEST', codeSystem: 'SDIS-SYNTHETIC' }],
    orderedAt: at(10 + orderCount),
    priority,
  });
  return order.id;
}

before(async () => {
  fixture = createFixture();
  authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  // Re-wire the SAME dependency instances with the authorization engine so
  // RBAC enforcement is exercised over HTTP exactly as in production.
  const orderDeps = (fixture.orders as unknown as { deps: Record<string, unknown> }).deps;
  const rewiredOrders = new OrderService({
    ...orderDeps,
    authz,
  } as ConstructorParameters<typeof OrderService>[0]);
  worklist = new WorklistService({ ...orderDeps, authz } as never);
  fixture = { ...fixture, orders: rewiredOrders };
  activeSession = withRoles(sessionFor(), ['operator']);

  sessionResolver = async () => activeSession;
  const httpServer = createSdisHttpServer({
    router: createRouter({
      runtime: { orders: rewiredOrders, worklist },
    }),
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

describe('priority http: creation & validation', () => {
  it('creates an order with priority EMERGENCY (201, canonical priority echoed)', async () => {
    const response = await send('POST', '/api/v1/diagnostic-orders', {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-EMRG', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(20),
      priority: 'EMERGENCY',
    });
    assert.equal(response.status, 201);
    const body = jsonOf(response.text);
    assert.equal(body.priority, 'EMERGENCY');
    assert.equal(body.status, 'ORDERED');
  });

  it('rejects an invalid priority vocabulary as validation (422, no leakage)', async () => {
    const response = await send('POST', '/api/v1/diagnostic-orders', {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-BAD', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(21),
      priority: 'YESTERDAY',
    });
    assert.equal(response.status, 422);
    const body = jsonOf(response.text);
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(!response.text.includes('at assertOrderPriority'));
    assert.ok(!response.text.includes('stack'));
  });

  it('rejects a malformed order id on the priority route as validation (422)', async () => {
    const response = await send('POST', '/api/v1/diagnostic-orders/not-a-uuid/priority', {
      priority: 'URGENT',
      at: at(22),
    });
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });
});

describe('priority http: authorized change, idempotency & scope', () => {
  it('changes priority when authorized (200) and audits exactly once', async () => {
    const id = await seedOrder('ROUTINE');
    const response = await send('POST', `/api/v1/diagnostic-orders/${id}/priority`, {
      priority: 'EMERGENCY',
      at: at(30),
    });
    assert.equal(response.status, 200);
    const body = jsonOf(response.text);
    assert.equal(body.id, id);
    assert.equal(body.priority, 'EMERGENCY');

    const updates = fixture.audit
      .list()
      .filter(
        (event) =>
          event.objectId === id &&
          event.action === 'UPDATED' &&
          event.detail?.includes('priority ROUTINE -> EMERGENCY'),
      );
    assert.equal(updates.length, 1);
  });

  it('replays the same idempotency key without duplicate mutation or audit', async () => {
    const id = await seedOrder('URGENT');
    const payload = { priority: 'EMERGENCY', at: at(31), idempotencyKey: 'http-idem-21' };
    const first = await send('POST', `/api/v1/diagnostic-orders/${id}/priority`, payload);
    assert.equal(first.status, 200);
    assert.equal(jsonOf(first.text).priority, 'EMERGENCY');

    const replay = await send(
      'POST',
      `/api/v1/diagnostic-orders/${id}/priority`,
      payload,
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(jsonOf(replay.text), jsonOf(first.text));

    const updates = fixture.audit
      .list()
      .filter(
        (event) =>
          event.objectId === id &&
          event.action === 'UPDATED' &&
          event.detail?.includes('priority'),
      );
    assert.equal(updates.length, 1);
  });

  it('rejects cross-facility priority change (403) without leaking existence', async () => {
    const id = await seedOrder('ROUTINE');
    activeSession = withRoles(sessionFor(OTHER_FACILITY), ['operator']);
    const response = await send('POST', `/api/v1/diagnostic-orders/${id}/priority`, {
      priority: 'EMERGENCY',
      at: at(32),
    });
    activeSession = withRoles(sessionFor(), ['operator']);
    assert.equal(response.status, 403);
    assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
  });

  it('rejects an unauthorized viewer escalation (403)', async () => {
    const id = await seedOrder('ROUTINE');
    activeSession = withRoles(sessionFor(), ['viewer']);
    const response = await send('POST', `/api/v1/diagnostic-orders/${id}/priority`, {
      priority: 'EMERGENCY',
      at: at(33),
    });
    activeSession = withRoles(sessionFor(), ['operator']);
    assert.equal(response.status, 403);
    assert.equal(jsonOf(response.text).error.code, 'FORBIDDEN');
  });

  it('answers 401 unauthenticated and 404 for an unknown in-scope order', async () => {
    sessionResolver = async () => undefined as unknown as ApplicationSession;
    const unauthenticated = await send('GET', '/api/v1/worklist');
    sessionResolver = async () => activeSession;
    assert.equal(unauthenticated.status, 401);

    const missing = await send(
      'POST',
      `/api/v1/diagnostic-orders/00000000-0000-4000-8000-00000000dead/priority`,
      {
        priority: 'URGENT',
        at: at(34),
      },
    );
    assert.equal(missing.status, 404);
    assert.ok(!missing.text.includes('sdis'));
  });
});

describe('priority http: worklist read model', () => {
  it('orders EMERGENCY before URGENT before ROUTINE deterministically', async () => {
    const routine = await seedOrder('ROUTINE');
    const emergency = await seedOrder('EMERGENCY');
    const urgent = await seedOrder('URGENT');

    const response = await send('GET', '/api/v1/worklist');
    assert.equal(response.status, 200);
    const entries = jsonOf(response.text) as { id: string; priority: string }[];
    const ids = entries.map((entry) => entry.id);
    assert.ok(ids.indexOf(emergency) < ids.indexOf(urgent));
    assert.ok(ids.indexOf(urgent) < ids.indexOf(routine));
    assert.ok(
      entries.every((entry) =>
        ['ROUTINE', 'URGENT', 'EMERGENCY'].includes(entry.priority),
      ),
    );
  });
});

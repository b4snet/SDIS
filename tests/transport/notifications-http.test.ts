/**
 * Notification HTTP contract tests (Step 19).
 *
 * The event bus is NOT a public API — only a delivery-receipt read model and
 * the bounded event-type vocabulary are exposed, under the existing
 * authentication, RBAC, scope, error-envelope, and correlation conventions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { NotificationService } from '../../src/app/notifications/notification-service';
import {
  InMemoryNotificationAdapter,
  InMemoryIdempotencyStore,
  InMemoryNotificationOutbox,
} from '../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { createFixture, sessionFor, OTHER_FACILITY } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';

interface Response {
  readonly status: number;
  readonly text: string;
}

async function request(path: string): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, text: await response.text() };
}

async function post(path: string, body: unknown): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
let knownEventId: string;
let knownAdapter: InMemoryNotificationAdapter;
let knownService: NotificationService;

before(async () => {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const adapter = new InMemoryNotificationAdapter();
  knownAdapter = adapter;
  const notifications = new NotificationService({
    adapters: [adapter],
    outbox: new InMemoryNotificationOutbox(),
    facilities,
    audit: fixture.audit,
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  knownService = notifications;
  const idempotency = new InMemoryIdempotencyStore();
  void idempotency;

  activeSession = withRoles(sessionFor(), ['viewer']);
  // Two real deliveries exist so the list read model has pagination metadata.
  const { event } = await notifications.emit(activeSession, {
    type: 'order.created',
    aggregateId: '00000000-0000-4000-8000-0000000000a1',
    correlationId: 'corr-http-19',
    metadata: { orderStatus: 'ORDERED' },
  });
  knownEventId = event.eventId;
  await notifications.emit(activeSession, {
    type: 'order.created',
    aggregateId: '00000000-0000-4000-8000-0000000000a2',
    correlationId: 'corr-http-19b',
    metadata: { orderStatus: 'ORDERED' },
  });

  sessionResolver = async () => activeSession;
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { notifications } }),
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

describe('notification http: delivery read model', () => {
  it('returns the receipt for a delivered event within scope (200)', async () => {
    const response = await request(`/api/v1/notifications/deliveries/${knownEventId}`);
    assert.equal(response.status, 200);
    const body = jsonOf(response.text);
    assert.equal(body.eventId, knownEventId);
    assert.equal(body.receipts.length, 1);
    assert.equal(body.receipts[0].status, 'DELIVERED');
    assert.equal(body.receipts[0].channel, 'IN_MEMORY');
    // No internal leakage.
    assert.ok(!response.text.includes('select '));
    assert.ok(!response.text.includes('stack'));
  });

  it('rejects cross-facility delivery reads (403) and unknown events (404)', async () => {
    activeSession = withRoles(sessionFor(OTHER_FACILITY), ['viewer']);
    const foreign = await request(`/api/v1/notifications/deliveries/${knownEventId}`);
    assert.equal(foreign.status, 403);

    activeSession = withRoles(sessionFor(), ['viewer']);
    const missing = await request(
      '/api/v1/notifications/deliveries/00000000-0000-4000-8000-00000000dead',
    );
    assert.equal(missing.status, 404);
    assert.ok(!missing.text.includes('sdis'));
  });

  it('lists the bounded event-type vocabulary without exposing bus mechanics', async () => {
    const response = await request('/api/v1/notifications/event-types');
    assert.equal(response.status, 200);
    const body = jsonOf(response.text);
    assert.ok(Array.isArray(body.eventTypes));
    assert.ok(body.eventTypes.includes('order.created'));
    assert.ok(!JSON.stringify(body).includes('adapter'));
    assert.ok(!JSON.stringify(body).includes('deliveryLog'));
  });

  it('rejects invalid event id formats (422) and unauthenticated calls (401)', async () => {
    activeSession = withRoles(sessionFor(), ['viewer']);
    const invalid = await request('/api/v1/notifications/deliveries/not-a-uuid');
    assert.equal(invalid.status, 422);

    // Swap to a resolver that yields no session → 401 envelope.
    sessionResolver = async () => undefined as unknown as ApplicationSession;
    const unauthenticated = await request('/api/v1/notifications/event-types');
    assert.equal(unauthenticated.status, 401);
  });
});

describe('notification http: durable outbox contract', () => {
  it('lists the durable delivery intents with keyset pagination metadata (200)', async () => {
    activeSession = withRoles(sessionFor(), ['viewer']);
    sessionResolver = async () => withRoles(sessionFor(), ['viewer']);
    const response = await request('/api/v1/notifications?limit=1');
    assert.equal(response.status, 200);
    const body = jsonOf(response.text);
    assert.equal(body.items.length, 1);
    assert.equal(typeof body.nextCursor, 'string');
    assert.ok(body.items[0].id);
    assert.ok(body.items[0].eventType);
    assert.ok(body.items[0].status);
    // No payloads, no provider secrets, no internal leakage.
    assert.ok(!('correlationId' in body.items[0]));
    assert.ok(!('metadata' in body.items[0]));
    assert.ok(!response.text.toLowerCase().includes('adapter'));
    assert.ok(!response.text.toLowerCase().includes('select '));
  });

  it('rejects malformed pagination input (422)', async () => {
    activeSession = withRoles(sessionFor(), ['viewer']);
    const response = await request('/api/v1/notifications?limit=0');
    assert.equal(response.status, 422);
    const oversized = await request('/api/v1/notifications?limit=101');
    assert.equal(oversized.status, 422);
  });

  it('returns the delivery detail with its attempt ledger (200)', async () => {
    activeSession = withRoles(sessionFor(), ['viewer']);
    const list = await request('/api/v1/notifications?limit=5');
    const first = (jsonOf(list.text) as { items: Array<{ id: string }> }).items[0];
    if (!first) throw new Error('expected at least one intent');
    const intentId = first.id;
    const detail = await request(`/api/v1/notifications/${intentId}`);
    assert.equal(detail.status, 200);
    const body = jsonOf(detail.text);
    assert.equal(body.id, intentId);
    assert.ok(Array.isArray(body.attempts));
    assert.ok(!('metadata' in body));
    assert.ok(!('recipientRef' in body) || typeof body.recipientRef === 'string');
  });

  it('scopes the list to the session facility and 404s foreign intents', async () => {
    activeSession = withRoles(sessionFor(OTHER_FACILITY), ['viewer']);
    sessionResolver = async () => activeSession;
    const foreignList = await request('/api/v1/notifications?limit=50');
    assert.equal(foreignList.status, 200);
    assert.equal(jsonOf(foreignList.text).items.length, 0);

    activeSession = withRoles(sessionFor(), ['viewer']);
    sessionResolver = async () => activeSession;
    const list = await request('/api/v1/notifications?limit=5');
    const first = (jsonOf(list.text) as { items: Array<{ id: string }> }).items[0];
    if (!first) throw new Error('expected at least one intent');
    const intentId = first.id;
    const missing = await request(
      `/api/v1/notifications/00000000-0000-4000-8000-00000000dead`,
    );
    assert.equal(missing.status, 404);
    // A foreign-facility detail read must NOT reveal the intent.
    activeSession = withRoles(sessionFor(OTHER_FACILITY), ['viewer']);
    sessionResolver = async () => activeSession;
    const foreignDetail = await request(`/api/v1/notifications/${intentId}`);
    assert.equal(foreignDetail.status, 404);
  });

  it('rejects malformed intent ids with 422 (never a crash)', async () => {
    activeSession = withRoles(sessionFor(), ['viewer']);
    sessionResolver = async () => activeSession;
    const response = await request('/api/v1/notifications/not-a-uuid');
    assert.equal(response.status, 422);
  });

  it('re-queues a failed intent via POST retry (manager tier only)', async () => {
    activeSession = withRoles(sessionFor(), ['manager', 'viewer']);
    sessionResolver = async () => activeSession;
    knownAdapter.programFailure('order.created', 'FAILED');
    const emitted = await emitThrough('corr-http-retry-001', '2026-09-20T08:04:00.000Z');
    const listText = await (await request('/api/v1/notifications?limit=50')).text;
    const items = (
      jsonOf(listText) as {
        items: Array<{ id: string; eventId: string; status: string }>;
      }
    ).items;
    const failed = items.find((i) => i.eventId === emitted);
    if (!failed) throw new Error('expected the failed intent');
    assert.equal(failed.status, 'FAILED');
    const retried = await post(`/api/v1/notifications/${failed.id}/retry`, {
      at: '2026-09-20T08:05:00.000Z',
    });
    assert.equal(retried.status, 200);
    assert.equal(jsonOf(retried.text).status, 'PENDING');

    // Viewer lacks NOTIFICATION_MANAGE → 403.
    activeSession = withRoles(sessionFor(), ['viewer']);
    sessionResolver = async () => activeSession;
    const asViewer = await post(`/api/v1/notifications/${failed.id}/retry`, {
      at: '2026-09-20T08:06:00.000Z',
    });
    assert.equal(asViewer.status, 403);
    activeSession = withRoles(sessionFor(), ['manager', 'viewer']);
    sessionResolver = async () => activeSession;
  });

  it('cancels a queued intent via POST cancel and refuses it once terminal', async () => {
    activeSession = withRoles(sessionFor(), ['manager', 'viewer']);
    sessionResolver = async () => activeSession;
    knownAdapter.programFailure('order.created', 'FAILED');
    const emitted = await emitThrough('corr-http-cancel-001', '2026-09-20T08:07:00.000Z');
    const listText = await (await request('/api/v1/notifications?limit=50')).text;
    const items = (jsonOf(listText) as { items: Array<{ id: string; eventId: string }> })
      .items;
    const failed = items.find((i) => i.eventId === emitted);
    if (!failed) throw new Error('expected the failed intent');
    const cancelled = await post(`/api/v1/notifications/${failed.id}/cancel`, {
      at: '2026-09-20T08:08:00.000Z',
    });
    assert.equal(cancelled.status, 200);
    assert.equal(jsonOf(cancelled.text).status, 'CANCELLED');
    // Cancelling again (now terminal) → 409 conflict.
    const again = await post(`/api/v1/notifications/${failed.id}/cancel`, {
      at: '2026-09-20T08:09:00.000Z',
    });
    assert.equal(again.status, 409);
    assert.ok(!again.text.includes('sdis'), 'no internal identifiers leak');
  });

  it('rejects lifecycle calls with malformed bodies (422) and unauthenticated (401)', async () => {
    activeSession = withRoles(sessionFor(), ['manager']);
    sessionResolver = async () => activeSession;
    const noAt = await post(
      '/api/v1/notifications/00000000-0000-4000-8000-000000000ff2/retry',
      {},
    );
    assert.equal(noAt.status, 422);
    const badAt = await post(
      '/api/v1/notifications/00000000-0000-4000-8000-000000000ff2/cancel',
      { at: 'yesterday' },
    );
    assert.equal(badAt.status, 422);
    sessionResolver = async () => undefined as unknown as ApplicationSession;
    const unauthenticated = await request('/api/v1/notifications?limit=10');
    assert.equal(unauthenticated.status, 401);
    activeSession = withRoles(sessionFor(), ['manager']);
    sessionResolver = async () => activeSession;
  });
});

/** Emits one event through the server-managed service; returns its event id. */
async function emitThrough(correlationId: string, occurredAt: string): Promise<string> {
  const { event } = await knownService.emit(activeSession, {
    type: 'order.created',
    aggregateId: '00000000-0000-4000-8000-0000000000a1',
    correlationId,
    occurredAt,
  });
  return event.eventId;
}

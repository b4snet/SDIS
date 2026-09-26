/**
 * Notifications & event delivery — service query/lifecycle tests (Step 19).
 *
 * Proves the read model (keyset-paginated list, detail with attempt ledger),
 * RBAC gating (NOTIFICATION_READ vs NOTIFICATION_MANAGE), tenant/facility
 * scope isolation, bounded-limit validation, terminal-state refusal, conflict
 * handling, and audit emission for retry/cancel — over the in-memory outbox.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationService } from '../../../src/app/notifications/notification-service';
import {
  InMemoryNotificationAdapter,
  InMemoryNotificationOutbox,
  type AuditLogPort,
} from '../../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import type { ApplicationSession } from '../../../src/app/context';
import { InvalidStateTransitionError, ValidationError } from '../../../src/app/errors';
import { createFixture, sessionFor, at, OTHER_FACILITY } from '../helpers';
import type { FacilityDirectory } from '../../../src/app/ports';

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

interface Harness {
  readonly service: NotificationService;
  readonly adapter: InMemoryNotificationAdapter;
  readonly outbox: InMemoryNotificationOutbox;
  readonly audit: AuditLogPort;
}

function makeHarness(
  options: {
    adapter?: InMemoryNotificationAdapter;
    outbox?: InMemoryNotificationOutbox;
    withoutOutbox?: boolean;
  } = {},
): Harness {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const adapter = options.adapter ?? new InMemoryNotificationAdapter();
  const outbox = options.outbox ?? new InMemoryNotificationOutbox();
  const service = new NotificationService({
    adapters: [adapter],
    ...(options.withoutOutbox ? {} : { outbox }),
    facilities,
    audit: fixture.audit,
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  return { service, adapter, outbox, audit: fixture.audit };
}

async function emitMany(
  service: NotificationService,
  session: ApplicationSession,
  count: number,
): Promise<void> {
  for (let i = 1; i <= count; i += 1) {
    await service.emit(session, {
      type: 'order.created',
      aggregateId: `00000000-0000-4000-8000-0000000000a${i}`,
      correlationId: `corr-q-${String(i).padStart(3, '0')}`,
      occurredAt: at(i),
      metadata: { orderStatus: 'ORDERED' },
    });
  }
}

describe('notification service: read model', () => {
  it('lists intents newest-first with items + nextCursor (keyset pagination)', async () => {
    const h = makeHarness();
    const session = withRoles(sessionFor(), ['viewer']);
    await emitMany(h.service, session, 5);

    const page1 = await h.service.listNotifications(session, { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.equal(typeof page1.nextCursor, 'string');
    // List DTOs deliberately omit correlationId and payloads (detail-only).
    assert.ok(!('correlationId' in (page1.items[0] ?? {})));
    assert.ok(page1.items[0]?.eventId);

    const page2 = await h.service.listNotifications(session, {
      cursor: page1.nextCursor ?? undefined,
      limit: 2,
    });
    assert.ok(page2.nextCursor);
    const page3 = await h.service.listNotifications(session, {
      cursor: page2.nextCursor ?? undefined,
      limit: 2,
    });
    assert.equal(page3.nextCursor, null);
    const all = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
    assert.equal(new Set(all).size, 5, 'keyset pages must never duplicate items');
  });

  it('rejects out-of-bounds limits before touching the store', async () => {
    const h = makeHarness();
    const session = withRoles(sessionFor(), ['viewer']);
    for (const limit of [0, -1, 101, 1.5]) {
      await assert.rejects(
        h.service.listNotifications(session, { limit }),
        ValidationError,
      );
    }
  });

  it('returns the full detail (incl. the attempt ledger) for one intent', async () => {
    const h = makeHarness();
    const session = withRoles(sessionFor(), ['viewer']);
    await emitMany(h.service, session, 1);
    const page = await h.service.listNotifications(session, { limit: 10 });
    const detail = await h.service.getNotification(session, page.items[0]?.id as never);
    assert.equal(detail.status, 'DELIVERED');
    assert.equal(detail.attemptCount, 1);
    assert.equal(detail.correlationId, 'corr-q-001');
    assert.equal(detail.attempts.length, 1);
    assert.equal(detail.attempts[0]?.outcome, 'SUCCESS');
    assert.ok(!('metadata' in detail), 'payloads must never leak into DTOs');
  });

  it('is not found for unknown intents and empty for cross-facility lists', async () => {
    const h = makeHarness();
    const session = withRoles(sessionFor(), ['viewer']);
    await emitMany(h.service, session, 1);
    const page = await h.service.listNotifications(session, { limit: 10 });
    const id = page.items[0]?.id as never;

    await assert.rejects(
      h.service.getNotification(session, '00000000-0000-4000-8000-00000000cafe' as never),
      /not found/i,
    );
    // Cross-facility: same organization, different facility → nothing visible.
    const foreign = withRoles(sessionFor(OTHER_FACILITY), ['viewer']);
    const foreignPage = await h.service.listNotifications(foreign, { limit: 10 });
    assert.equal(foreignPage.items.length, 0);
    await assert.rejects(h.service.getNotification(foreign, id), /not found/i);
  });

  it('is fail-closed when no durable outbox is wired', async () => {
    const h = makeHarness({ withoutOutbox: true });
    const session = withRoles(sessionFor(), ['viewer']);
    await assert.rejects(
      h.service.listNotifications(session, { limit: 10 }),
      /not configured/i,
    );
    await assert.rejects(
      h.service.getNotification(session, '00000000-0000-4000-8000-00000000cafe' as never),
      /not configured/i,
    );
  });
});

describe('notification service: RBAC and lifecycle', () => {
  it('denies retry/cancel to a viewer (NOTIFICATION_READ without MANAGE)', async () => {
    const h = makeHarness();
    const viewer = withRoles(sessionFor(), ['viewer']);
    const manager = withRoles(sessionFor(), ['manager']);
    await emitMany(h.service, manager, 1);
    const page = await h.service.listNotifications(manager, { limit: 10 });
    const id = page.items[0]?.id as never;
    await assert.rejects(
      h.service.retryNotification(viewer, id, { at: at(2) }),
      /permission|forbidden/i,
    );
    await assert.rejects(
      h.service.cancelNotification(viewer, id, { at: at(2) }),
      /permission|forbidden/i,
    );
  });

  it('re-queues a FAILED intent via retry and audits the transition', async () => {
    const failing = new InMemoryNotificationAdapter();
    failing.programFailure('order.created', 'FAILED');
    const h = makeHarness({ adapter: failing });
    const session = withRoles(sessionFor(), ['manager', 'viewer']);
    const { event } = await h.service.emit(session, {
      type: 'order.created',
      aggregateId: '00000000-0000-4000-8000-0000000000a1',
      correlationId: 'corr-retry-001',
      occurredAt: at(1),
    });
    const page = await h.service.listNotifications(session, { limit: 10 });
    const item = page.items.find((i) => i.eventId === event.eventId);
    if (!item) throw new Error('expected the failed intent');
    assert.equal(item.status, 'FAILED');
    assert.ok(item.nextAttemptAt, 'retry window must be set after the sync failure');

    const requeued = await h.service.retryNotification(session, item.id as never, {
      at: at(2),
    });
    assert.equal(requeued.status, 'PENDING');
    assert.equal(requeued.nextAttemptAt, undefined);
    assert.equal(
      h.audit.list().filter((e) => e.objectId === item.id && e.action === 'TRANSITIONED')
        .length,
      1,
      'retry must be audited through the existing chain',
    );
  });

  it('refuses retry of a terminal or in-flight intent', async () => {
    const h = makeHarness();
    const session = withRoles(sessionFor(), ['manager', 'viewer']);
    await emitMany(h.service, session, 1); // sync-delivered
    const page = await h.service.listNotifications(session, { limit: 10 });
    const id = page.items[0]?.id as never;
    assert.equal(page.items[0]?.status, 'DELIVERED');
    await assert.rejects(
      h.service.retryNotification(session, id, { at: at(2) }),
      InvalidStateTransitionError,
    );
  });

  it('cancels queued intents, refusing cancellation after delivery', async () => {
    const failing = new InMemoryNotificationAdapter();
    failing.programFailure('order.created', 'FAILED');
    const h = makeHarness({ adapter: failing });
    const session = withRoles(sessionFor(), ['manager', 'viewer']);
    const { event } = await h.service.emit(session, {
      type: 'order.created',
      aggregateId: '00000000-0000-4000-8000-0000000000a1',
      correlationId: 'corr-cancel-001',
      occurredAt: at(1),
    });
    const page = await h.service.listNotifications(session, { limit: 10 });
    const failedItem = page.items.find((i) => i.eventId === event.eventId);
    if (!failedItem) throw new Error('expected the failed intent');
    const cancelled = await h.service.cancelNotification(
      session,
      failedItem.id as never,
      {
        at: at(2),
      },
    );
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(
      h.audit
        .list()
        .filter((e) => e.objectId === failedItem.id && e.action === 'CANCELLED').length,
      1,
      'cancel must be audited through the existing chain',
    );

    // A delivered intent (healthy path) cannot be cancelled.
    const healthy = makeHarness();
    await emitMany(healthy.service, session, 1);
    const healthyPage = await healthy.service.listNotifications(session, { limit: 10 });
    const deliveredId = healthyPage.items[0]?.id as never;
    assert.equal(healthyPage.items[0]?.status, 'DELIVERED');
    await assert.rejects(
      healthy.service.cancelNotification(session, deliveredId, { at: at(4) }),
      InvalidStateTransitionError,
    );
  });

  it('refuses a stale requeue (CAS conflict) and retry of a now-terminal intent', async () => {
    const failing = new InMemoryNotificationAdapter();
    failing.programFailure('order.created', 'FAILED');
    const outbox = new InMemoryNotificationOutbox();
    const h = makeHarness({ adapter: failing, outbox });
    const session = withRoles(sessionFor(), ['manager', 'viewer']);
    const { event } = await h.service.emit(session, {
      type: 'order.created',
      aggregateId: '00000000-0000-4000-8000-0000000000a1',
      correlationId: 'corr-cas-001',
      occurredAt: at(1),
    });
    const page = await h.service.listNotifications(session, { limit: 10 });
    const id = page.items.find((i) => i.eventId === event.eventId)?.id as never;
    // The intent is FAILED; another worker permanently fails it first → the
    // stale requeue CAS is refused by the store (service surfaces CONFLICT).
    const settled = await outbox.settle({
      intentId: id,
      expectedStatus: 'FAILED',
      toStatus: 'PERMANENTLY_FAILED',
      attempt: {
        id: '00000000-0000-4000-8000-0000000000ff1',
        intentId: id,
        attemptNumber: 2,
        attemptedAt: at(2),
        outcome: 'FAILED',
      },
    });
    assert.equal(settled, true);
    assert.equal(
      await outbox.requeue(id, 'FAILED', at(3)),
      false,
      'stale CAS must refuse',
    );
    // The service re-reads the (now terminal) intent before acting.
    await assert.rejects(
      h.service.retryNotification(session, id, { at: at(3) }),
      InvalidStateTransitionError,
    );
  });
});

/**
 * Notifications & event delivery — durable outbox + dispatcher tests (Step 19).
 *
 * Proves the queue-first durable contract, database-layer dedup, the claim /
 * settle state machine executed by the dispatcher (including bounded
 * deterministic retries and terminal finalization), CAS conflict refusal,
 * and facility-scoped reads — driven through the in-memory outbox twin so the
 * app-layer behavior is proven before the PostgreSQL proofs.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { NotificationDispatcher } from '../../../src/app/notifications/dispatcher';
import {
  NotificationService,
  type NotificationDeliveryAttempt,
  type NotificationEvent,
  type NotificationIntent,
} from '../../../src/app/notifications/notification-service';
import {
  InMemoryNotificationAdapter,
  InMemoryNotificationOutbox,
  type AuditLogPort,
} from '../../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import type { ApplicationSession } from '../../../src/app/context';
import { createFixture, sessionFor, T0, OTHER_FACILITY } from '../helpers';
import type { FacilityDirectory } from '../../../src/app/ports';

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

interface OutboxHarness {
  readonly outbox: InMemoryNotificationOutbox;
  readonly service: NotificationService;
  readonly dispatcher: NotificationDispatcher;
  readonly adapter: InMemoryNotificationAdapter;
  readonly audit: AuditLogPort;
  readonly session: ApplicationSession;
  readonly clock: { ms: number };
  advance(ms: number): void;
}

function harness(
  roles: readonly string[] = ['viewer', 'operator', 'manager'],
): OutboxHarness {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const clock = { ms: Date.parse(T0) };
  const clockIso = () => new Date(clock.ms).toISOString();
  const adapter = new InMemoryNotificationAdapter(clockIso);
  const outbox = new InMemoryNotificationOutbox();
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const service = new NotificationService({
    adapters: [adapter],
    outbox,
    facilities,
    audit: fixture.audit,
    authz,
  });
  const dispatcher = new NotificationDispatcher({
    outbox,
    adapters: [adapter],
    audit: fixture.audit,
    now: () => clock.ms,
  });
  return {
    outbox,
    service,
    dispatcher,
    adapter,
    audit: fixture.audit,
    session: withRoles(sessionFor(), roles),
    clock,
    advance: (ms) => {
      clock.ms += ms;
    },
  };
}

function makeEvent(
  overrides: Partial<NotificationEvent> & { type?: NotificationEvent['type'] } = {},
): NotificationEvent {
  return {
    eventId: randomUUID(),
    type: 'order.created',
    schemaVersion: '1',
    aggregateType: 'diagnostic-order',
    aggregateId: '00000000-0000-4000-8000-0000000000a1',
    organizationId: '00000000-0000-4000-8000-000000000001',
    facilityId: String(sessionFor().facilityId),
    correlationId: 'corr-outbox-001',
    occurredAt: new Date(Date.parse(T0)).toISOString(),
    sourceKind: 'SYSTEM',
    sourceLabel: 'notification:order.created',
    metadata: { orderStatus: 'ORDERED' },
    ...overrides,
  } as NotificationEvent;
}

function eventKeyOf(event: NotificationEvent): string {
  return `notification:${event.type}:${event.facilityId}:${event.aggregateId}:${event.correlationId}`;
}

async function enqueueOne(
  h: OutboxHarness,
  overrides: Partial<NotificationEvent> & { type?: NotificationEvent['type'] } = {},
): Promise<NotificationIntent> {
  const event = makeEvent(overrides);
  const { intents } = await h.outbox.enqueue({
    event,
    eventKey: eventKeyOf(event),
    intents: [{ channel: 'IN_MEMORY' }],
    now: new Date(h.clock.ms).toISOString(),
  });
  const intent = intents[0];
  if (!intent) throw new Error('expected one enqueued intent');
  return intent;
}

async function attemptsOf(
  h: OutboxHarness,
  intent: NotificationIntent,
): Promise<NotificationDeliveryAttempt[]> {
  return [...(await h.outbox.listAttempts(intent.facilityId, intent.id))];
}

describe('notification outbox: durable queue-first contract', () => {
  it('persists an event and one PENDING intent per registered channel', async () => {
    const h = harness();
    const intent = await enqueueOne(h);

    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.attemptCount, 0);
    assert.equal(intent.maxAttempts, 5);
    assert.equal(intent.priority, 'ROUTINE');
    assert.equal(intent.recipientScope, 'facility:staff');
    assert.equal(intent.facilityId, String(sessionFor().facilityId));

    const event = await h.outbox.findEvent(intent.facilityId, intent.eventId);
    assert.ok(event);
    assert.equal(event.eventId, intent.eventId);
    assert.deepEqual(event.metadata, { orderStatus: 'ORDERED' });
    assert.deepEqual(await attemptsOf(h, intent), []);
  });

  it('dedups a replay by event key and by (event, channel) at the store layer', async () => {
    const h = harness();
    const event = makeEvent();
    const first = await h.outbox.enqueue({
      event,
      eventKey: eventKeyOf(event),
      intents: [{ channel: 'IN_MEMORY' }],
      now: new Date(h.clock.ms).toISOString(),
    });
    const second = await h.outbox.enqueue({
      event: makeEvent({ eventId: randomUUID() }),
      eventKey: eventKeyOf(event),
      intents: [{ channel: 'IN_MEMORY' }],
      now: new Date(h.clock.ms).toISOString(),
    });
    assert.equal(first.event.eventId, second.event.eventId);
    assert.equal(first.intents[0]?.id, second.intents[0]?.id);
    const page = await h.outbox.listByFacility(String(sessionFor().facilityId), {
      limit: 50,
    });
    assert.equal(page.items.length, 1);
  });

  it('claims due intents exactly once across racing workers', async () => {
    const h = harness();
    for (let i = 0; i < 3; i += 1) {
      await enqueueOne(h, { aggregateId: `00000000-0000-4000-8000-${String(1000 + i)}` });
    }
    const facility = String(sessionFor().facilityId);
    const [first, second] = await Promise.all([
      h.outbox.claimDue(facility, { limit: 25, leaseMs: 300_000, now: h.clock.ms }),
      h.outbox.claimDue(facility, { limit: 25, leaseMs: 300_000, now: h.clock.ms }),
    ]);
    assert.equal(first.length + second.length, 3);
    const claimedIds = new Set([...first, ...second].map((i) => i.id));
    assert.equal(claimedIds.size, 3, 'no intent may be claimed twice');
    for (const intent of first) assert.equal(intent.status, 'PROCESSING');
    // A follow-up claim sees nothing left (batch fully claimed).
    const again = await h.outbox.claimDue(facility, {
      limit: 25,
      leaseMs: 300_000,
      now: h.clock.ms,
    });
    assert.equal(again.length, 0);
  });

  it('settles only from the expected state (CAS) and refuses stale writes', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    const attempt: NotificationDeliveryAttempt = {
      id: randomUUID(),
      intentId: intent.id,
      attemptNumber: 1,
      attemptedAt: new Date(h.clock.ms).toISOString(),
      outcome: 'SUCCESS',
    };
    const ok = await h.outbox.settle({
      intentId: intent.id,
      expectedStatus: 'PENDING',
      toStatus: 'DELIVERED',
      attempt,
    });
    assert.equal(ok, true);
    // Same worker retry: the intent is DELIVERED, not PENDING → refused.
    const stale = await h.outbox.settle({
      intentId: intent.id,
      expectedStatus: 'PENDING',
      toStatus: 'DELIVERED',
      attempt,
    });
    assert.equal(stale, false);
    // A repeated worker execution (same attempt number) is refused too.
    const intentB = await enqueueOne(h, {
      aggregateId: '00000000-0000-4000-8000-0000000000b2',
    });
    const attemptB: NotificationDeliveryAttempt = {
      id: randomUUID(),
      intentId: intentB.id,
      attemptNumber: 1,
      attemptedAt: new Date(h.clock.ms).toISOString(),
      outcome: 'FAILED',
      failureCategory: 'TEMPORARY_FAILURE',
    };
    await h.outbox.claimDue(intentB.facilityId, {
      limit: 25,
      leaseMs: 300_000,
      now: h.clock.ms,
    });
    assert.equal(
      await h.outbox.settle({
        intentId: intentB.id,
        expectedStatus: 'PROCESSING',
        toStatus: 'FAILED',
        attempt: attemptB,
      }),
      true,
    );
    assert.equal(
      await h.outbox.settle({
        intentId: intentB.id,
        expectedStatus: 'PROCESSING',
        toStatus: 'FAILED',
        attempt: attemptB,
      }),
      false,
      'duplicate attempt number must be refused (mirrors the UNIQUE ledger)',
    );
  });
});

describe('notification dispatcher: delivery lifecycle', () => {
  it('claims, delivers, and audits a complete success', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    const summary = await h.dispatcher.processDue(intent.facilityId);

    assert.equal(summary.claimed, 1);
    assert.equal(summary.delivered, 1);
    assert.equal(summary.retriesScheduled, 0);
    assert.equal(summary.permanentlyFailed, 0);

    const after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'DELIVERED');
    assert.equal(after?.attemptCount, 1);
    assert.ok(after?.deliveredAt);
    const ledger = await attemptsOf(h, intent);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.outcome, 'SUCCESS');
    assert.equal(h.adapter.getDelivered().length, 1);
    assert.equal(
      h.audit
        .list()
        .filter((e) => e.objectId === intent.id && e.action === 'TRANSITIONED').length,
      1,
    );
  });

  it('schedules deterministic bounded retries for transient failures, then recovers', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    h.adapter.programFailure(intent.eventType, 'FAILED');

    const failed = await h.dispatcher.processDue(intent.facilityId);
    assert.equal(failed.retriesScheduled, 1);
    let after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'RETRYING');
    assert.equal(after?.attemptCount, 1);
    assert.ok(after?.nextAttemptAt);
    // 1s backoff after attempt 1.
    assert.equal(
      Date.parse(after?.nextAttemptAt ?? '') - Date.parse(after?.lastAttemptAt ?? ''),
      1_000,
    );

    // Not yet due → nothing is claimed.
    const notDue = await h.dispatcher.processDue(intent.facilityId);
    assert.equal(notDue.claimed, 0);

    // Advance past the retry window and swap in a healthy adapter.
    h.advance(1_001);
    const healthy = new InMemoryNotificationAdapter(() =>
      new Date(h.clock.ms).toISOString(),
    );
    const restarted = new NotificationDispatcher({
      outbox: h.outbox,
      adapters: [healthy],
      audit: h.audit,
      now: () => h.clock.ms,
    });
    const recovered = await restarted.processDue(intent.facilityId);
    assert.equal(recovered.delivered, 1);

    after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'DELIVERED');
    assert.equal(after?.attemptCount, 2);
    const ledger = await attemptsOf(h, intent);
    assert.equal(ledger.length, 2);
    assert.equal(ledger[0]?.outcome, 'FAILED');
    assert.equal(ledger[1]?.outcome, 'SUCCESS');
  });

  it('finalizes permanents on the first attempt (no retry for rejected destinations)', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    h.adapter.programFailure(intent.eventType, 'REJECTED');

    const summary = await h.dispatcher.processDue(intent.facilityId);
    assert.equal(summary.permanentlyFailed, 1);
    assert.equal(summary.retriesScheduled, 0);

    const after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'PERMANENTLY_FAILED');
    assert.equal(after?.attemptCount, 1);
    assert.equal(after?.failureReason, 'destination rejected by channel');
    const ledger = await attemptsOf(h, intent);
    assert.equal(ledger[0]?.failureCategory, 'INVALID_DESTINATION');
    // Terminal → never claimable again.
    assert.equal(
      (
        await h.outbox.claimDue(intent.facilityId, {
          limit: 25,
          leaseMs: 300_000,
          now: h.clock.ms,
        })
      ).length,
      0,
    );
  });

  it('exhausts the bounded attempt budget and finalizes (no infinite loop)', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    h.adapter.programFailure(intent.eventType, 'FAILED');
    for (let round = 1; round <= 4; round += 1) {
      const summary = await h.dispatcher.processDue(intent.facilityId);
      assert.equal(summary.retriesScheduled, 1, `round ${round}`);
      h.advance(30_000); // well past every deterministic backoff window
    }
    const final = await h.dispatcher.processDue(intent.facilityId);
    assert.equal(final.permanentlyFailed, 1);
    assert.equal(final.retriesScheduled, 0);

    const after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'PERMANENTLY_FAILED');
    assert.equal(after?.attemptCount, 5);
    assert.equal(after?.failureReason, 'delivery attempts exhausted');
    assert.equal((await attemptsOf(h, intent)).length, 5);
  });
});

describe('notification lifecycle: cancel and retry through the service', () => {
  it('cancels a PENDING intent; a cancelled intent is terminal', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    const cancelled = await h.service.cancelNotification(h.session, intent.id, {
      at: new Date(h.clock.ms).toISOString(),
    });
    assert.equal(cancelled.status, 'CANCELLED');
    assert.ok(cancelled.cancelledAt);
    // Terminal: never claimable, no further transitions through the service.
    assert.equal(
      (
        await h.outbox.claimDue(intent.facilityId, {
          limit: 25,
          leaseMs: 300_000,
          now: h.clock.ms,
        })
      ).length,
      0,
    );
    await assert.rejects(
      h.service.retryNotification(h.session, intent.id, {
        at: new Date(h.clock.ms).toISOString(),
      }),
      /cannot be retried/i,
    );
  });

  it('re-queues a failed intent for immediate delivery (bounded budget respected)', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    h.adapter.programFailure(intent.eventType, 'FAILED');
    await h.dispatcher.processDue(intent.facilityId);
    h.advance(1_001);

    const requeued = await h.service.retryNotification(h.session, intent.id, {
      at: new Date(h.clock.ms).toISOString(),
    });
    assert.equal(requeued.status, 'PENDING');
    assert.equal(requeued.nextAttemptAt, undefined);

    // The healthy adapter now completes the re-queued delivery.
    const healthy = new InMemoryNotificationAdapter(() =>
      new Date(h.clock.ms).toISOString(),
    );
    const restarted = new NotificationDispatcher({
      outbox: h.outbox,
      adapters: [healthy],
      audit: h.audit,
      now: () => h.clock.ms,
    });
    const summary = await restarted.processDue(intent.facilityId);
    assert.equal(summary.delivered, 1);
    const after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'DELIVERED');
  });

  it('refuses retry once the attempt budget is exhausted (bounded)', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    h.adapter.programFailure(intent.eventType, 'FAILED');
    for (let round = 0; round < 4; round += 1) {
      await h.dispatcher.processDue(intent.facilityId);
      h.advance(30_000); // well past every deterministic backoff window
    }
    await h.dispatcher.processDue(intent.facilityId); // attempt 5 → permanent
    const after = await h.outbox.findById(intent.facilityId, intent.id);
    assert.equal(after?.status, 'PERMANENTLY_FAILED');
    await assert.rejects(
      h.service.retryNotification(h.session, intent.id, {
        at: new Date(h.clock.ms).toISOString(),
      }),
      /exhausted|cannot be retried/i,
    );
  });
});

describe('notification outbox: facility scope', () => {
  it('keeps every read facility-scoped (cross-facility reads return nothing)', async () => {
    const h = harness();
    const intent = await enqueueOne(h);
    const other = String(OTHER_FACILITY);
    assert.equal(await h.outbox.findById(other, intent.id), undefined);
    assert.equal(await h.outbox.findEvent(other, intent.eventId), undefined);
    assert.deepEqual(await h.outbox.listAttempts(other, intent.id), []);
    const page = await h.outbox.listByFacility(other, { limit: 50 });
    assert.equal(page.items.length, 0);
    // Own facility still sees it.
    assert.ok(await h.outbox.findById(intent.facilityId, intent.id));
  });
});

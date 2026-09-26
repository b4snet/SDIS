/**
 * Notifications & event delivery application tests (Step 19).
 *
 * Proves the event model, publisher fan-out, deterministic adapter
 * success/rejection/failure, RBAC gating, tenant/facility scope isolation,
 * duplicate-emission behavior, and audit emission — with synthetic data on
 * in-memory adapters only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { NotificationService } from '../../../src/app/notifications/notification-service';
import {
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  idempotentDeliveryIdentity,
} from '../../../src/app/notifications/notification-service';
import {
  InMemoryNotificationAdapter,
  InMemoryIdempotencyStore,
  type AuditLogPort,
} from '../../../src/app/in-memory';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import type { ApplicationSession } from '../../../src/app/context';
import { createFixture, sessionFor, at, OTHER_FACILITY, OTHER_ORG } from '../helpers';
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
  readonly audit: AuditLogPort;
  readonly session: ApplicationSession;
}

function harness(roles: readonly string[] = ['viewer', 'operator', 'manager']): Harness {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const adapter = new InMemoryNotificationAdapter();
  const service = new NotificationService({
    adapters: [adapter],
    facilities,
    audit: fixture.audit,
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  return {
    service,
    adapter,
    audit: fixture.audit as AuditLogPort,
    session: withRoles(sessionFor(), roles),
  };
}

const BASE_EMIT = {
  type: 'order.created' as const,
  aggregateId: '00000000-0000-4000-8000-0000000000a1',
  correlationId: 'corr-19-001',
  metadata: { orderStatus: 'ORDERED', modality: 'LAB' },
};

describe('notifications: event model and publisher', () => {
  it('creates a scoped, schema-versioned event and delivers it to the channel', async () => {
    const h = harness();
    const { event, receipts } = await h.service.emit(h.session, BASE_EMIT);

    assert.ok(event.eventId);
    assert.equal(event.type, 'order.created');
    assert.equal(event.schemaVersion, NOTIFICATION_EVENT_SCHEMA_VERSION);
    assert.equal(event.aggregateType, 'diagnostic-order');
    assert.equal(event.organizationId, h.session.organizationId);
    assert.equal(event.facilityId, h.session.facilityId);
    assert.equal(event.correlationId, 'corr-19-001');
    assert.equal(event.sourceKind, 'SYSTEM');
    assert.deepEqual(Object.keys(event.metadata).sort(), ['modality', 'orderStatus']);

    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, 'DELIVERED');
    assert.equal(receipts[0]?.channel, 'IN_MEMORY');
    assert.equal(receipts[0]?.eventId, event.eventId);
    assert.equal(h.adapter.countDeliveredOfType('order.created'), 1);
  });

  it('rejects metadata that could carry clinical payloads', async () => {
    const h = harness();
    await assert.rejects(
      h.service.emit(h.session, {
        ...BASE_EMIT,
        metadata: { reportText: 'x'.repeat(201) },
      }),
      /bounded/i,
    );
    assert.equal(h.adapter.getDelivered().length, 0);
  });

  it('rejects unsupported event types', async () => {
    const h = harness();
    await assert.rejects(
      h.service.emit(h.session, {
        ...BASE_EMIT,
        type: 'patient.visit_started' as never,
      }),
      /unsupported notification event type/i,
    );
    assert.equal(h.adapter.getDelivered().length, 0);
  });

  it('records deterministic adapter rejection and failure receipts', async () => {
    const h = harness();
    h.adapter.programFailure('order.created', 'REJECTED');
    const rejected = await h.service.emit(h.session, BASE_EMIT);
    assert.equal(rejected.receipts[0]?.status, 'REJECTED');
    assert.equal(rejected.receipts[0]?.failureCategory, 'INVALID_DESTINATION');

    h.adapter.programFailure('order.created', 'FAILED');
    const failed = await h.service.emit(h.session, {
      ...BASE_EMIT,
      aggregateId: '00000000-0000-4000-8000-0000000000a2',
    });
    assert.equal(failed.receipts[0]?.status, 'FAILED');
    assert.equal(failed.receipts[0]?.failureCategory, 'TEMPORARY_FAILURE');

    // Emitting with a failing adapter did NOT throw — the producer is shielded.
    assert.equal(h.service instanceof NotificationService, true);
  });

  it('generates distinct event ids for repeated emissions (no silent dedup)', async () => {
    const h = harness();
    const first = await h.service.emit(h.session, BASE_EMIT);
    const second = await h.service.emit(h.session, BASE_EMIT);
    assert.notEqual(first.event.eventId, second.event.eventId);
    // Both deliveries are recorded (the delivery log is the read model).
    const r1 = await h.service.getDelivery(h.session, first.event.eventId);
    const r2 = await h.service.getDelivery(h.session, second.event.eventId);
    assert.equal(r1.length, 1);
    assert.equal(r2.length, 1);
  });

  it('exposes a deterministic delivery identity for the existing idempotency engine', async () => {
    const h = harness();
    const { event } = await h.service.emit(h.session, BASE_EMIT);
    const identity = idempotentDeliveryIdentity(event.eventId, 'IN_MEMORY', 1);
    assert.equal(identity, `notification.delivery:${event.eventId}:IN_MEMORY:1`);
    const store = new InMemoryIdempotencyStore();
    await store.put(identity, { seen: true });
    assert.deepEqual(await store.get(identity), { seen: true });
  });
});

describe('notifications: security and scope', () => {
  it('denies emission without the event capability (unauthorized role)', async () => {
    const h = harness();
    // Empty role set → fail-closed denial by the Step-11 engine.
    await assert.rejects(
      h.service.emit(withRoles(sessionFor(), []), BASE_EMIT),
      /forbidden|permission/i,
    );
    assert.equal(h.adapter.getDelivered().length, 0);
  });

  it('keeps delivery receipts tenant- and facility-scoped', async () => {
    const h = harness();
    const { event } = await h.service.emit(h.session, BASE_EMIT);

    // Same facility: readable.
    const own = await h.service.getDelivery(h.session, event.eventId);
    assert.equal(own.length, 1);

    // Other facility (same org): rejected.
    await assert.rejects(
      h.service.getDelivery(
        withRoles(sessionFor(OTHER_FACILITY), ['manager']),
        event.eventId,
      ),
      /scope/i,
    );

    // Other org: rejected.
    await assert.rejects(
      h.service.getDelivery(
        withRoles(sessionFor(OTHER_FACILITY, OTHER_ORG), ['manager']),
        event.eventId,
      ),
      /scope/i,
    );

    // Unknown event: not found (no cross-scope probing oracle).
    await assert.rejects(
      h.service.getDelivery(h.session, '00000000-0000-4000-8000-00000000dead'),
      /not found/i,
    );
  });

  it('records notification deliveries through the existing audit system', async () => {
    const h = harness();
    const { event } = await h.service.emit(h.session, BASE_EMIT);
    await h.service.recordNotificationAudit(h.session, {
      objectType: 'notification-delivery',
      objectId: event.eventId,
      at: event.occurredAt,
      detail: 'in-memory channel delivery',
    });
    const events = h.audit.list();
    const audited = events.filter(
      (entry) =>
        entry.objectId === event.eventId && entry.objectType === 'notification-delivery',
    );
    assert.equal(audited.length, 1);
  });

  it('end-to-end: emitting an order event never changes authoritative order state', async () => {
    // One REAL workflow: order creation → event emission → channel delivery,
    // proving the notification path is a downstream consumer that does not
    // mutate the authoritative clinical record.
    const fixture = createFixture();
    const facilities = (
      fixture.orders as unknown as {
        deps: { facilities: FacilityDirectory };
      }
    ).deps.facilities;
    const adapter = new InMemoryNotificationAdapter();
    const notifications = new NotificationService({
      adapters: [adapter],
      facilities,
      audit: fixture.audit,
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const session = withRoles(sessionFor(), ['manager', 'operator', 'viewer']);

    const created = await fixture.orders.createOrder(session, {
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(1),
      idempotencyKey: 'notif-e2e-order-001',
    });

    const { event, receipts } = await notifications.emit(session, {
      type: 'order.created',
      aggregateId: created.id,
      correlationId: 'corr-19-e2e',
      metadata: { orderStatus: created.status },
    });

    assert.equal(receipts[0]?.status, 'DELIVERED');
    assert.equal(adapter.countDeliveredOfType('order.created'), 1);
    assert.equal(event.aggregateId, created.id);

    // Authoritative state is unchanged by emission.
    const after = await fixture.orders.getOrder(session, created.id as never);
    assert.equal(after.status, created.status);
    assert.equal(after.items.length, created.items.length);
  });
});

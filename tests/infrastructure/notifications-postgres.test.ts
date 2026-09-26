/**
 * Step 19 — durable notifications & event delivery over PostgreSQL.
 *
 * Proves migration 026 on the REAL database: schema + RLS posture + grants,
 * atomic enqueue (rollback on constraint violation), database-layer
 * idempotency (event_key / event+channel / attempt_number), facility/tenant
 * isolation under the tenant-scope seam (fail-closed), keyset pagination,
 * lease recovery for crashed PROCESSING rows, the bounded deterministic retry
 * lifecycle executed by the dispatcher (including concurrent-claim
 * single-winner behavior), terminal finalization on attempt exhaustion, and
 * the audit trail — plus the durable emit/read path through the runtime.
 *
 * Runs on a disposable embedded PostgreSQL (migrations + dev seed).
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { Database } from '../../src/infrastructure/database/database';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { PostgresNotificationOutbox } from '../../src/infrastructure/database/notification-repository';
import { PostgresAuditPort } from '../../src/infrastructure/database/repositories';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';
import { NotificationDispatcher } from '../../src/app/notifications/dispatcher';
import { InMemoryNotificationAdapter } from '../../src/app/in-memory';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId } from '../../src/types/ids';
import type { OrganizationId, FacilityId } from '../../src/types/ids';
import type { NotificationEvent } from '../../src/app/notifications/notification-service';
import { sessionFor } from '../app/helpers';

const PORT = 55451;
const ORG_A: OrganizationId = toBrandedId('00000000-0000-4000-8000-000000000001');
// ORG_B exists as an id but has no seeded rows — cross-tenant reads return nothing.
const ORG_B: OrganizationId = toBrandedId('00000000-0000-4000-8000-000000000009');
const FACILITY_A1: FacilityId = toBrandedId('00000000-0000-4000-8000-000000000011');
const FACILITY_A2: FacilityId = toBrandedId('00000000-0000-4000-8000-000000000012');
// ORG_B owns no SEEDED facilities, so B1 is a valid-but-unseeded tenant id.
// A scope of {ORG_B, FACILITY_B1} is therefore a REAL foreign-tenant session
// whose facility policy can never match org-A rows (see the isolation test).
const FACILITY_B1: FacilityId = toBrandedId('00000000-0000-4000-8000-000000000019');
const START = '2026-09-20T08:00:00.000Z';

function plusMinutes(base: string, minutes: number): string {
  return new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

let db: Database;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
});

// Every notification test starts from a clean slate (disposable test DB), so
// cross-test leftovers can never contaminate counts, pagination, or claims.
beforeEach(async () => {
  await db.query('DELETE FROM sdis.notification_delivery_attempts');
  await db.query('DELETE FROM sdis.notification_intents');
  await db.query('DELETE FROM sdis.notification_events');
});

after(async () => {
  await teardownTestDatabase();
});

function makeEvent(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    eventId: randomUUID(),
    type: 'order.created',
    schemaVersion: '1',
    aggregateType: 'diagnostic-order',
    aggregateId: '00000000-0000-4000-8000-0000000000a1',
    organizationId: ORG_A,
    facilityId: FACILITY_A1,
    correlationId: randomUUID(),
    occurredAt: START,
    sourceKind: 'SYSTEM',
    sourceLabel: 'notification:order.created',
    metadata: { orderStatus: 'ORDERED' },
    ...overrides,
  } as NotificationEvent;
}

async function enqueuePending(
  outbox: PostgresNotificationOutbox,
  key: string,
  occurredAt: string,
): Promise<{ event: NotificationEvent; intentId: string }> {
  const event = makeEvent({ correlationId: key, occurredAt });
  const { intents } = await outbox.enqueue({
    event,
    eventKey: `notification:${event.type}:${event.facilityId}:${event.aggregateId}:${event.correlationId}`,
    intents: [{ channel: 'IN_MEMORY' }],
    now: occurredAt,
  });
  const intent = intents[0];
  if (!intent) throw new Error('expected one enqueued intent');
  return { event, intentId: String(intent.id) };
}

async function tablePrivilege(tableName: string, privilege: string): Promise<boolean> {
  const result = await db.query<{ granted: boolean }>(
    `SELECT has_table_privilege('sdis_app', 'sdis.${tableName}', $1) AS granted`,
    [privilege],
  );
  return result.rows[0]?.granted ?? false;
}

interface IntentRow {
  status: string;
  attempt_count: number;
  last_attempt_at: unknown;
  next_attempt_at: unknown;
  failure_reason: string | null;
}

async function outboxRow(intentId: string): Promise<IntentRow> {
  const result = await db.query<IntentRow>(
    `SELECT status, attempt_count, last_attempt_at, next_attempt_at, failure_reason
       FROM sdis.notification_intents WHERE id = $1`,
    [intentId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`intent row not found for ${intentId}`);
  return row;
}

async function attemptCount(intentId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM sdis.notification_delivery_attempts WHERE intent_id = $1`,
    [intentId],
  );
  return result.rows[0]?.n ?? 0;
}

describe('notifications postgres: schema, RLS posture, grants', () => {
  it('applies the Step-19 tables with ENFORCED row-level security (fail-closed)', async () => {
    const tables = await db.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity
         FROM pg_class
        WHERE relname IN
              ('notification_events','notification_intents','notification_delivery_attempts')
          AND relkind = 'r'
        ORDER BY relname`,
    );
    assert.equal(tables.rows.length, 3);
    for (const row of tables.rows) {
      assert.equal(row.relrowsecurity, true, `${row.relname} RLS enabled`);
      assert.equal(row.relforcerowsecurity, true, `${row.relname} RLS FORCEd`);
    }
    // Bounded vocabularies and the attempt-budget ceiling are CHECK-enforced
    // at the SQL layer (no free-text state, no unbounded retries).
    const checks = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid IN
              ('sdis.notification_events'::regclass,
               'sdis.notification_intents'::regclass,
               'sdis.notification_delivery_attempts'::regclass)
        ORDER BY conname`,
    );
    const names = checks.rows.map((r) => r.conname);
    for (const expected of [
      'notification_events_event_type_check',
      'notification_events_schema_version_check',
      'notification_intents_channel_check',
      'notification_intents_status_check',
      'notification_intents_priority_check',
      'notification_delivery_attempts_outcome_check',
      'ck_notification_intent_attempt_bounds',
      'uq_notification_events_key',
      'uq_notification_intents_event_channel',
      'uq_notification_attempts_intent_number',
    ]) {
      assert.ok(names.includes(expected), `expected constraint ${expected}`);
    }
    // The vocabulary CHECK really rejects out-of-bounds channel values.
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO sdis.notification_intents
             (id, event_id, event_type, correlation_id, channel, status,
              priority, recipient_scope, attempt_count, max_attempts,
              organization_id, facility_id)
           VALUES (gen_random_uuid(), $1, 'order.created', 'x', 'PAGER',
                   'PENDING', 'ROUTINE', 'facility:staff', 0, 5, $2, $3)
           ON CONFLICT DO NOTHING`,
          [
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000011',
          ],
        ),
      /channel|check_violation/i,
    );
  });

  it('grants append + lifecycle UPDATE to sdis_app and never DELETE', async () => {
    const tables = [
      'notification_events',
      'notification_intents',
      'notification_delivery_attempts',
    ];
    for (const tableName of tables) {
      assert.equal(
        await tablePrivilege(tableName, 'SELECT'),
        true,
        `${tableName} SELECT`,
      );
      assert.equal(
        await tablePrivilege(tableName, 'INSERT'),
        true,
        `${tableName} INSERT`,
      );
      assert.equal(
        await tablePrivilege(tableName, 'UPDATE'),
        true,
        `${tableName} UPDATE`,
      );
      assert.equal(
        await tablePrivilege(tableName, 'DELETE'),
        false,
        `${tableName} DELETE`,
      );
    }
  });
});

describe('notifications postgres: durable enqueue + idempotency', () => {
  it('enqueues an event + PENDING intent atomically with bounded defaults', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const result = await enqueuePending(outbox, 'pg-enqueue-001', START);
    const intent = await outbox.findById(String(FACILITY_A1), result.intentId);
    assert.ok(intent);
    assert.equal(intent.status, 'PENDING');
    assert.equal(intent.attemptCount, 0);
    assert.equal(intent.maxAttempts, 5);
    assert.equal(intent.priority, 'ROUTINE');
    assert.equal(intent.recipientScope, 'facility:staff');
    assert.equal(intent.facilityId, String(FACILITY_A1));
    const event = await outbox.findEvent(String(FACILITY_A1), result.event.eventId);
    assert.ok(event);
    assert.deepEqual(event.metadata, { orderStatus: 'ORDERED' });
    // AC-15: the explicit schema version survives creation → persistence →
    // retrieval; AC-01: correlation metadata is preserved on the way back out.
    assert.equal(event.schemaVersion, '1');
    assert.equal(event.correlationId, 'pg-enqueue-001');
    assert.equal(event.aggregateId, '00000000-0000-4000-8000-0000000000a1');
  });

  it('rolls the whole enqueue back when any intent violates a bound (atomicity)', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const event = makeEvent({ correlationId: 'pg-atomic-001', occurredAt: START });
    const key = `notification:atomic:rollback:${event.correlationId}`;
    await assert.rejects(
      () =>
        outbox.enqueue({
          event,
          eventKey: key,
          intents: [{ channel: 'PAGER' as never }],
          now: START,
        }),
      /channel|CHECK/i,
    );
    // The event insert inside the same transaction must be rolled back too.
    const leftover = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.notification_events WHERE event_key = $1`,
      [key],
    );
    assert.equal(
      leftover.rows[0]?.n,
      0,
      'no partial event may survive the failed enqueue',
    );
  });

  it('dedups replays by event key and by (event, channel) at the store', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const event = makeEvent({ correlationId: 'pg-dedup-001', occurredAt: START });
    const key = `notification:${event.type}:${event.facilityId}:${event.aggregateId}:${event.correlationId}`;
    const first = await outbox.enqueue({
      event,
      eventKey: key,
      intents: [{ channel: 'IN_MEMORY' }],
      now: START,
    });
    const replay = await outbox.enqueue({
      event: makeEvent({ correlationId: 'pg-dedup-001', occurredAt: START }),
      eventKey: key,
      intents: [{ channel: 'IN_MEMORY' }],
      now: START,
    });
    assert.equal(first.event.eventId, replay.event.eventId, 'event_key dedup');
    assert.equal(
      String(first.intents[0]?.id),
      String(replay.intents[0]?.id),
      '(event,channel) dedup',
    );
    const rows = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.notification_intents WHERE event_id = $1`,
      [first.event.eventId],
    );
    assert.equal(rows.rows[0]?.n, 1);
  });

  it('resolves concurrent duplicate submissions of one logical event (AC-04)', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const key = 'notification:concurrent:dup:001';
    const submissions = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        outbox.enqueue({
          event: makeEvent({ correlationId: `concurrent-dup-${i}`, occurredAt: START }),
          eventKey: key,
          intents: [{ channel: 'IN_MEMORY' }],
          now: START,
        }),
      ),
    );
    const canonical = submissions[0]?.event.eventId;
    assert.ok(canonical, 'first submission resolves');
    assert.equal(
      submissions.every((r) => r.event.eventId === canonical),
      true,
      'every concurrent submission resolves to ONE logical event',
    );
    const events = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.notification_events WHERE event_key = $1`,
      [key],
    );
    assert.equal(events.rows[0]?.n, 1, 'exactly one persisted event');
    const intents = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.notification_intents WHERE event_id = $1`,
      [String(canonical)],
    );
    assert.equal(intents.rows[0]?.n, 1, 'exactly one intent for (event, channel)');
  });

  it('never records one attempt number twice (worker idempotency via UNIQUE)', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const { intentId } = await enqueuePending(outbox, 'pg-wrkdup-001', START);
    const claim = await runWithTenantScope(
      { organizationId: ORG_A, facilityId: FACILITY_A1 },
      () =>
        outbox.claimDue(String(FACILITY_A1), {
          limit: 25,
          leaseMs: 300_000,
          now: Date.parse(START),
        }),
    );
    assert.equal(claim.length, 1);
    const attempt = {
      id: randomUUID(),
      intentId: intentId as never,
      attemptNumber: 1,
      attemptedAt: START,
      outcome: 'SUCCESS' as const,
    };
    const ok = await runWithTenantScope(
      { organizationId: ORG_A, facilityId: FACILITY_A1 },
      () =>
        outbox.settle({
          intentId: intentId as never,
          expectedStatus: 'PROCESSING',
          toStatus: 'DELIVERED',
          attempt,
        }),
    );
    assert.equal(ok, true);
    const retried = await runWithTenantScope(
      { organizationId: ORG_A, facilityId: FACILITY_A1 },
      () =>
        outbox.settle({
          intentId: intentId as never,
          expectedStatus: 'PROCESSING',
          toStatus: 'DELIVERED',
          attempt,
        }),
    );
    assert.equal(retried, false, 'duplicate worker execution must be refused');
    assert.equal(await attemptCount(intentId), 1);
  });

  it('paginates intents newest-first with a keyset cursor and no duplicates', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    for (let i = 1; i <= 3; i += 1) {
      await enqueuePending(outbox, `pg-page-00${i}`, plusMinutes(START, i));
    }
    const page1 = await outbox.listByFacility(String(FACILITY_A1), { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await outbox.listByFacility(String(FACILITY_A1), {
      cursor: page1.nextCursor ?? undefined,
      limit: 2,
    });
    assert.equal(page2.items.length, 1);
    assert.equal(page2.nextCursor, null);
    const seen = new Set([...page1.items, ...page2.items].map((i) => String(i.id)));
    assert.equal(seen.size, 3, 'keyset pages must never duplicate items');
  });
});

describe('notifications postgres: tenant/facility isolation (fail-closed)', () => {
  it('fails closed cross-tenant (and on writes) under the scope seam', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const { event } = await enqueuePending(outbox, 'pg-isolation-001', START); // org A, facility A1

    // Policy model (023 pattern, permissive + fail-closed by valid pairs):
    //   tenant policy:   organization_id = current_organization_id()
    //   facility policy: facility_id     = current_facility_id()
    // A session resolves to a VALID org↔facility pair, so a foreign tenant
    // (org B + its own facility B1) satisfies neither policy and sees ZERO
    // notification rows (RLS-01 fail-closed).
    const foreignTenant = await runWithTenantScope(
      { organizationId: ORG_B, facilityId: FACILITY_B1 },
      () =>
        db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM sdis.notification_intents`,
        ),
    );
    assert.equal(foreignTenant.rows[0]?.n, 0, 'cross-tenant read must hide rows');

    // Own scope: rows of the tenant are visible (permissive org policy);
    // facility isolation at same-org level is defense-in-depth via the
    // explicit facility_id filters on every repository statement (proven at
    // the app layer by the service scoping test in this file).
    const ownScope = await runWithTenantScope(
      { organizationId: ORG_A, facilityId: FACILITY_A1 },
      () =>
        db.query<{ n: number }>(
          `SELECT COUNT(*)::int AS n FROM sdis.notification_intents`,
        ),
    );
    assert.equal(ownScope.rows[0]?.n, 1, 'own scope sees its own rows');

    // Writes are fail-closed at the tenant layer: a foreign-tenant session
    // cannot insert an org-A intent even though the event row exists (both
    // WITH CHECK policies fail → row-level security violation).
    await assert.rejects(
      () =>
        runWithTenantScope({ organizationId: ORG_B, facilityId: FACILITY_B1 }, () =>
          db.query(
            `INSERT INTO sdis.notification_intents
               (id, event_id, event_type, correlation_id, channel, status,
                priority, recipient_scope, attempt_count, max_attempts,
                organization_id, facility_id)
             VALUES (gen_random_uuid(), $1, 'order.created', 'x', 'IN_MEMORY',
                     'PENDING', 'ROUTINE', 'facility:staff', 0, 5,
                     '00000000-0000-4000-8000-000000000001',
                     '00000000-0000-4000-8000-000000000011')`,
            [event.eventId],
          ),
        ),
      /row-level security|permission denied/i,
    );
  });

  it('scopes the service read model to the session facility', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const session = withRoles(sessionFor(), ['viewer']);
    const { event } = await runtime.notifications.emit(session, {
      type: 'order.created',
      aggregateId: '00000000-0000-4000-8000-0000000000a1',
      correlationId: 'pg-service-001',
      occurredAt: START,
    });
    const page = await runtime.notifications.listNotifications(session, { limit: 10 });
    const item = page.items.find((i) => i.eventId === event.eventId);
    assert.ok(item, 'durably enqueued + delivered intent is readable');
    assert.equal(item.status, 'DELIVERED');
    const detail = await runtime.notifications.getNotification(session, item.id as never);
    assert.equal(detail.attempts[0]?.outcome, 'SUCCESS');

    // Same organization, other facility → invisible (and detail is not found).
    const foreign = withRoles(sessionFor(FACILITY_A2), ['viewer']);
    const foreignPage = await runtime.notifications.listNotifications(foreign, {
      limit: 10,
    });
    assert.equal(foreignPage.items.length, 0);
    await assert.rejects(
      () => runtime.notifications.getNotification(foreign, item.id as never),
      /not found/i,
    );
  });
});

describe('notifications postgres: dispatcher lifecycle', () => {
  it('claims exactly once across racing workers and delivers every intent', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const audit = new PostgresAuditPort(db);
    for (let i = 1; i <= 10; i += 1) {
      await enqueuePending(
        outbox,
        `pg-race-${String(i).padStart(2, '0')}`,
        plusMinutes(START, i),
      );
    }
    const workerA = new NotificationDispatcher({
      outbox,
      adapters: [new InMemoryNotificationAdapter()],
      audit,
      now: () => Date.parse(plusMinutes(START, 11)),
    });
    const workerB = new NotificationDispatcher({
      outbox,
      adapters: [new InMemoryNotificationAdapter()],
      audit,
      now: () => Date.parse(plusMinutes(START, 11)),
    });
    const workerC = new NotificationDispatcher({
      outbox,
      adapters: [new InMemoryNotificationAdapter()],
      audit,
      now: () => Date.parse(plusMinutes(START, 11)),
    });
    const workerD = new NotificationDispatcher({
      outbox,
      adapters: [new InMemoryNotificationAdapter()],
      audit,
      now: () => Date.parse(plusMinutes(START, 11)),
    });
    const scope = { organizationId: ORG_A, facilityId: FACILITY_A1 };
    const results = await runWithTenantScope(scope, () =>
      Promise.all([
        workerA.processDue(String(FACILITY_A1)),
        workerB.processDue(String(FACILITY_A1)),
        workerC.processDue(String(FACILITY_A1)),
        workerD.processDue(String(FACILITY_A1)),
      ]),
    );
    assert.equal(
      results.reduce((sum, r) => sum + r.claimed, 0),
      10,
      'no intent claimed twice (SKIP LOCKED disjoint claims)',
    );
    assert.equal(
      results.reduce((sum, r) => sum + r.delivered, 0),
      10,
      'every intent delivered exactly once',
    );
    assert.equal(
      results.reduce((sum, r) => sum + r.skipped, 0),
      0,
    );
    const duplicates = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n
         FROM (SELECT intent_id FROM sdis.notification_delivery_attempts
               GROUP BY intent_id HAVING COUNT(*) > 1) dup`,
    );
    assert.equal(duplicates.rows[0]?.n, 0, 'UNIQUE attempt ledger: one row per intent');
    const statuses = await db.query<{ status: string; n: number }>(
      `SELECT status, COUNT(*)::int AS n FROM sdis.notification_intents
        WHERE facility_id = $1 GROUP BY status`,
      [String(FACILITY_A1)],
    );
    assert.deepEqual(
      statuses.rows.map((r) => [r.status, r.n]),
      [['DELIVERED', 10]],
    );
  });

  it('schedules bounded deterministic retries and finalizes exhaustion (no infinite loop)', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const audit = new PostgresAuditPort(db);
    const failing = new InMemoryNotificationAdapter(() => new Date(ms).toISOString());
    failing.programFailure('order.created', 'FAILED');
    let ms = Date.parse(START);
    const dispatcher = new NotificationDispatcher({
      outbox,
      adapters: [failing],
      audit,
      now: () => ms,
    });
    const scope = { organizationId: ORG_A, facilityId: FACILITY_A1 };
    const { intentId } = await enqueuePending(outbox, 'pg-retry-001', START);

    const first = await runWithTenantScope(scope, () =>
      dispatcher.processDue(String(FACILITY_A1)),
    );
    assert.equal(first.retriesScheduled, 1);
    let row = await outboxRow(intentId);
    assert.equal(row.status, 'RETRYING');
    assert.equal(row.attempt_count, 1);
    // Deterministic 1s backoff after attempt 1.
    const backoff =
      Date.parse(String(row.next_attempt_at)) - Date.parse(String(row.last_attempt_at));
    assert.equal(backoff, 1_000);

    // Not due yet → nothing claimable.
    const notDue = await runWithTenantScope(scope, () =>
      dispatcher.processDue(String(FACILITY_A1)),
    );
    assert.equal(notDue.claimed, 0);

    // Drive attempts 2..5 (well past every backoff window) → attempt 5 exhausts.
    ms += 60_000;
    for (let round = 2; round <= 5; round += 1) {
      ms += 60_000;
      const summary = await runWithTenantScope(scope, () =>
        dispatcher.processDue(String(FACILITY_A1)),
      );
      if (round < 5) {
        assert.equal(summary.retriesScheduled, 1, `round ${round} schedules a retry`);
      } else {
        assert.equal(summary.permanentlyFailed, 1, 'round 5 finalizes');
      }
    }

    row = await outboxRow(intentId);
    assert.equal(row.status, 'PERMANENTLY_FAILED');
    assert.equal(row.attempt_count, 5);
    assert.equal(row.failure_reason, 'delivery attempts exhausted');
    assert.equal(await attemptCount(intentId), 5);
    // Terminal → nothing more claimable ever.
    const terminal = await runWithTenantScope(scope, () =>
      dispatcher.processDue(String(FACILITY_A1)),
    );
    assert.equal(terminal.claimed, 0);

    // Every delivery outcome was audited by the dispatcher (SYSTEM actor).
    const auditRows = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.audit_events
        WHERE object_id = $1 AND action = 'TRANSITIONED'`,
      [intentId],
    );
    assert.equal(auditRows.rows[0]?.n, 5);
  });

  it('re-claims crashed PROCESSING intents only after their lease expires', async () => {
    const outbox = new PostgresNotificationOutbox(db);
    const { intentId } = await enqueuePending(
      outbox,
      'pg-lease-001',
      '2026-09-20T08:00:00.000Z',
    );
    await db.query(
      `UPDATE sdis.notification_intents
          SET status = 'PROCESSING', last_attempt_at = $1
        WHERE id = $2`,
      ['2026-09-20T07:50:00.000Z', intentId],
    );
    const scope = { organizationId: ORG_A, facilityId: FACILITY_A1 };
    // 5-minute lease: last attempt at 07:50 vs now 08:05 → past lease.
    const claimed = await runWithTenantScope(scope, () =>
      outbox.claimDue(String(FACILITY_A1), {
        limit: 25,
        leaseMs: 5 * 60_000,
        now: Date.parse('2026-09-20T08:05:00.000Z'),
      }),
    );
    assert.equal(claimed.length, 1);
    assert.equal(String(claimed[0]?.id), intentId);
    assert.equal(claimed[0]?.status, 'PROCESSING');
    // A fresh PROCESSING row is NOT claimable (still within its lease).
    const { intentId: fresh } = await enqueuePending(
      outbox,
      'pg-lease-002',
      '2026-09-20T08:04:00.000Z',
    );
    await db.query(
      `UPDATE sdis.notification_intents SET status = 'PROCESSING', last_attempt_at = $1 WHERE id = $2`,
      ['2026-09-20T08:04:35.000Z', fresh],
    );
    const withinLease = await runWithTenantScope(scope, () =>
      outbox.claimDue(String(FACILITY_A1), {
        limit: 25,
        leaseMs: 5 * 60_000,
        now: Date.parse('2026-09-20T08:05:00.000Z'),
      }),
    );
    assert.equal(
      withinLease.some((i) => String(i.id) === fresh),
      false,
    );
  });
});

describe('notifications postgres: retry/cancel through the runtime', () => {
  it('re-queues FAILED intents and cancels queued intents with audit rows', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const session = withRoles(sessionFor(), ['manager', 'viewer']);
    const { event } = await runtime.notifications.emit(session, {
      type: 'order.created',
      aggregateId: '00000000-0000-4000-8000-0000000000a1',
      correlationId: 'pg-retry-svc-001',
      occurredAt: plusMinutes(START, 1),
    });
    const page = await runtime.notifications.listNotifications(session, { limit: 10 });
    const item = page.items.find((i) => i.eventId === event.eventId);
    if (!item) throw new Error('expected the delivered intent');
    // Delivered → retry/cancel are invalid transitions (409).
    await assert.rejects(
      () =>
        runtime.notifications.retryNotification(session, item.id as never, {
          at: plusMinutes(START, 2),
        }),
      /cannot be retried/i,
    );
    await assert.rejects(
      () =>
        runtime.notifications.cancelNotification(session, item.id as never, {
          at: plusMinutes(START, 2),
        }),
      /cannot be cancelled/i,
    );
    // A PENDING intent enqueued directly can be cancelled.
    const outbox = new PostgresNotificationOutbox(db);
    const scope = { organizationId: ORG_A, facilityId: FACILITY_A1 };
    const queued = await runWithTenantScope(scope, () =>
      enqueuePending(outbox, 'pg-cancel-001', plusMinutes(START, 3)),
    );
    const cancelled = await runtime.notifications.cancelNotification(
      session,
      queued.intentId as never,
      { at: plusMinutes(START, 4) },
    );
    assert.equal(cancelled.status, 'CANCELLED');
    const auditRows = await db.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM sdis.audit_events
        WHERE object_id = $1 AND action = 'CANCELLED'`,
      [queued.intentId],
    );
    assert.equal(auditRows.rows[0]?.n, 1);
    // AC-17: the audit record retains the correlation id and copies no payload.
    const auditDetail = await db.query<{ detail: string }>(
      `SELECT detail FROM sdis.audit_events
        WHERE object_id = $1 AND action = 'CANCELLED'`,
      [queued.intentId],
    );
    assert.match(
      auditDetail.rows[0]?.detail ?? '',
      /correlation=pg-cancel-001/,
      'audit retains the correlation id',
    );
    assert.ok(
      !/(metadata|orderStatus)/i.test(auditDetail.rows[0]?.detail ?? ''),
      'no payload leaked into the audit record',
    );
  });
});

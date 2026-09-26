/**
 * PostgreSQL notification outbox repository (Step 19).
 *
 * Persists events, per-channel delivery intents, and the append-only attempt
 * ledger over migrations/026. Tenant/facility isolation rides RLS (migration
 * 014 posture) driven by the established tenant-scope seam, PLUS explicit
 * `facility_id` filters on every statement (defense in depth; the same code
 * path is safe when run unscoped, e.g. service-level tooling).
 *
 * Idempotency at the database layer: duplicate event → UNIQUE (event_key);
 * duplicate queueing → UNIQUE (event_id, channel); duplicate worker execution
 * → UNIQUE (intent_id, attempt_number) + conditional claims/settles (CAS on
 * status) so concurrent dispatchers never deliver one intent twice.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from './database';
import type { Database } from './database';
import type { FacilityId, NotificationIntentId } from '../../types/ids';
import type {
  NotificationDeliveryAttempt,
  NotificationEvent,
  NotificationIntent,
  NotificationIntentInput,
  NotificationOutbox,
} from '../../app/notifications/notification-service';
import type {
  NotificationChannel,
  NotificationDeliveryStatus,
  NotificationEventType,
  NotificationPriority,
  NotificationSchemaVersion,
} from '../../domain/notifications/notification';
import { DEFAULT_MAX_ATTEMPTS } from '../../domain/notifications/notification';

const INTENT_COLUMNS = `id, event_id, event_type, correlation_id, channel, status,
    priority, recipient_scope, recipient_ref, attempt_count, max_attempts,
    last_attempt_at, next_attempt_at, delivered_at, failed_at, cancelled_at,
    failure_reason, organization_id, facility_id, created_at, updated_at`;

interface IntentRow {
  id: string;
  event_id: string;
  event_type: string;
  correlation_id: string;
  channel: string;
  status: string;
  priority: string;
  recipient_scope: string;
  recipient_ref: string | null;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at: unknown;
  next_attempt_at: unknown;
  delivered_at: unknown;
  failed_at: unknown;
  cancelled_at: unknown;
  failure_reason: string | null;
  organization_id: string;
  facility_id: string;
  created_at: unknown;
  updated_at: unknown;
}

interface EventRow {
  id: string;
  event_key: string;
  event_type: string;
  schema_version: string;
  aggregate_type: string;
  aggregate_id: string;
  organization_id: string;
  facility_id: string;
  correlation_id: string;
  occurred_at: unknown;
  source_kind: string;
  source_label: string;
  metadata: unknown;
}

interface AttemptRow {
  id: string;
  intent_id: string;
  attempt_number: number;
  attempted_at: unknown;
  outcome: string;
  failure_category: string | null;
  failure_reason: string | null;
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function toEvent(row: EventRow): NotificationEvent {
  return {
    eventId: row.id,
    type: row.event_type as NotificationEventType,
    schemaVersion: row.schema_version as NotificationSchemaVersion,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    organizationId: row.organization_id,
    facilityId: row.facility_id,
    correlationId: row.correlation_id,
    occurredAt: iso(row.occurred_at),
    sourceKind: row.source_kind as NotificationEvent['sourceKind'],
    sourceLabel: row.source_label,
    metadata: row.metadata as Readonly<Record<string, string>>,
  };
}

function toIntent(row: IntentRow): NotificationIntent {
  return {
    id: row.id as NotificationIntentId,
    eventId: row.event_id,
    eventType: row.event_type as NotificationEventType,
    correlationId: row.correlation_id,
    channel: row.channel as NotificationChannel,
    status: row.status as NotificationDeliveryStatus,
    priority: row.priority as NotificationPriority,
    recipientScope: row.recipient_scope,
    ...(row.recipient_ref ? { recipientRef: row.recipient_ref } : {}),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    ...(row.last_attempt_at ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
    ...(row.next_attempt_at ? { nextAttemptAt: iso(row.next_attempt_at) } : {}),
    ...(row.delivered_at ? { deliveredAt: iso(row.delivered_at) } : {}),
    ...(row.failed_at ? { failedAt: iso(row.failed_at) } : {}),
    ...(row.cancelled_at ? { cancelledAt: iso(row.cancelled_at) } : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    organizationId: row.organization_id,
    facilityId: row.facility_id,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toAttempt(row: AttemptRow): NotificationDeliveryAttempt {
  return {
    id: row.id,
    intentId: row.intent_id as NotificationIntentId,
    attemptNumber: row.attempt_number,
    attemptedAt: iso(row.attempted_at),
    outcome: row.outcome as NotificationDeliveryAttempt['outcome'],
    ...(row.failure_category
      ? {
          failureCategory:
            row.failure_category as NotificationDeliveryAttempt['failureCategory'],
        }
      : {}),
    ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
  };
}

const EVENT_SELECT = `SELECT id, event_key, event_type, schema_version, aggregate_type,
    aggregate_id, organization_id, facility_id, correlation_id, occurred_at,
    source_kind, source_label, metadata
    FROM sdis.notification_events`;
const INTENT_SELECT = `SELECT ${INTENT_COLUMNS} FROM sdis.notification_intents`;

/** Sentinel for a lost CAS race inside `settle` (rolled back, not an error). */
class SettleConflict extends Error {}

/** `createdAt|id` cursor split (ISO timestamps + UUIDs never contain '|'). */
function splitCursor(cursor: string): { createdAt: string; id: string } | undefined {
  const separator = cursor.lastIndexOf('|');
  if (separator < 0) return undefined;
  return {
    createdAt: cursor.slice(0, separator),
    id: cursor.slice(separator + 1),
  };
}

export class PostgresNotificationOutbox implements NotificationOutbox {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async enqueue(input: {
    readonly event: NotificationEvent;
    readonly eventKey: string;
    readonly intents: readonly NotificationIntentInput[];
    readonly now: string;
  }): Promise<{ event: NotificationEvent; intents: readonly NotificationIntent[] }> {
    const event = input.event;
    const intents: NotificationIntent[] = [];
    await this.db.transaction(async (client) => {
      await client.query(
        `INSERT INTO sdis.notification_events
            (id, event_key, event_type, schema_version, aggregate_type,
             aggregate_id, organization_id, facility_id, correlation_id,
             occurred_at, source_kind, source_label, metadata, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (event_key) DO NOTHING`,
        [
          event.eventId,
          input.eventKey,
          event.type,
          event.schemaVersion,
          event.aggregateType,
          event.aggregateId,
          event.organizationId,
          event.facilityId,
          event.correlationId,
          event.occurredAt,
          event.sourceKind,
          event.sourceLabel,
          JSON.stringify(event.metadata),
          input.now,
        ],
      );
      const events = await client.query<EventRow>(
        `${EVENT_SELECT} WHERE event_key = $1`,
        [input.eventKey],
      );
      const canonicalRow = events.rows[0];
      if (!canonicalRow) {
        throw new Error('Notification event was not persisted (outbox invariant)');
      }
      const canonical = toEvent(canonicalRow);
      for (const intentInput of input.intents) {
        const inserted = await client.query<IntentRow>(
          `INSERT INTO sdis.notification_intents
              (id, event_id, event_type, correlation_id, channel, status,
               priority, recipient_scope, recipient_ref, attempt_count,
               max_attempts, organization_id, facility_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, 0, $9, $10, $11, $12, $12)
           ON CONFLICT (event_id, channel) DO NOTHING
           RETURNING ${INTENT_COLUMNS}`,
          [
            randomUUID(),
            canonical.eventId,
            canonical.type,
            canonical.correlationId,
            intentInput.channel,
            intentInput.priority ?? 'ROUTINE',
            intentInput.recipientScope ?? 'facility:staff',
            intentInput.recipientRef ?? null,
            DEFAULT_MAX_ATTEMPTS,
            canonical.organizationId,
            canonical.facilityId,
            input.now,
          ],
        );
        const row = inserted.rows[0];
        if (row) {
          intents.push(toIntent(row));
          continue;
        }
        const existing = await client.query<IntentRow>(
          `${INTENT_SELECT} WHERE event_id = $1 AND channel = $2`,
          [canonical.eventId, intentInput.channel],
        );
        const existingRow = existing.rows[0];
        if (!existingRow) {
          throw new Error('Notification intent was not persisted (outbox invariant)');
        }
        intents.push(toIntent(existingRow));
      }
    });
    return { event: toEvent(await this.eventRow(input.eventKey)), intents };
  }

  async listByFacility(
    facilityId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: readonly NotificationIntent[]; nextCursor: string | null }> {
    const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
    const cursor = opts.cursor ? splitCursor(opts.cursor) : undefined;
    const result = await this.db.query<IntentRow>(
      `${INTENT_SELECT}
        WHERE facility_id = $1
          AND ($2::text IS NULL
               OR (created_at, id) < ($2::timestamptz, $3))
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [
        facilityId,
        cursor ? cursor.createdAt : null,
        cursor ? cursor.id : null,
        limit + 1,
      ],
    );
    const rows = result.rows;
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items.length > 0 ? items[items.length - 1] : undefined;
    const nextCursor = hasMore && last ? `${iso(last.created_at)}|${last.id}` : null;
    return { items: items.map(toIntent), nextCursor };
  }

  async findById(
    facilityId: string,
    intentId: string,
  ): Promise<NotificationIntent | undefined> {
    const result = await this.db.query<IntentRow>(
      `${INTENT_SELECT} WHERE id = $1 AND facility_id = $2`,
      [intentId, facilityId],
    );
    const row = result.rows[0];
    return row ? toIntent(row) : undefined;
  }

  async findEvent(
    facilityId: string,
    eventId: string,
  ): Promise<NotificationEvent | undefined> {
    const result = await this.db.query<EventRow>(
      `${EVENT_SELECT} WHERE id = $1 AND facility_id = $2`,
      [eventId, facilityId],
    );
    const row = result.rows[0];
    return row ? toEvent(row) : undefined;
  }

  async listAttempts(
    facilityId: string,
    intentId: string,
  ): Promise<readonly NotificationDeliveryAttempt[]> {
    const result = await this.db.query<AttemptRow>(
      `SELECT a.id, a.intent_id, a.attempt_number, a.attempted_at, a.outcome,
              a.failure_category, a.failure_reason
         FROM sdis.notification_delivery_attempts a
         JOIN sdis.notification_intents i ON i.id = a.intent_id
        WHERE a.intent_id = $1 AND i.facility_id = $2
        ORDER BY a.attempt_number`,
      [intentId, facilityId],
    );
    return result.rows.map(toAttempt);
  }

  async claimDue(
    facilityId: string,
    opts: { limit: number; leaseMs: number; now: number },
  ): Promise<readonly NotificationIntent[]> {
    const nowIso = new Date(opts.now).toISOString();
    const leaseCutoff = new Date(opts.now - opts.leaseMs).toISOString();
    const rows: IntentRow[] = [];
    await this.db.transaction(async (client) => {
      // 1) Finalize exhausted intents (bounded retry ceiling; no infinite
      //    loops) before claiming.
      await client.query(
        `UPDATE sdis.notification_intents
            SET status = 'PERMANENTLY_FAILED', failed_at = $2, updated_at = $2
          WHERE facility_id = $1
            AND status IN ('FAILED', 'RETRYING')
            AND attempt_count >= max_attempts`,
        [facilityId, nowIso],
      );
      // 2) Conditional claim: PENDING/RETRYING due, FAILED within its retry
      //    window (attempts remaining), and PROCESSING rows past their lease
      //    (crash recovery). `FOR UPDATE SKIP LOCKED` makes concurrent
      //    dispatchers deterministically DISJOINT: a row already locked by
      //    another claim transaction is skipped (never queued behind it), so
      //    exactly one worker wins each intent — no READ COMMITTED snapshot
      //    resurrection, no double delivery.
      const claimed = await client.query<IntentRow>(
        `WITH due AS (
            SELECT i.id
              FROM sdis.notification_intents i
             WHERE i.facility_id = $1
               AND (
                 (i.status IN ('PENDING', 'FAILED', 'RETRYING')
                  AND i.attempt_count < i.max_attempts
                  AND (i.next_attempt_at IS NULL OR i.next_attempt_at <= $2::timestamptz))
                 OR (i.status = 'PROCESSING' AND i.last_attempt_at IS NOT NULL
                     AND i.last_attempt_at <= $3::timestamptz)
               )
             ORDER BY COALESCE(i.next_attempt_at, i.created_at), i.id
             LIMIT $4
             FOR UPDATE SKIP LOCKED
          )
        UPDATE sdis.notification_intents AS ni
            SET status = 'PROCESSING', updated_at = $2
           FROM due
          WHERE ni.id = due.id
          RETURNING ni.id, ni.event_id, ni.event_type, ni.correlation_id,
                    ni.channel, ni.status, ni.priority, ni.recipient_scope,
                    ni.recipient_ref, ni.attempt_count, ni.max_attempts,
                    ni.last_attempt_at, ni.next_attempt_at, ni.delivered_at,
                    ni.failed_at, ni.cancelled_at, ni.failure_reason,
                    ni.organization_id, ni.facility_id, ni.created_at,
                    ni.updated_at`,
        [facilityId, nowIso, leaseCutoff, opts.limit],
      );
      rows.push(...claimed.rows);
    });
    return rows.map(toIntent);
  }

  async settle(settlement: {
    readonly intentId: NotificationIntentId;
    readonly expectedStatus: NotificationDeliveryStatus;
    readonly toStatus: NotificationDeliveryStatus;
    readonly attempt: NotificationDeliveryAttempt;
    readonly nextAttemptAt?: string;
    readonly failureReason?: string;
  }): Promise<boolean> {
    const { intentId, expectedStatus, toStatus, attempt } = settlement;
    try {
      return await this.db.transaction(async (client) => {
        await client.query(
          `INSERT INTO sdis.notification_delivery_attempts
              (id, intent_id, attempt_number, attempted_at, outcome,
               failure_category, failure_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (intent_id, attempt_number) DO NOTHING`,
          [
            attempt.id,
            attempt.intentId,
            attempt.attemptNumber,
            attempt.attemptedAt,
            attempt.outcome,
            attempt.failureCategory ?? null,
            attempt.failureReason ?? null,
          ],
        );
        const updated = await client.query(
          `UPDATE sdis.notification_intents
              SET status = $1,
                  attempt_count = $2,
                  last_attempt_at = $3,
                  next_attempt_at = $4,
                  failure_reason = $5,
                  delivered_at = CASE
                      WHEN $1 = 'DELIVERED' THEN $3 ELSE delivered_at END,
                  failed_at = CASE
                      WHEN $1 IN ('FAILED', 'RETRYING', 'PERMANENTLY_FAILED')
                      THEN $3 ELSE failed_at END,
                  updated_at = $3
            WHERE id = $6 AND status = $7`,
          [
            toStatus,
            attempt.attemptNumber,
            attempt.attemptedAt,
            settlement.nextAttemptAt ?? null,
            settlement.failureReason ?? null,
            intentId,
            expectedStatus,
          ],
        );
        if (updated.rowCount === 0) {
          throw new SettleConflict();
        }
        return true;
      });
    } catch (error) {
      if (error instanceof SettleConflict) return false;
      throw error;
    }
  }

  async cancel(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE sdis.notification_intents
          SET status = 'CANCELLED', cancelled_at = $1, updated_at = $1
        WHERE id = $2 AND status = $3
          AND status IN ('PENDING', 'FAILED', 'RETRYING')`,
      [at, intentId, from],
    );
    return updated.rowCount > 0;
  }

  async requeue(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean> {
    const updated = await this.db.query(
      `UPDATE sdis.notification_intents
          SET status = 'PENDING', next_attempt_at = NULL, updated_at = $1
        WHERE id = $2 AND status = $3
          AND status IN ('FAILED', 'RETRYING')`,
      [at, intentId, from],
    );
    return updated.rowCount > 0;
  }

  private async eventRow(eventKey: string): Promise<EventRow> {
    const result = await this.db.query<EventRow>(`${EVENT_SELECT} WHERE event_key = $1`, [
      eventKey,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('Notification event was not persisted (outbox invariant)');
    return row;
  }
}

/**
 * SDIS notifications & event delivery (Step 19).
 *
 * Application action → `emit()` → scope + RBAC validation → registered
 * channel adapters (in-memory/test only) → per-event delivery receipts.
 *
 * Step 19 adds the durable event-delivery foundation on top of the existing
 * synchronous fan-out:
 *   * `NotificationOutbox` — durable event + per-channel delivery-intent
 *     persistence, fed from `emit()` when an outbox is wired (production
 *     runtime). A persistence failure surfaces to the caller; a failed
 *     transaction leaves no event and no intents behind (outbox guarantee).
 *   * Delivery state machine + deterministic bounded retries, owned by
 *     `src/domain/notifications/notification.ts` and executed by
 *     `NotificationDispatcher` (claim → PROCESSING → DELIVERED / FAILED →
 *     RETRYING / PERMANENTLY_FAILED; CANCELLED via the API).
 *   * Read models: `listNotifications` / `getNotification` (keyset-paginated,
 *     no payload exposure) and retry/cancel lifecycle actions (manager tier).
 *
 * NON-GOALS (enforced): no clinical payloads in events (bounded string
 * metadata only); no clinical semantics (emitting never mutates clinical
 * state; no thresholds or alert rules); no real providers (in-memory/test
 * adapters only — SMS/email/webhook exist as provider BOUNDARIES, never fake
 * production integrations); delivery receipts carry their own dedup identity
 * (`idempotentDeliveryIdentity`) for the existing `runIdempotent` engine —
 * no second idempotency system.
 */

import { randomUUID } from 'node:crypto';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import {
  ConflictError,
  InvalidStateTransitionError,
  NotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../errors';
import { AuthorizationService, PERMISSIONS, type Permission } from '../authz/rbac';
import type { AuditPort, FacilityDirectory } from '../ports';
import { AuditRecorder } from '../audit';
import type { Logger } from '../../core/observability/logger';
import type { NotificationIntentId } from '../../types/ids';
import {
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  canTransitionDeliveryStatus,
  deliveryFailureReasonText,
  retryBackoffDelayMs,
  type DeliveryAttemptOutcome,
  type DeliveryFailureCategory,
  type NotificationChannel,
  type NotificationDeliveryAttempt,
  type NotificationDeliveryStatus,
  type NotificationEvent,
  type NotificationEventType,
  type NotificationIntent,
  type NotificationIntentInput,
  type NotificationPriority,
} from '../../domain/notifications/notification';

// ---------------------------------------------------------------------------
// Vocabulary re-exports — the domain module is the single canonical source.
// ---------------------------------------------------------------------------
export {
  NOTIFICATION_EVENT_TYPES,
  type NotificationEventType,
  NOTIFICATION_CHANNELS,
  type NotificationChannel,
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  type NotificationSchemaVersion,
  NOTIFICATION_SCHEMA_VERSIONS,
  isSupportedNotificationSchemaVersion,
  NOTIFICATION_PRIORITIES,
  type NotificationPriority,
  DEFAULT_NOTIFICATION_PRIORITY,
  DEFAULT_NOTIFICATION_RECIPIENT_SCOPE,
  type NotificationEvent,
  type NotificationIntent,
  type NotificationIntentInput,
  type NotificationDeliveryAttempt,
  type NotificationDeliveryStatus,
  type DeliveryAttemptOutcome,
  type DeliveryFailureCategory,
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  canTransitionDeliveryStatus,
  DELIVERY_FAILURE_CATEGORIES,
  retryBackoffDelayMs,
  DEFAULT_MAX_ATTEMPTS,
  deliveryFailureReasonText,
} from '../../domain/notifications/notification';

/** Aggregate + read-permission for each event type. */
const EVENT_CAPABILITY: Readonly<
  Record<
    NotificationEventType,
    { readonly aggregate: string; readonly permission: Permission }
  >
> = {
  'patient.registered': { aggregate: 'patient', permission: PERMISSIONS.PATIENT_READ },
  'order.created': { aggregate: 'diagnostic-order', permission: PERMISSIONS.ORDER_READ },
  'specimen.state_changed': { aggregate: 'specimen', permission: PERMISSIONS.ORDER_READ },
  'observation.available': {
    aggregate: 'observation',
    permission: PERMISSIONS.OBSERVATION_READ,
  },
  'report.finalized': {
    aggregate: 'diagnostic-report',
    permission: PERMISSIONS.REPORT_READ,
  },
  'report.amended': {
    aggregate: 'diagnostic-report',
    permission: PERMISSIONS.REPORT_READ,
  },
  'charge.created': { aggregate: 'charge', permission: PERMISSIONS.BILLING_READ },
  'device.acquisition_received': {
    aggregate: 'device-acquisition',
    permission: PERMISSIONS.ORDER_READ,
  },
  'inventory.low_stock': {
    aggregate: 'inventory-item',
    permission: PERMISSIONS.INVENTORY_READ,
  },
  'setup.config_changed': {
    aggregate: 'setup-config',
    permission: PERMISSIONS.SETUP_READ,
  },
};

export interface NotificationReceipt {
  readonly eventId: string;
  readonly channel: NotificationChannel;
  readonly attempt: number;
  readonly status: 'DELIVERED' | 'REJECTED' | 'FAILED';
  readonly failureCategory?: DeliveryFailureCategory;
  readonly occurredAt: string;
}

/** Implementation-neutral delivery port — provider behavior stays outside. */
export interface NotificationChannelAdapter {
  readonly channel: NotificationChannel;
  deliver(event: NotificationEvent): Promise<NotificationReceipt>;
}

/**
 * Durable outbox port (Step 19). Implementations are tenant/facility-scoped:
 * every read/claim/settle is keyed by the server-derived `facilityId`, and
 * PostgreSQL rides RLS so the same contract is enforced at the row level.
 * Claiming is a conditional, concurrency-safe operation (CAS on status), so
 * concurrent workers never deliver one intent twice; attempt records are
 * UNIQUE per (intent, attempt number) at the database layer.
 */
export interface NotificationOutbox {
  /** Persists an event + its delivery intents atomically (event dedup via key). */
  enqueue(input: {
    readonly event: NotificationEvent;
    /** Deterministic dedup identity (scope-keyed). Same key → same event row. */
    readonly eventKey: string;
    readonly intents: readonly NotificationIntentInput[];
    /** Queue time (deterministic input for created_at/updated_at). */
    readonly now: string;
  }): Promise<{ event: NotificationEvent; intents: readonly NotificationIntent[] }>;
  /** Keyset-paginated facility list (newest-first read model; no payload joins). */
  listByFacility(
    facilityId: string,
    opts: { cursor?: string; limit?: number },
  ): Promise<{ items: readonly NotificationIntent[]; nextCursor: string | null }>;
  /** One intent within a facility (scope guard; otherwise undefined). */
  findById(facilityId: string, intentId: string): Promise<NotificationIntent | undefined>;
  /** The event behind an intent (needed by the dispatcher to deliver). */
  findEvent(facilityId: string, eventId: string): Promise<NotificationEvent | undefined>;
  /** Append-only attempt ledger for one intent (ascending attempt number). */
  listAttempts(
    facilityId: string,
    intentId: string,
  ): Promise<readonly NotificationDeliveryAttempt[]>;
  /**
   * Claims due intents for a facility: PENDING/RETRYING due, FAILED within its
   * retry window (attempts remaining), and PROCESSING rows whose lease has
   * expired (crash recovery). Transition PENDING/RETRYING/FAILED → PROCESSING.
   */
  claimDue(
    facilityId: string,
    opts: { limit: number; leaseMs: number; now: number },
  ): Promise<readonly NotificationIntent[]>;
  /**
   * Records one delivery attempt and conditionally transitions the intent
   * (CAS on `expectedStatus`). Returns false when the intent no longer
   * matches (concurrent worker/claim already settled it). Atomic.
   */
  settle(settlement: {
    readonly intentId: NotificationIntentId;
    readonly expectedStatus: NotificationDeliveryStatus;
    readonly toStatus: NotificationDeliveryStatus;
    readonly attempt: NotificationDeliveryAttempt;
    readonly nextAttemptAt?: string;
    readonly failureReason?: string;
  }): Promise<boolean>;
  /** Cancels a PENDING/RETRYING/FAILED intent (CAS on `from`). */
  cancel(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean>;
  /** Re-queues a FAILED/RETRYING intent to PENDING (CAS on `from`). */
  requeue(
    intentId: string,
    from: NotificationDeliveryStatus,
    at: string,
  ): Promise<boolean>;
}

export interface NotificationServiceDependencies {
  /** Delivery adapters (in-memory/test only in this phase). */
  readonly adapters: readonly NotificationChannelAdapter[];
  /**
   * Optional durable outbox. When wired, `emit()` persists the event + one
   * intent per registered channel before fan-out, and the read/lifecycle
   * surface (`list`, `get`, `retry`, `cancel`) is enabled.
   */
  readonly outbox?: NotificationOutbox;
  /** Server-derived facility scope validation (existing port). */
  readonly facilities: FacilityDirectory;
  readonly audit: AuditPort;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
  /** Step-12 logger; safe operational metadata only. */
  readonly logger?: Logger;
}

function validateMetadata(metadata: Readonly<Record<string, string>>): void {
  for (const [key, value] of Object.entries(metadata)) {
    if (!key || key.length > 64 || typeof value !== 'string' || value.length > 200) {
      throw new ValidationError(
        'Notification metadata must be bounded non-empty strings',
      );
    }
  }
}

/** Deterministic dedup identity for a delivery attempt (for runIdempotent). */
export function idempotentDeliveryIdentity(
  eventId: string,
  channel: NotificationChannel,
  attempt: number,
): string {
  return `notification.delivery:${eventId}:${channel}:${attempt}`;
}

function isoPlusMs(iso: string, ms: number): string {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

/** Read-model DTOs — bounded status/timestamps, never payloads or secrets. */
export interface NotificationListItemDTO {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: NotificationEventType;
  readonly channel: NotificationChannel;
  readonly status: NotificationDeliveryStatus;
  readonly priority: NotificationPriority;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly cancelledAt?: string;
  readonly failureReason?: string;
  readonly createdAt: string;
}

export interface NotificationDetailDTO extends NotificationListItemDTO {
  readonly correlationId: string;
  readonly recipientScope: string;
  readonly recipientRef?: string;
  readonly attempts: readonly NotificationDeliveryAttempt[];
}

export interface NotificationListPageDTO {
  readonly items: readonly NotificationListItemDTO[];
  readonly nextCursor: string | null;
}

function toListItemDto(intent: NotificationIntent): NotificationListItemDTO {
  return {
    id: intent.id,
    eventId: intent.eventId,
    eventType: intent.eventType,
    channel: intent.channel,
    status: intent.status,
    priority: intent.priority,
    attemptCount: intent.attemptCount,
    maxAttempts: intent.maxAttempts,
    ...(intent.lastAttemptAt ? { lastAttemptAt: intent.lastAttemptAt } : {}),
    ...(intent.nextAttemptAt ? { nextAttemptAt: intent.nextAttemptAt } : {}),
    ...(intent.deliveredAt ? { deliveredAt: intent.deliveredAt } : {}),
    ...(intent.failedAt ? { failedAt: intent.failedAt } : {}),
    ...(intent.cancelledAt ? { cancelledAt: intent.cancelledAt } : {}),
    ...(intent.failureReason ? { failureReason: intent.failureReason } : {}),
    createdAt: intent.createdAt,
  };
}

function toDetailDto(
  intent: NotificationIntent,
  attempts: readonly NotificationDeliveryAttempt[],
): NotificationDetailDTO {
  return {
    ...toListItemDto(intent),
    correlationId: intent.correlationId,
    recipientScope: intent.recipientScope,
    ...(intent.recipientRef ? { recipientRef: intent.recipientRef } : {}),
    attempts,
  };
}

function isPermanentFailure(receipt: NotificationReceipt): boolean {
  return (
    receipt.status !== 'DELIVERED' &&
    (receipt.failureCategory === 'PERMANENT_FAILURE' ||
      receipt.failureCategory === 'UNSUPPORTED_CHANNEL' ||
      receipt.failureCategory === 'INVALID_DESTINATION')
  );
}

export class NotificationService {
  private readonly audit: AuditRecorder;
  /** eventId → [event, receipts] — in-memory delivery record (this phase). */
  private readonly deliveryLog = new Map<
    string,
    readonly [NotificationEvent, readonly NotificationReceipt[]]
  >();

  constructor(private readonly deps: NotificationServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Emits a domain event and synchronously fans it out to every registered
   * adapter. When a durable outbox is wired, the event + one intent per
   * registered channel are persisted FIRST (atomically); a persistence
   * failure surfaces to the caller so the authoritative transaction can roll
   * back — the outbox must never silently lose a required event.
   * Adapter failures are recorded receipts — emitting never breaks the
   * authoritative action.
   */
  async emit(
    session: ApplicationSession,
    input: {
      readonly type: NotificationEventType;
      readonly aggregateId: string;
      readonly correlationId: string;
      readonly occurredAt?: string;
      readonly metadata?: Readonly<Record<string, string>>;
    },
  ): Promise<{
    readonly event: NotificationEvent;
    readonly receipts: readonly NotificationReceipt[];
  }> {
    requireSession(session);
    const capability = EVENT_CAPABILITY[input.type];
    if (!capability) {
      throw new ValidationError(`Unsupported notification event type: ${input.type}`);
    }
    await this.deps.authz?.assertPermission(session, capability.permission);
    await assertSessionFacility(session, this.deps.facilities);

    const metadata = input.metadata ?? {};
    validateMetadata(metadata);

    const event: NotificationEvent = {
      eventId: randomUUID(),
      type: input.type,
      schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION,
      aggregateType: capability.aggregate,
      aggregateId: input.aggregateId,
      organizationId: session.organizationId,
      facilityId: session.facilityId, // server-derived scope
      correlationId: input.correlationId,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      sourceKind: 'SYSTEM',
      sourceLabel: `notification:${input.type}`,
      metadata,
    };

    let persisted:
      { event: NotificationEvent; intents: readonly NotificationIntent[] } | undefined;
    if (this.deps.outbox) {
      persisted = await this.deps.outbox.enqueue({
        event,
        // Deterministic dedup identity: the same (scope, type, aggregate,
        // correlation) replay maps to the same event row (DB-enforced UNIQUE).
        eventKey: `notification:${event.type}:${event.facilityId}:${event.aggregateId}:${event.correlationId}`,
        intents: this.enqueueableIntents(),
        now: event.occurredAt,
      });
    }

    const receipts = await this.deliverAll(event);
    this.deliveryLog.set(event.eventId, [event, receipts]);

    if (persisted) {
      // Best-effort durable state sync: the intent status follows the sync
      // receipt. Failures here never break emit — undelivered intents remain
      // claimable by the dispatcher (self-healing).
      await this.settleSyncDeliveries(persisted.intents, receipts);
    }

    // Only the logger's SAFE_KEYS vocabulary — safe operational metadata.
    this.deps.logger?.debug(
      {
        operation: 'notification.emit',
        resourceKind: event.type,
        resourceId: event.eventId,
        organizationId: event.organizationId,
        facilityId: event.facilityId,
        correlationId: event.correlationId,
        outcome: receipts.every((r) => r.status === 'DELIVERED')
          ? 'delivered'
          : 'partial_failure',
      },
      'notification emitted',
    );

    return { event, receipts };
  }

  /**
   * Read model: delivery receipts for one event within the caller's scope.
   * Permission-gated and scope-checked (IDOR-resistant).
   */
  async getDelivery(
    session: ApplicationSession,
    eventId: string,
  ): Promise<readonly NotificationReceipt[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.NOTIFICATION_READ);
    const stored = this.deliveryLog.get(eventId);
    if (!stored) {
      throw new NotFoundError('Delivery record not found');
    }
    const [event, receipts] = stored;
    if (
      event.organizationId !== session.organizationId ||
      event.facilityId !== session.facilityId
    ) {
      throw new ScopeMismatchError('Delivery record outside session scope');
    }
    return receipts;
  }

  /**
   * Keyset-paginated list of delivery intents for the caller's facility
   * (newest-first). NOTIFICATION_READ + facility scope; DTOs never carry
   * payloads or secrets. Absent outbox (no durable wiring) → validation error.
   */
  async listNotifications(
    session: ApplicationSession,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<NotificationListPageDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.NOTIFICATION_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const outbox = this.requireOutbox();
    const limit = opts.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ValidationError('limit must be an integer between 1 and 100');
    }
    const page = await outbox.listByFacility(session.facilityId, {
      ...(opts.cursor ? { cursor: opts.cursor } : {}),
      limit,
    });
    return { items: page.items.map(toListItemDto), nextCursor: page.nextCursor };
  }

  /** One delivery intent (incl. its attempt ledger) within the session scope. */
  async getNotification(
    session: ApplicationSession,
    intentId: NotificationIntentId,
  ): Promise<NotificationDetailDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.NOTIFICATION_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const outbox = this.requireOutbox();
    const intent = await outbox.findById(session.facilityId, intentId);
    if (!intent) {
      throw new NotFoundError('Notification not found');
    }
    const attempts = await outbox.listAttempts(session.facilityId, intentId);
    return toDetailDto(intent, attempts);
  }

  /**
   * Manager-tier lifecycle action: re-queues a failed intent for immediate
   * delivery (FAILED → PENDING, RETRYING → PENDING). Rejected on terminal
   * states and when the bounded attempt budget is exhausted. Audited.
   */
  async retryNotification(
    session: ApplicationSession,
    intentId: NotificationIntentId,
    opts: { at: string },
  ): Promise<NotificationDetailDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.NOTIFICATION_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const outbox = this.requireOutbox();
    const intent = await outbox.findById(session.facilityId, intentId);
    if (!intent) {
      throw new NotFoundError('Notification not found');
    }
    if (!canTransitionDeliveryStatus(intent.status, 'PENDING')) {
      throw new InvalidStateTransitionError(
        `Notification cannot be retried from state ${intent.status}`,
      );
    }
    if (intent.attemptCount >= intent.maxAttempts) {
      throw new InvalidStateTransitionError(
        'Notification has exhausted its bounded delivery attempts',
      );
    }
    const requeued = await outbox.requeue(intentId, intent.status, opts.at);
    if (!requeued) {
      throw new ConflictError('Notification state changed concurrently');
    }
    await this.audit.record(session, {
      action: 'TRANSITIONED',
      objectType: 'notification-delivery',
      objectId: intentId,
      at: opts.at,
      source: { kind: 'SYSTEM', label: 'notification-delivery' },
      detail: `retry re-queued from ${intent.status}; correlation=${intent.correlationId}`,
    });
    return this.notificationDetailFor(session, outbox, intentId);
  }

  /** Manager-tier lifecycle action: cancels a queued/retrying/failed intent. */
  async cancelNotification(
    session: ApplicationSession,
    intentId: NotificationIntentId,
    opts: { at: string },
  ): Promise<NotificationDetailDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.NOTIFICATION_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const outbox = this.requireOutbox();
    const intent = await outbox.findById(session.facilityId, intentId);
    if (!intent) {
      throw new NotFoundError('Notification not found');
    }
    if (!canTransitionDeliveryStatus(intent.status, 'CANCELLED')) {
      throw new InvalidStateTransitionError(
        `Notification cannot be cancelled from state ${intent.status}`,
      );
    }
    const cancelled = await outbox.cancel(intentId, intent.status, opts.at);
    if (!cancelled) {
      throw new ConflictError('Notification state changed concurrently');
    }
    await this.audit.record(session, {
      action: 'CANCELLED',
      objectType: 'notification-delivery',
      objectId: intentId,
      at: opts.at,
      source: { kind: 'SYSTEM', label: 'notification-delivery' },
      detail: `delivery cancelled from ${intent.status}; correlation=${intent.correlationId}`,
    });
    return this.notificationDetailFor(session, outbox, intentId);
  }

  /** Audits a state-changing notification via the EXISTING audit system. */
  async recordNotificationAudit(
    session: ApplicationSession,
    operation: {
      readonly objectType: string;
      readonly objectId: string;
      readonly at: string;
      readonly detail?: string;
    },
  ): Promise<void> {
    await this.audit.record(session, {
      action: 'EXPORTED',
      objectType: operation.objectType,
      objectId: operation.objectId,
      at: operation.at,
      source: {
        kind: 'SYSTEM',
        label: 'notification-delivery',
      },
      ...(operation.detail ? { detail: operation.detail } : {}),
    });
  }

  private requireOutbox(): NotificationOutbox {
    if (!this.deps.outbox) {
      throw new ValidationError('Notification persistence is not configured');
    }
    return this.deps.outbox;
  }

  private enqueueableIntents(): NotificationIntentInput[] {
    const seen = new Set<string>();
    const intents: NotificationIntentInput[] = [];
    for (const adapter of this.deps.adapters) {
      if (seen.has(adapter.channel)) continue;
      seen.add(adapter.channel);
      intents.push({ channel: adapter.channel });
    }
    return intents;
  }

  /**
   * Records the durable outcome of the synchronous fan-out for each persisted
   * intent. DELIVERED receipts settle DELIVERED; permanent categories settle
   * PERMANENTLY_FAILED; transient failures settle FAILED with a deterministic
   * retry window (the dispatcher claims FAILED-due intents later).
   */
  private async settleSyncDeliveries(
    intents: readonly NotificationIntent[],
    receipts: readonly NotificationReceipt[],
  ): Promise<void> {
    const outbox = this.requireOutbox();
    for (let i = 0; i < intents.length; i += 1) {
      const intent = intents[i];
      const receipt = receipts[i];
      if (!intent || !receipt) continue;
      const attemptNumber = intent.attemptCount + 1;
      const attempt: NotificationDeliveryAttempt = {
        id: randomUUID(),
        intentId: intent.id,
        attemptNumber,
        attemptedAt: receipt.occurredAt,
        outcome: (receipt.status === 'DELIVERED'
          ? 'SUCCESS'
          : 'FAILED') as DeliveryAttemptOutcome,
        ...(receipt.failureCategory ? { failureCategory: receipt.failureCategory } : {}),
      };
      let toStatus: NotificationDeliveryStatus;
      let nextAttemptAt: string | undefined;
      let failureReason: string | undefined;
      if (receipt.status === 'DELIVERED') {
        toStatus = 'DELIVERED';
      } else if (isPermanentFailure(receipt)) {
        toStatus = 'PERMANENTLY_FAILED';
        failureReason = deliveryFailureReasonText(receipt.failureCategory);
      } else {
        toStatus = 'FAILED';
        nextAttemptAt = isoPlusMs(receipt.occurredAt, retryBackoffDelayMs(attemptNumber));
        failureReason = deliveryFailureReasonText(receipt.failureCategory);
      }
      try {
        await outbox.settle({
          intentId: intent.id,
          expectedStatus: 'PENDING',
          toStatus,
          attempt,
          ...(nextAttemptAt ? { nextAttemptAt } : {}),
          ...(failureReason ? { failureReason } : {}),
        });
      } catch (error) {
        // Self-healing: the intent stays claimable; emitting is unaffected.
        this.deps.logger?.warn(
          {
            operation: 'notification.settle',
            resourceKind: 'notification-delivery',
            resourceId: intent.id,
            facilityId: intent.facilityId,
            correlationId: intent.correlationId,
            outcome: 'failed',
          },
          `notification intent sync settle failed: ${String(error)}`,
        );
      }
    }
  }

  private async notificationDetailFor(
    session: ApplicationSession,
    outbox: NotificationOutbox,
    intentId: NotificationIntentId,
  ): Promise<NotificationDetailDTO> {
    const intent = await outbox.findById(session.facilityId, intentId);
    if (!intent) {
      throw new NotFoundError('Notification not found');
    }
    const attempts = await outbox.listAttempts(session.facilityId, intentId);
    return toDetailDto(intent, attempts);
  }

  private async deliverAll(
    event: NotificationEvent,
  ): Promise<readonly NotificationReceipt[]> {
    if (this.deps.adapters.length === 0) {
      throw new ValidationError('No notification channel adapter is registered');
    }
    const receipts: NotificationReceipt[] = [];
    for (const adapter of this.deps.adapters) {
      try {
        const receipt = await adapter.deliver(event);
        receipts.push(receipt);
      } catch {
        // Adapter crash → recorded failure receipt, never a thrown error:
        // emitting must not break the authoritative action that produced it.
        receipts.push({
          eventId: event.eventId,
          channel: adapter.channel,
          attempt: 1,
          status: 'FAILED',
          failureCategory: 'TEMPORARY_FAILURE',
          occurredAt: new Date().toISOString(),
        });
      }
    }
    return receipts;
  }
}

/**
 * SDIS notifications & event delivery domain contract (Step 19).
 *
 * Canonical vocabulary for the event/notification foundation: bounded event
 * types, delivery channels, the delivery state machine with explicit valid
 * transitions, deterministic bounded retry backoff, event schema versioning,
 * and the durable event / delivery-intent / delivery-attempt records. The
 * application service (`src/app/notifications/notification-service.ts`)
 * re-exports this vocabulary so consumers keep one import boundary.
 *
 * Channels: `IN_MEMORY` is the shipped in-memory/test adapter channel;
 * `IN_APP` is the internal notification channel; `EMAIL` / `SMS` / `WEBHOOK`
 * are PROVIDER BOUNDARIES only — no vendor integration exists or is claimed
 * (docs/API_CONTRACTS.md §6). Delivery intents are only ever created for
 * channels with a registered adapter.
 *
 * Contract-only: no storage, no providers, no transport, no application
 * errors. Invalid state transitions are expressed here as booleans; the
 * application service maps them onto the INVALID_STATE_TRANSITION contract.
 */

import type { NotificationIntentId } from '../../types/ids';

/** Bounded, safe event types over the repository's ACTUAL capabilities. */
export const NOTIFICATION_EVENT_TYPES = [
  'patient.registered',
  'order.created',
  'specimen.state_changed',
  'observation.available',
  'report.finalized',
  'report.amended',
  'charge.created',
  'device.acquisition_received',
  'inventory.low_stock',
  'setup.config_changed',
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];

/**
 * Bounded delivery channel vocabulary. IN_MEMORY + IN_APP are real today;
 * EMAIL / SMS / WEBHOOK are provider-boundary interfaces, never fake
 * production integrations.
 */
export const NOTIFICATION_CHANNELS = [
  'IN_MEMORY',
  'IN_APP',
  'EMAIL',
  'SMS',
  'WEBHOOK',
] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Bounded delivery priority — operational routing, never clinical semantics. */
export const NOTIFICATION_PRIORITIES = ['ROUTINE', 'HIGH'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const DEFAULT_NOTIFICATION_PRIORITY: NotificationPriority = 'ROUTINE';

/**
 * Event schema versioning (Step 19): consumers must reject envelopes with an
 * unknown schema version instead of guessing. The envelope is
 * version-stamped at emission; storage records and re-exposes it.
 */
export const NOTIFICATION_SCHEMA_VERSIONS = ['1'] as const;
export type NotificationSchemaVersion = (typeof NOTIFICATION_SCHEMA_VERSIONS)[number];

export const NOTIFICATION_EVENT_SCHEMA_VERSION: NotificationSchemaVersion = '1';

export function isSupportedNotificationSchemaVersion(
  value: unknown,
): value is NotificationSchemaVersion {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_SCHEMA_VERSIONS as readonly string[]).includes(value)
  );
}

/** Durable domain event (append-only fact; never a clinical payload). */
export interface NotificationEvent {
  readonly eventId: string;
  readonly type: NotificationEventType;
  readonly schemaVersion: NotificationSchemaVersion;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceKind: 'HUMAN' | 'DEVICE' | 'ALGORITHM' | 'INTEGRATION' | 'SYSTEM';
  readonly sourceLabel: string;
  /** Bounded, non-empty strings. NEVER clinical payloads, NEVER credentials. */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * Delivery state machine. Every transition is explicit; anything not listed
 * below is invalid and the application layer rejects it with
 * INVALID_STATE_TRANSITION (409).
 *
 *   PENDING            → PROCESSING (claim) | DELIVERED | FAILED (sync
 *                        attempt at emit) | CANCELLED
 *   PROCESSING         → DELIVERED | FAILED | PERMANENTLY_FAILED
 *   FAILED             → RETRYING (retry scheduled) | PENDING (manual
 *                        requeue) | PERMANENTLY_FAILED (exhausted) | CANCELLED
 *   RETRYING           → PROCESSING (claim) | PENDING (manual retry-now) |
 *                        CANCELLED
 *   DELIVERED, PERMANENTLY_FAILED, CANCELLED → terminal
 */
export const DELIVERY_STATUSES = [
  'PENDING',
  'PROCESSING',
  'DELIVERED',
  'FAILED',
  'RETRYING',
  'PERMANENTLY_FAILED',
  'CANCELLED',
] as const;

export type NotificationDeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const DELIVERY_TRANSITIONS: Readonly<
  Record<NotificationDeliveryStatus, readonly NotificationDeliveryStatus[]>
> = {
  PENDING: ['PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED'],
  PROCESSING: ['DELIVERED', 'FAILED', 'PERMANENTLY_FAILED'],
  FAILED: ['RETRYING', 'PENDING', 'PERMANENTLY_FAILED', 'CANCELLED'],
  RETRYING: ['PROCESSING', 'PENDING', 'CANCELLED'],
  DELIVERED: [],
  PERMANENTLY_FAILED: [],
  CANCELLED: [],
};

export function canTransitionDeliveryStatus(
  from: NotificationDeliveryStatus,
  to: NotificationDeliveryStatus,
): boolean {
  const allowed = DELIVERY_TRANSITIONS[from] as readonly NotificationDeliveryStatus[];
  return allowed.includes(to);
}

/**
 * A per-channel delivery intent — the durable unit of the delivery lifecycle.
 * `eventType` / `correlationId` are denormalized at enqueue so read models
 * never need payload joins (bounded, non-PHI; docs/API_CONTRACTS.md §4/§16).
 */
export interface NotificationIntent {
  readonly id: NotificationIntentId;
  readonly eventId: string;
  readonly eventType: NotificationEventType;
  readonly correlationId: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationDeliveryStatus;
  readonly priority: NotificationPriority;
  readonly recipientScope: string;
  readonly recipientRef?: string;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastAttemptAt?: string;
  readonly nextAttemptAt?: string;
  readonly deliveredAt?: string;
  readonly failedAt?: string;
  readonly cancelledAt?: string;
  readonly failureReason?: string;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Queueing input for one intent (channel is always adapter-registered). */
export interface NotificationIntentInput {
  readonly channel: NotificationChannel;
  readonly priority?: NotificationPriority;
  readonly recipientScope?: string;
  readonly recipientRef?: string;
}

export const DELIVERY_ATTEMPT_OUTCOMES = ['SUCCESS', 'FAILED'] as const;
export type DeliveryAttemptOutcome = (typeof DELIVERY_ATTEMPT_OUTCOMES)[number];

/** Bounded failure categories — reused the receipt vocabulary, never free text. */
export const DELIVERY_FAILURE_CATEGORIES = [
  'TEMPORARY_FAILURE',
  'PERMANENT_FAILURE',
  'UNSUPPORTED_CHANNEL',
  'INVALID_DESTINATION',
] as const;
export type DeliveryFailureCategory = (typeof DELIVERY_FAILURE_CATEGORIES)[number];

/** One delivery try (append-only; UNIQUE per intent + attempt number). */
export interface NotificationDeliveryAttempt {
  readonly id: string;
  readonly intentId: NotificationIntentId;
  readonly attemptNumber: number;
  readonly attemptedAt: string;
  readonly outcome: DeliveryAttemptOutcome;
  readonly failureCategory?: DeliveryFailureCategory;
  readonly failureReason?: string;
}

/**
 * Bounded, deterministic retry policy. `maxAttempts` is the hard ceiling for
 * delivery tries per intent (no infinite loops); `retryBackoffDelayMs` yields
 * the deterministic wait AFTER attempt `attemptNumber` before the next try:
 * 1s, 2s, 4s, 8s, 16s, then capped at 60s.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;
export const RETRY_BACKOFF_BASE_MS = 1_000;
export const RETRY_BACKOFF_CAP_MS = 60_000;

export function retryBackoffDelayMs(attemptNumber: number): number {
  const exponent = Math.max(0, attemptNumber - 1);
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** exponent, RETRY_BACKOFF_CAP_MS);
}

/** Default recipient scope for facility-staff notification intents. */
export const DEFAULT_NOTIFICATION_RECIPIENT_SCOPE = 'facility:staff';

/**
 * Bounded, non-PHI human-readable failure text recorded on intents. Never
 * echoes a payload; at most the bounded category vocabulary.
 */
export function deliveryFailureReasonText(
  category?: DeliveryFailureCategory,
): string | undefined {
  switch (category) {
    case 'UNSUPPORTED_CHANNEL':
      return 'channel not supported by any registered provider';
    case 'INVALID_DESTINATION':
      return 'destination rejected by channel';
    case 'TEMPORARY_FAILURE':
      return 'temporary delivery failure';
    case 'PERMANENT_FAILURE':
      return 'permanent delivery failure';
    default:
      return undefined;
  }
}

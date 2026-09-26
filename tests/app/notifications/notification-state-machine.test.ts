/**
 * Notifications & event delivery — domain vocabulary tests (Step 19).
 *
 * Proves the explicit delivery state machine (every valid transition listed,
 * every other transition invalid), the deterministic bounded retry backoff,
 * schema versioning, and the bounded failure-reason vocabulary — all without
 * storage, providers, or application wiring.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DELIVERY_STATUSES,
  DELIVERY_TRANSITIONS,
  NOTIFICATION_SCHEMA_VERSIONS,
  canTransitionDeliveryStatus,
  deliveryFailureReasonText,
  isSupportedNotificationSchemaVersion,
  retryBackoffDelayMs,
  DEFAULT_MAX_ATTEMPTS,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
} from '../../../src/domain/notifications/notification';
import type { NotificationDeliveryStatus } from '../../../src/domain/notifications/notification';

const ALL: readonly NotificationDeliveryStatus[] = DELIVERY_STATUSES;

describe('notification domain: delivery state machine', () => {
  it('exposes exactly the seven delivery states of the contract', () => {
    assert.deepEqual([...ALL].sort(), [
      'CANCELLED',
      'DELIVERED',
      'FAILED',
      'PENDING',
      'PERMANENTLY_FAILED',
      'PROCESSING',
      'RETRYING',
    ]);
  });

  it('lists every transition that the pipeline actually performs', () => {
    // The full explicit transition map — any future transition must be added
    // here (and to the migration's vocabulary review) before it can happen.
    const expected: Readonly<Record<string, readonly string[]>> = {
      PENDING: ['PROCESSING', 'DELIVERED', 'FAILED', 'CANCELLED'],
      PROCESSING: ['DELIVERED', 'FAILED', 'PERMANENTLY_FAILED'],
      FAILED: ['RETRYING', 'PENDING', 'PERMANENTLY_FAILED', 'CANCELLED'],
      RETRYING: ['PROCESSING', 'PENDING', 'CANCELLED'],
      DELIVERED: [],
      PERMANENTLY_FAILED: [],
      CANCELLED: [],
    };
    assert.deepEqual(DELIVERY_TRANSITIONS, expected);
    // Every mapped transition is accepted by the guard (self-consistency).
    for (const from of ALL) {
      for (const to of DELIVERY_TRANSITIONS[
        from
      ] as readonly NotificationDeliveryStatus[]) {
        assert.equal(canTransitionDeliveryStatus(from, to), true, `${from}->${to}`);
      }
    }
  });

  it('rejects every transition that is not listed (no silent states)', () => {
    // Terminals are fully closed; non-terminals reject direct jumps to any
    // state outside their allowed set — including returning to PENDING from
    // PROCESSING and self-transitions.
    assert.equal(canTransitionDeliveryStatus('DELIVERED', 'PENDING'), false);
    assert.equal(canTransitionDeliveryStatus('PERMANENTLY_FAILED', 'RETRYING'), false);
    assert.equal(canTransitionDeliveryStatus('CANCELLED', 'PENDING'), false);
    assert.equal(canTransitionDeliveryStatus('PROCESSING', 'PENDING'), false);
    assert.equal(canTransitionDeliveryStatus('PROCESSING', 'CANCELLED'), false);
    assert.equal(canTransitionDeliveryStatus('PENDING', 'PENDING'), false);
    assert.equal(canTransitionDeliveryStatus('FAILED', 'DELIVERED'), false);
    assert.equal(canTransitionDeliveryStatus('RETRYING', 'DELIVERED'), false);
    for (const state of ALL) {
      assert.equal(canTransitionDeliveryStatus(state, state), false, `${state}->itself`);
    }
  });
});

describe('notification domain: bounded deterministic retry backoff', () => {
  it('doubles from the base until the cap, deterministically', () => {
    assert.equal(RETRY_BACKOFF_BASE_MS, 1_000);
    assert.equal(RETRY_BACKOFF_CAP_MS, 60_000);
    assert.equal(retryBackoffDelayMs(1), 1_000);
    assert.equal(retryBackoffDelayMs(2), 2_000);
    assert.equal(retryBackoffDelayMs(3), 4_000);
    assert.equal(retryBackoffDelayMs(4), 8_000);
    assert.equal(retryBackoffDelayMs(5), 16_000);
    // Beyond the cap the delay is clamped at 60s — bounded, no unbounded drift.
    assert.equal(retryBackoffDelayMs(6), 32_000);
    assert.equal(retryBackoffDelayMs(7), 60_000);
    assert.equal(retryBackoffDelayMs(50), 60_000);
    // A degenerate/negative attempt never underflows below the base.
    assert.equal(retryBackoffDelayMs(0), 1_000);
  });

  it('bounds the attempt budget (no infinite retries by construction)', () => {
    assert.equal(DEFAULT_MAX_ATTEMPTS, 5);
  });
});

describe('notification domain: schema versioning', () => {
  it('ships exactly one supported envelope version today', () => {
    assert.deepEqual(NOTIFICATION_SCHEMA_VERSIONS, ['1']);
    assert.equal(isSupportedNotificationSchemaVersion('1'), true);
    assert.equal(isSupportedNotificationSchemaVersion('2'), false);
    assert.equal(isSupportedNotificationSchemaVersion(undefined), false);
    assert.equal(isSupportedNotificationSchemaVersion(null), false);
    assert.equal(isSupportedNotificationSchemaVersion({}), false);
  });
});

describe('notification domain: bounded failure reason vocabulary', () => {
  it('maps every bounded failure category to a non-PHI label', () => {
    assert.equal(
      deliveryFailureReasonText('TEMPORARY_FAILURE'),
      'temporary delivery failure',
    );
    assert.equal(
      deliveryFailureReasonText('PERMANENT_FAILURE'),
      'permanent delivery failure',
    );
    assert.equal(
      deliveryFailureReasonText('UNSUPPORTED_CHANNEL'),
      'channel not supported by any registered provider',
    );
    assert.equal(
      deliveryFailureReasonText('INVALID_DESTINATION'),
      'destination rejected by channel',
    );
    assert.equal(deliveryFailureReasonText(undefined), undefined);
  });
});

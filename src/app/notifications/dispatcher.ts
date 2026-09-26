/**
 * SDIS notification dispatcher (Step 19).
 *
 * Executes the durable delivery lifecycle on top of the outbox: claims due
 * intents (PENDING/RETRYING/FAILED within their retry window, plus crashed
 * PROCESSING rows past their lease), delivers through the registered channel
 * adapter, and settles outcomes through the explicit state machine:
 *
 *   PROCESSING → DELIVERED          (success)
 *   PROCESSING → RETRYING           (transient failure, attempts remain;
 *                                    next attempt scheduled deterministically)
 *   PROCESSING → PERMANENTLY_FAILED (permanent failure or attempts exhausted)
 *
 * Credentials/scope: the dispatcher is an OPERATIONS path — the caller must
 * run it under the target facility's tenant scope (the PG composition wraps
 * it in `runWithTenantScope`); RLS is never bypassed for worker convenience.
 * Every delivery outcome records an attempt and is audited with a SYSTEM
 * actor (there is no user session here).
 */

import { randomUUID } from 'node:crypto';
import { AuditRecorder } from '../audit';
import type { AuditPort } from '../ports';
import type { Logger } from '../../core/observability/logger';
import type { ApplicationSession } from '../context';
import {
  retryBackoffDelayMs,
  deliveryFailureReasonText,
} from '../../domain/notifications/notification';
import type {
  NotificationChannelAdapter,
  NotificationDeliveryAttempt,
  NotificationIntent,
  NotificationOutbox,
  NotificationReceipt,
} from './notification-service';

export interface NotificationDispatcherDependencies {
  readonly outbox: NotificationOutbox;
  readonly adapters: readonly NotificationChannelAdapter[];
  readonly audit: AuditPort;
  readonly logger?: Logger;
  /** Deterministic clock seam (unix ms) for backoff/lease computation. */
  readonly now?: () => number;
  /** Bounded worker batch (docs/API_CONTRACTS.md §16: no unbounded batches). */
  readonly batchSize?: number;
  /** Processing lease: PROCESSING rows older than this are claimable again. */
  readonly leaseMs?: number;
}

export interface DispatchSummary {
  readonly facilityId: string;
  claimed: number;
  delivered: number;
  retriesScheduled: number;
  permanentlyFailed: number;
  skipped: number;
}

export class NotificationDispatcher {
  private readonly audit: AuditRecorder;
  private readonly batchSize: number;
  private readonly leaseMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: NotificationDispatcherDependencies) {
    this.audit = new AuditRecorder(deps.audit);
    this.batchSize = deps.batchSize ?? 25;
    this.leaseMs = deps.leaseMs ?? 5 * 60 * 1_000;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Processes one bounded batch of due intents for a facility. Must be
   * invoked under the facility's tenant scope (composition/operations seam).
   * Never throws on per-intent delivery failures — outcomes are settled and
   * counted.
   */
  async processDue(facilityId: string): Promise<DispatchSummary> {
    const claimed = await this.deps.outbox.claimDue(facilityId, {
      limit: this.batchSize,
      leaseMs: this.leaseMs,
      now: this.now(),
    });
    const summary: DispatchSummary = {
      facilityId,
      claimed: claimed.length,
      delivered: 0,
      retriesScheduled: 0,
      permanentlyFailed: 0,
      skipped: 0,
    };
    for (const intent of claimed) {
      await this.processClaimed(summary, intent);
    }
    return summary;
  }

  private async processClaimed(
    summary: DispatchSummary,
    intent: NotificationIntent,
  ): Promise<void> {
    const adapter = this.deps.adapters.find((a) => a.channel === intent.channel);
    const event = await this.deps.outbox.findEvent(intent.facilityId, intent.eventId);
    if (!event) {
      // Event record missing → nothing addressable to deliver: terminal.
      await this.terminalSettle(summary, intent, {
        failureReason: 'event record missing',
      });
      return;
    }
    if (!adapter) {
      // Bounded safety net (emit only queues registered channels).
      await this.terminalSettle(summary, intent, {
        failureReason: deliveryFailureReasonText('UNSUPPORTED_CHANNEL'),
        category: 'UNSUPPORTED_CHANNEL',
      });
      return;
    }

    let receipt: NotificationReceipt;
    try {
      receipt = await adapter.deliver(event);
    } catch {
      receipt = {
        eventId: event.eventId,
        channel: adapter.channel,
        attempt: intent.attemptCount + 1,
        status: 'FAILED',
        failureCategory: 'TEMPORARY_FAILURE',
        occurredAt: new Date(this.now()).toISOString(),
      };
    }

    const attemptNumber = intent.attemptCount + 1;
    const attempt: NotificationDeliveryAttempt = {
      id: randomUUID(),
      intentId: intent.id,
      attemptNumber,
      attemptedAt: receipt.occurredAt,
      outcome: receipt.status === 'DELIVERED' ? 'SUCCESS' : 'FAILED',
      ...(receipt.failureCategory ? { failureCategory: receipt.failureCategory } : {}),
    };

    if (receipt.status === 'DELIVERED') {
      const settled = await this.deps.outbox.settle({
        intentId: intent.id,
        expectedStatus: 'PROCESSING',
        toStatus: 'DELIVERED',
        attempt,
      });
      if (!settled) {
        summary.skipped += 1;
        return;
      }
      summary.delivered += 1;
      await this.auditTransition(intent, 'delivered', attempt.attemptedAt);
      return;
    }

    const permanent =
      receipt.failureCategory === 'PERMANENT_FAILURE' ||
      receipt.failureCategory === 'UNSUPPORTED_CHANNEL' ||
      receipt.failureCategory === 'INVALID_DESTINATION';

    if (permanent || attemptNumber >= intent.maxAttempts) {
      await this.terminalSettle(summary, intent, {
        failureReason: permanent
          ? deliveryFailureReasonText(receipt.failureCategory)
          : 'delivery attempts exhausted',
        category: receipt.failureCategory,
      });
      return;
    }

    // Transient failure with attempts remaining → retry window scheduled
    // deterministically, and the intent enters the explicit RETRYING state.
    const nextAttemptAt = new Date(
      new Date(receipt.occurredAt).getTime() + retryBackoffDelayMs(attemptNumber),
    ).toISOString();
    const settled = await this.deps.outbox.settle({
      intentId: intent.id,
      expectedStatus: 'PROCESSING',
      toStatus: 'RETRYING',
      attempt,
      nextAttemptAt,
      failureReason: deliveryFailureReasonText(receipt.failureCategory),
    });
    if (!settled) {
      summary.skipped += 1;
      return;
    }
    summary.retriesScheduled += 1;
    await this.auditTransition(intent, 'retry scheduled', receipt.occurredAt);
  }

  private async terminalSettle(
    summary: DispatchSummary,
    intent: NotificationIntent,
    opts: { failureReason?: string; category?: NotificationReceipt['failureCategory'] },
  ): Promise<void> {
    const attemptNumber = intent.attemptCount + 1;
    const attempt: NotificationDeliveryAttempt = {
      id: randomUUID(),
      intentId: intent.id,
      attemptNumber,
      attemptedAt: new Date(this.now()).toISOString(),
      outcome: 'FAILED',
      ...(opts.category ? { failureCategory: opts.category } : {}),
    };
    const settled = await this.deps.outbox.settle({
      intentId: intent.id,
      expectedStatus: 'PROCESSING',
      toStatus: 'PERMANENTLY_FAILED',
      attempt,
      failureReason: opts.failureReason ?? 'permanent delivery failure',
    });
    if (!settled) {
      summary.skipped += 1;
      return;
    }
    summary.permanentlyFailed += 1;
    await this.auditTransition(intent, 'permanently failed', attempt.attemptedAt);
  }

  /** SYSTEM-actor audit via the existing chain — no user session exists here. */
  private async auditTransition(
    intent: NotificationIntent,
    detail: string,
    at: string,
  ): Promise<void> {
    const session = this.systemSession(intent.organizationId, intent.facilityId);
    try {
      await this.audit.record(session, {
        action: 'TRANSITIONED',
        objectType: 'notification-delivery',
        objectId: intent.id,
        at,
        source: { kind: 'SYSTEM', label: 'notification-dispatcher' },
        detail: `${detail} (${intent.channel}) correlation=${intent.correlationId}`,
      });
    } catch (error) {
      this.deps.logger?.warn(
        {
          operation: 'notification.dispatch.audit',
          resourceKind: 'notification-delivery',
          resourceId: intent.id,
          facilityId: intent.facilityId,
          correlationId: intent.correlationId,
          outcome: 'failed',
        },
        `dispatcher audit failed: ${String(error)}`,
      );
    }
  }

  private systemSession(organizationId: string, facilityId: string): ApplicationSession {
    return {
      actor: { kind: 'SYSTEM', id: 'notification-dispatcher' },
      userId: 'system:notification-dispatcher',
      organizationId,
      facilityId,
    } as never;
  }
}

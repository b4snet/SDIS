/**
 * SDIS append-only audit contract.
 *
 * Audit events are never updated or deleted. The store exposes ONLY `append`.
 * This is a contract; a durable implementation (PostgreSQL table with RLS) is a
 * later step.
 */

import type { AuditEventId } from '../../types/ids';
import type { Provenance } from '../../types/provenance';
import type { FacilityContext } from '../../types/tenant';

export type AuditAction =
  | 'CREATED'
  | 'UPDATED'
  | 'VERIFIED'
  | 'FINALIZED'
  | 'AMENDED'
  | 'REPORTED'
  | 'CANCELLED'
  | 'TRANSITIONED'
  | 'IMPORTED'
  | 'EXPORTED';

export interface AuditEvent {
  readonly id: AuditEventId;
  readonly action: AuditAction;
  /** Type name of the affected object, e.g. "diagnostic-order". */
  readonly objectType: string;
  readonly objectId: string;
  readonly at: string;
  readonly context: FacilityContext;
  readonly provenance: Provenance;
  readonly detail?: string;
}

/** The only interface an audit store exposes: append-only. */
export interface AuditStore {
  append(event: AuditEvent): Promise<void>;
}

/**
 * In-memory audit store for local development and tests.
 * Entries are frozen on capture; mutation attempts fail in strict mode.
 */
export class InMemoryAuditStore implements AuditStore {
  private readonly entries: readonly AuditEvent[] = [];

  async append(event: AuditEvent): Promise<void> {
    // Freeze deeply enough to prevent silent rewriting of audit entries.
    const frozen: AuditEvent = Object.freeze({
      ...event,
      provenance: Object.freeze({
        ...event.provenance,
        source: Object.freeze(event.provenance.source),
      }),
    });
    (this.entries as AuditEvent[]).push(frozen);
  }

  /** Read access for audit/reporting. Never a mutation path. */
  list(): readonly AuditEvent[] {
    return this.entries;
  }
}

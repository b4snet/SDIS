/**
 * SDIS application audit recorder — the ONLY audit path used by services.
 *
 * It builds an `AuditEvent` over the Step-1 append-only contract
 * (`src/core/audit/audit.ts`) and records it through the injected port. There
 * is no second audit system and no update/delete path.
 *
 * `detail` must never carry raw PHI (patient names, clinical values, secrets).
 */

import { randomUUID } from 'node:crypto';
import type { AuditAction, AuditEvent } from '../core/audit/audit';
import type { AuditEventId } from '../types/ids';
import type { DataSource } from '../types/provenance';
import { facilityContextOf, provenanceFor, type ApplicationSession } from './context';
import { type AuditPort } from './ports';

export interface AuditableOperation {
  readonly action: AuditAction;
  /** Domain object type, e.g. "diagnostic-order", "specimen", "report". */
  readonly objectType: string;
  readonly objectId: string;
  /** ISO-8601 timestamp of the audited action (deterministic input). */
  readonly at: string;
  /** Source kind of the recorded action — never collapsed. */
  readonly source: DataSource;
  /** Non-PHI explanatory detail only. */
  readonly detail?: string;
}

export class AuditRecorder {
  constructor(private readonly audit: AuditPort) {}

  async record(
    session: ApplicationSession,
    operation: AuditableOperation,
  ): Promise<void> {
    const event: AuditEvent = {
      id: randomUUID() as AuditEventId,
      action: operation.action,
      objectType: operation.objectType,
      objectId: operation.objectId,
      at: operation.at,
      context: facilityContextOf(session),
      provenance: provenanceFor(session, operation.at, operation.source),
      ...(operation.detail ? { detail: operation.detail } : {}),
    };
    await this.audit.record(event);
  }
}

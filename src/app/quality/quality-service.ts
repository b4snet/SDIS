/**
 * SDIS quality application service (Step 27).
 *
 * Makes the EXISTING quality domain contract (`src/domain/quality/quality.ts`)
 * a real capability: facility-scoped quality records (IQC, EQA, CALIBRATION,
 * MAINTENANCE, NONCONFORMITY, ...) with explicit provenance, audit, and an
 * OPERATIONAL QC hold boundary.
 *
 * Strict separation (docs/CLINICAL_SAFETY.md):
 *
 *   QC workflow → analytical quality status → operational decision
 *   Patient testing → patient diagnostic result
 *
 * A QC failure NEVER rewrites patient results. The only interaction with the
 * laboratory workflow is an explicit, auditable HOLD: when a facility has an
 * active analytical hold, report finalization is refused (409 CONFLICT) until
 * an authorized actor releases it. No thresholds, no clinical decision rules —
 * holds are set and released by authorized humans, never computed from
 * patient data.
 */

import { randomUUID } from 'node:crypto';
import type { FacilityId, QualityRecordId } from '../../types/ids';
import type { Provenance, DataSource } from '../../types/provenance';
import type { QualityFamily, QualityRecord } from '../../domain/quality/quality';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';

/** A persisted quality record: the domain record plus its stable id. */
export interface StoredQualityRecord extends QualityRecord {
  readonly id: QualityRecordId;
  /** Non-PHI operational note (never clinical interpretation). */
  readonly note?: string;
}

/** An active analytical hold: blocks report finalization until released. */
export interface QualityHold {
  readonly id: QualityRecordId;
  readonly facilityId: FacilityId;
  readonly reason: string;
  readonly at: string;
  readonly releasedAt?: string;
  readonly releasedByRef?: string;
}

/** Persistence port for quality records (Step 27; PostgreSQL-backed). */
export interface QualityRecordRepository {
  save(
    record: StoredQualityRecord & { readonly hold?: QualityHold },
  ): Promise<StoredQualityRecord & { readonly hold?: QualityHold }>;
  findById(
    id: QualityRecordId,
  ): Promise<(StoredQualityRecord & { readonly hold?: QualityHold }) | undefined>;
  /** Latest hold for a facility, if any (active = not released). */
  findActiveHold(facilityId: FacilityId): Promise<QualityHold | undefined>;
  listByFacility(
    facilityId: FacilityId,
    family?: QualityFamily,
  ): Promise<readonly (StoredQualityRecord & { readonly hold?: QualityHold })[]>;
}

export interface RecordQualityInput {
  readonly family: QualityFamily;
  /** What the record refers to (device id, document id, batch, ...). */
  readonly referenceType: string;
  readonly referenceId?: string;
  readonly at: string;
  /** Non-PHI operational note (never clinical interpretation). */
  readonly note?: string;
  /** Set an active analytical hold with this record (see module doc). */
  readonly hold?: { readonly reason: string };
  readonly idempotencyKey?: string;
}

export interface ReleaseHoldInput {
  readonly holdId: QualityRecordId;
  readonly at: string;
  readonly idempotencyKey?: string;
}

export interface QualityServiceDependencies {
  readonly quality: QualityRecordRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

const QUALITY_SOURCE: DataSource = {
  kind: 'SYSTEM',
  label: 'application quality management',
};

const NOTE_MAX = 512;

/** Reference types are bounded operational labels, not free text. */
const REFERENCE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class QualityService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: QualityServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /** Records one quality event (QC/IQC/EQA/CALIBRATION/... — domain family). */
  async recordQuality(
    session: ApplicationSession | undefined,
    input: RecordQualityInput,
  ): Promise<StoredQualityRecord & { readonly hold?: QualityHold }> {
    requireSession(session);
    // Quality administration is a manager-tier act via the dedicated quality
    // permission (never a configuration permission — AUD-02).
    await this.deps.authz?.assertPermission(session, PERMISSIONS.QUALITY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;

    if (!input.at || Number.isNaN(new Date(input.at).getTime())) {
      throw new ValidationError('A quality record requires a valid timestamp');
    }
    if (!REFERENCE_PATTERN.test(input.referenceType)) {
      throw new ValidationError(
        'Quality record referenceType must be a bounded identifier',
      );
    }
    const note = input.note ?? undefined;
    if (note !== undefined && (note.length === 0 || note.length > NOTE_MAX)) {
      throw new ValidationError(`Quality note must be 1-${NOTE_MAX} characters`);
    }
    if (input.hold && (!input.hold.reason || input.hold.reason.length > NOTE_MAX)) {
      throw new ValidationError('A hold requires a 1-512 character reason');
    }

    return runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.QUALITY_RECORD,
      input.idempotencyKey,
      async () => {
        const provenance: Provenance = {
          actor: session.actor,
          source: QUALITY_SOURCE,
          timestamp: input.at,
          context: {
            organizationId: session.organizationId,
            facilityId,
          },
        };
        const recordId = randomUUID() as QualityRecordId;
        const record: StoredQualityRecord & { readonly hold?: QualityHold } = {
          id: recordId,
          family: input.family,
          facilityId,
          referenceType: input.referenceType,
          ...(input.referenceId ? { referenceId: input.referenceId } : {}),
          at: input.at,
          provenance,
          ...(input.hold
            ? {
                // One row = one hold: the hold shares the record's stable id
                // (matching the PostgreSQL mapping), so hold references are
                // always resolvable record references.
                hold: {
                  id: recordId,
                  facilityId,
                  reason: input.hold.reason,
                  at: input.at,
                },
              }
            : {}),
        };
        const saved = await this.deps.quality.save(record);
        await this.audit.record(session, {
          action: 'CREATED',
          objectType: 'quality-record',
          objectId: saved.id,
          at: input.at,
          source: QUALITY_SOURCE,
          detail: `quality ${saved.family} (${saved.referenceType})${input.hold ? ' + ANALYTICAL HOLD' : ''}`,
        });
        return saved;
      },
      session,
    );
  }

  /** Releases an active analytical hold (authorized, audited, idempotent). */
  async releaseHold(
    session: ApplicationSession | undefined,
    input: ReleaseHoldInput,
  ): Promise<QualityHold> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.QUALITY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const record = await this.deps.quality.findById(input.holdId);
    if (!record || record.facilityId !== session.facilityId) {
      throw new NotFoundError('Quality record not found');
    }
    if (!record.hold) throw new NotFoundError('Quality record has no hold');
    if (record.hold.releasedAt) return record.hold; // idempotent replay

    return runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.QUALITY_RELEASE,
      input.idempotencyKey,
      async () => {
        const released: QualityHold = {
          ...record.hold!,
          releasedAt: input.at,
          releasedByRef: session.actor.id,
        };
        await this.deps.quality.save({ ...record, hold: released });
        await this.audit.record(session, {
          action: 'UPDATED',
          objectType: 'quality-record',
          objectId: record.id,
          at: input.at,
          source: QUALITY_SOURCE,
          detail: 'analytical hold released',
        });
        return released;
      },
      session,
    );
  }

  /**
   * The facility's active analytical hold, if any. Consulted by the report
   * finalization boundary — the ONLY workflow interaction with QC.
   */
  async activeHold(session: ApplicationSession): Promise<QualityHold | undefined> {
    return this.deps.quality.findActiveHold(session.facilityId);
  }

  /** Facility-scoped quality listing (read model, manager tier). */
  async listQuality(
    session: ApplicationSession | undefined,
    family?: QualityFamily,
  ): Promise<readonly (StoredQualityRecord & { readonly hold?: QualityHold })[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    return this.deps.quality.listByFacility(session.facilityId, family);
  }
}

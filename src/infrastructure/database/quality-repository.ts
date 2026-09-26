/**
 * PostgreSQL quality record repository (Step 27).
 *
 * Persists quality records and the analytical-hold boundary over
 * `sdis.quality_records` (migration 023). Tenant/facility isolation rides
 * RLS (policies in the migration) plus server-derived session scope in the
 * application service. Records are append-oriented: a hold release is a new
 * version of the row's hold columns, never a deletion.
 */

import { getDatabase } from './database';
import type { Database } from './database';
import type { FacilityId, QualityRecordId } from '../../types/ids';
import type { QualityFamily } from '../../domain/quality/quality';
import type {
  QualityHold,
  QualityRecordRepository,
  StoredQualityRecord,
} from '../../app/quality/quality-service';

interface QualityRow {
  readonly id: string;
  readonly facility_id: string;
  readonly family: string;
  readonly reference_type: string;
  readonly reference_id: string | null;
  readonly at: string;
  readonly provenance: unknown;
  readonly note: string | null;
  readonly hold_reason: string | null;
  readonly hold_released_at: string | null;
  readonly hold_released_by: string | null;
}

interface Stored extends StoredQualityRecord {
  hold?: QualityHold;
  note?: string;
}

function toRecord(row: QualityRow): Stored {
  const hold: QualityHold | undefined =
    row.hold_reason !== null
      ? {
          id: row.id as QualityRecordId,
          facilityId: row.facility_id as FacilityId,
          reason: row.hold_reason,
          at: row.at,
          ...(row.hold_released_at
            ? {
                releasedAt: row.hold_released_at,
                releasedByRef: row.hold_released_by ?? '',
              }
            : {}),
        }
      : undefined;
  return {
    id: row.id as QualityRecordId,
    facilityId: row.facility_id as FacilityId,
    family: row.family as QualityFamily,
    referenceType: row.reference_type,
    ...(row.reference_id ? { referenceId: row.reference_id } : {}),
    at: row.at,
    provenance: row.provenance as StoredQualityRecord['provenance'],
    ...(row.note ? { note: row.note } : {}),
    ...(hold ? { hold } : {}),
  };
}

export class PostgresQualityRepository implements QualityRecordRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(record: Stored): Promise<Stored> {
    await this.db.query(
      `INSERT INTO sdis.quality_records
            (id, facility_id, family, reference_type, reference_id, at,
             provenance, note, hold_reason, hold_released_at, hold_released_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET
            hold_reason = EXCLUDED.hold_reason,
            hold_released_at = EXCLUDED.hold_released_at,
            hold_released_by = EXCLUDED.hold_released_by`,
      [
        record.id,
        record.facilityId,
        record.family,
        record.referenceType,
        record.referenceId ?? null,
        record.at,
        JSON.stringify(record.provenance),
        record.note ?? null,
        record.hold?.reason ?? null,
        record.hold?.releasedAt ?? null,
        record.hold?.releasedByRef ?? null,
      ],
    );
    return record;
  }

  async findById(id: QualityRecordId): Promise<Stored | undefined> {
    const result = await this.db.query<QualityRow>(
      `SELECT id, facility_id, family, reference_type, reference_id, at,
              provenance, note, hold_reason, hold_released_at, hold_released_by
         FROM sdis.quality_records WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return toRecord(result.rows[0]!);
  }

  /**
   * Active hold for the CURRENT RLS scope (Step 27): used by the report
   * finalization probe, which runs inside the request's tenant context so
   * the query is already narrowed to the caller's facility.
   */
  async findActiveHoldInScope(): Promise<QualityHold | undefined> {
    const result = await this.db.query<QualityRow>(
      `SELECT id, facility_id, family, reference_type, reference_id, at,
              provenance, note, hold_reason, hold_released_at, hold_released_by
         FROM sdis.quality_records
        WHERE hold_reason IS NOT NULL AND hold_released_at IS NULL
        ORDER BY at DESC LIMIT 1`,
    );
    if (result.rows.length === 0) return undefined;
    return toRecord(result.rows[0]!).hold;
  }

  async findActiveHold(facilityId: FacilityId): Promise<QualityHold | undefined> {
    const result = await this.db.query<QualityRow>(
      `SELECT id, facility_id, family, reference_type, reference_id, at,
              provenance, note, hold_reason, hold_released_at, hold_released_by
         FROM sdis.quality_records
        WHERE facility_id = $1 AND hold_reason IS NOT NULL
              AND hold_released_at IS NULL
        ORDER BY at DESC LIMIT 1`,
      [facilityId],
    );
    if (result.rows.length === 0) return undefined;
    return toRecord(result.rows[0]!).hold;
  }

  async listByFacility(
    facilityId: FacilityId,
    family?: QualityFamily,
  ): Promise<readonly Stored[]> {
    const result = await this.db.query<QualityRow>(
      `SELECT id, facility_id, family, reference_type, reference_id, at,
              provenance, note, hold_reason, hold_released_at, hold_released_by
         FROM sdis.quality_records
        WHERE facility_id = $1 AND ($2::text IS NULL OR family = $2)
        ORDER BY at`,
      [facilityId, family ?? null],
    );
    return Object.freeze(result.rows.map(toRecord));
  }
}

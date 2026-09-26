/**
 * In-memory quality record repository (Step 27).
 *
 * Deterministic test adapter over the `QualityRecordRepository` port. The
 * PostgreSQL implementation (migration 023) mirrors these semantics: scoped
 * persistence, one active hold per facility, append-oriented records.
 */

import type { FacilityId, QualityRecordId } from '../types/ids';
import type { QualityFamily } from '../domain/quality/quality';
import type {
  QualityHold,
  QualityRecordRepository,
  StoredQualityRecord,
} from './quality/quality-service';

interface Stored extends StoredQualityRecord {
  hold?: QualityHold;
}

export class InMemoryQualityRepository implements QualityRecordRepository {
  private readonly records = new Map<QualityRecordId, Stored>();

  async save(record: Stored): Promise<Stored> {
    this.records.set(record.id, record);
    return record;
  }

  async findById(id: QualityRecordId): Promise<Stored | undefined> {
    return this.records.get(id);
  }

  async findActiveHold(facilityId: FacilityId): Promise<QualityHold | undefined> {
    for (const record of this.records.values()) {
      if (record.facilityId === facilityId && record.hold && !record.hold.releasedAt) {
        return record.hold;
      }
    }
    return undefined;
  }

  async listByFacility(
    facilityId: FacilityId,
    family?: QualityFamily,
  ): Promise<readonly Stored[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          record.facilityId === facilityId &&
          (family === undefined || record.family === family),
      )
      .sort((a, b) => a.at.localeCompare(b.at));
  }
}

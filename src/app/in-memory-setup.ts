/**
 * In-memory master-setup adapters (test/development) mirroring migration 013
 * semantics: append-only version rows, one latest version per
 * (facility, family, department?, key), and department reference validation.
 */

import type { DepartmentId, FacilityId, SetupConfigId } from '../types/ids';
import type {
  SetupConfigRecord,
  SetupConfigRepository,
} from './setup/setup-config-service';
import { ConflictError } from './errors';

export class InMemorySetupConfigRepository implements SetupConfigRepository {
  private readonly records = new Map<SetupConfigId, SetupConfigRecord>();
  private readonly departments = new Map<DepartmentId, FacilityId>();

  /** Registers a synthetic department reference (fixture setup). */
  registerDepartment(departmentId: DepartmentId, facilityId: FacilityId): void {
    this.departments.set(departmentId, facilityId);
  }

  async save(record: SetupConfigRecord): Promise<SetupConfigRecord> {
    const duplicate = [...this.records.values()].some(
      (existing) =>
        existing.context.facilityId === record.context.facilityId &&
        existing.family === record.family &&
        existing.key === record.key &&
        (existing.context.departmentId ?? '') === (record.context.departmentId ?? '') &&
        existing.version === record.version,
    );
    if (duplicate) {
      throw new ConflictError('This configuration version already exists');
    }
    this.records.set(record.id, record);
    return record;
  }

  async findById(id: SetupConfigId): Promise<SetupConfigRecord | undefined> {
    return this.records.get(id);
  }

  async findLatest(
    facilityId: FacilityId,
    departmentId: DepartmentId | undefined,
    family: SetupConfigRecord['family'],
    key: string,
  ): Promise<SetupConfigRecord | undefined> {
    return this.latestOf(
      [...this.records.values()].filter(
        (record) =>
          record.context.facilityId === facilityId &&
          record.family === family &&
          record.key === key &&
          (record.context.departmentId ?? '') === (departmentId ?? ''),
      ),
    );
  }

  async listLatest(facilityId: FacilityId): Promise<readonly SetupConfigRecord[]> {
    const scoped = [...this.records.values()].filter(
      (record) => record.context.facilityId === facilityId,
    );
    const groups = new Map<string, SetupConfigRecord[]>();
    for (const record of scoped) {
      const groupKey = `${record.family}:${record.context.departmentId ?? ''}:${record.key}`;
      groups.set(groupKey, [...(groups.get(groupKey) ?? []), record]);
    }
    return [...groups.values()].flatMap((group) => {
      const latest = this.latestOf(group);
      return latest ? [latest] : [];
    });
  }

  async findDepartmentFacility(
    departmentId: DepartmentId,
  ): Promise<FacilityId | undefined> {
    return this.departments.get(departmentId);
  }

  private latestOf(records: readonly SetupConfigRecord[]): SetupConfigRecord | undefined {
    return records.reduce<SetupConfigRecord | undefined>(
      (latest, record) => (!latest || record.version > latest.version ? record : latest),
      undefined,
    );
  }
}

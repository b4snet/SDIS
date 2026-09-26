/**
 * In-memory department master-data repository (Step 24) — mirrors the
 * PostgreSQL semantics (unique code per facility, deterministic listing)
 * for the application/HTTP test layers.
 */

import type { DepartmentId, FacilityId } from '../types/ids';
import type { DepartmentRecord, DepartmentRepository } from './setup/department-service';

export class InMemoryDepartmentRepository implements DepartmentRepository {
  private readonly departments = new Map<DepartmentId, DepartmentRecord>();

  async save(department: DepartmentRecord): Promise<DepartmentRecord> {
    this.departments.set(department.id, department);
    return department;
  }

  async findById(id: DepartmentId): Promise<DepartmentRecord | undefined> {
    return this.departments.get(id);
  }

  async listByFacility(facilityId: FacilityId): Promise<readonly DepartmentRecord[]> {
    return [...this.departments.values()]
      .filter((record) => record.facilityId === facilityId)
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  async findByCode(
    facilityId: FacilityId,
    code: string,
  ): Promise<DepartmentRecord | undefined> {
    return [...this.departments.values()].find(
      (record) => record.facilityId === facilityId && record.code === code,
    );
  }
}

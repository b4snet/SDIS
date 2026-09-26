/**
 * PostgreSQL department master-data repository (Step 24).
 *
 * Reads and writes the EXISTING `sdis.departments` table (migration 001)
 * plus the Step-24 `status` lifecycle column (migration 021). Tenant/facility
 * isolation rides the table's facility FK and the application's server-derived
 * session scope; codes are unique per facility by schema constraint.
 */

import { getDatabase } from './database';
import type { Database } from './database';
import type { DepartmentId, FacilityId } from '../../types/ids';
import type {
  DepartmentRecord,
  DepartmentRepository,
  DepartmentStatus,
} from '../../app/setup/department-service';
import { ConflictError } from '../../app/errors';

interface DepartmentRow {
  readonly id: string;
  readonly facility_id: string;
  readonly name: string;
  readonly code: string;
  readonly modalities: string[] | null;
  readonly status: string | null;
}

const COLUMNS = `id, facility_id, name, code, modalities, status`;

function toRecord(row: DepartmentRow): DepartmentRecord {
  return {
    id: row.id as DepartmentId,
    facilityId: row.facility_id as FacilityId,
    name: row.name,
    code: row.code,
    modalities: row.modalities ?? [],
    status: (row.status ?? 'ACTIVE') as DepartmentStatus,
  };
}

export class PostgresDepartmentRepository implements DepartmentRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(department: DepartmentRecord): Promise<DepartmentRecord> {
    try {
      await this.db.query(
        `INSERT INTO sdis.departments (id, facility_id, name, code, modalities, status)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            modalities = EXCLUDED.modalities,
            status = EXCLUDED.status`,
        [
          department.id,
          department.facilityId,
          department.name,
          department.code,
          department.modalities,
          department.status,
        ],
      );
      return department;
    } catch (error) {
      // Unique (facility_id, code): a code is a stable identifier and is
      // never silently reused — surface as the existing CONFLICT contract.
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictError('Department code already exists in this facility');
      }
      throw error;
    }
  }

  async findById(id: DepartmentId): Promise<DepartmentRecord | undefined> {
    const result = await this.db.query<DepartmentRow>(
      `SELECT ${COLUMNS} FROM sdis.departments WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async listByFacility(facilityId: FacilityId): Promise<readonly DepartmentRecord[]> {
    const result = await this.db.query<DepartmentRow>(
      `SELECT ${COLUMNS} FROM sdis.departments
        WHERE facility_id = $1
        ORDER BY code`,
      [facilityId],
    );
    return result.rows.map(toRecord);
  }

  async findByCode(
    facilityId: FacilityId,
    code: string,
  ): Promise<DepartmentRecord | undefined> {
    const result = await this.db.query<DepartmentRow>(
      `SELECT ${COLUMNS} FROM sdis.departments
        WHERE facility_id = $1 AND code = $2`,
      [facilityId, code],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }
}

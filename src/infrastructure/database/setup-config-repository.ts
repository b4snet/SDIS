/**
 * PostgreSQL master-setup configuration repository (Step 15).
 *
 * The schema (`db/migrations/013_setup_config_schema.sql`) is APPEND-ONLY: an
 * update inserts version N+1 in the same scope and the previous version rows
 * remain. Uniqueness of (facility, family, department?, key, version) is
 * enforced by the schema and surfaces as the existing CONFLICT contract, so a
 * concurrent writer can never silently overwrite another's configuration.
 */

import { getDatabase } from './database';
import type { Database } from './database';
import type {
  DepartmentId,
  FacilityId,
  OrganizationId,
  SetupConfigId,
} from '../../types/ids';
import type { ConfigFamily } from '../../domain/master-setup/master-setup';
import type {
  SetupConfigRecord,
  SetupConfigRepository,
} from '../../app/setup/setup-config-service';
import { ConflictError } from '../../app/errors';

interface ConfigRow {
  readonly id: string;
  readonly organization_id: string;
  readonly facility_id: string;
  readonly department_id: string | null;
  readonly family: string;
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  readonly source_version: string | null;
  readonly effective_from: Date | string;
}

const SELECT_COLUMNS = `
  c.id, f.organization_id, c.facility_id, c.department_id, c.family, c.key,
  c.value, c.version, c.source_version, c.effective_from`;

function toRecord(row: ConfigRow): SetupConfigRecord {
  return {
    id: row.id as SetupConfigId,
    family: row.family as ConfigFamily,
    context: {
      organizationId: row.organization_id as OrganizationId,
      facilityId: row.facility_id as FacilityId,
      ...(row.department_id ? { departmentId: row.department_id as DepartmentId } : {}),
    },
    key: row.key,
    value: row.value,
    version: row.version,
    ...(row.source_version ? { sourceVersion: row.source_version } : {}),
    effectiveFrom: new Date(row.effective_from).toISOString(),
  };
}

export class PostgresSetupConfigRepository implements SetupConfigRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(record: SetupConfigRecord): Promise<SetupConfigRecord> {
    try {
      await this.db.query(
        `INSERT INTO sdis.setup_config
                (id, facility_id, department_id, family, key, value, version,
                 source_version, effective_from)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
        [
          record.id,
          record.context.facilityId,
          record.context.departmentId ?? null,
          record.family,
          record.key,
          JSON.stringify(record.value),
          record.version,
          record.sourceVersion ?? null,
          record.effectiveFrom,
        ],
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ConflictError('This configuration version already exists');
      }
      throw error;
    }
    return record;
  }

  async findById(id: SetupConfigId): Promise<SetupConfigRecord | undefined> {
    const result = await this.db.query<ConfigRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM sdis.setup_config c
         JOIN sdis.facilities f ON f.id = c.facility_id
        WHERE c.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async findLatest(
    facilityId: FacilityId,
    departmentId: DepartmentId | undefined,
    family: ConfigFamily,
    key: string,
  ): Promise<SetupConfigRecord | undefined> {
    const result = await this.db.query<ConfigRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM sdis.setup_config c
         JOIN sdis.facilities f ON f.id = c.facility_id
        WHERE c.facility_id = $1
          AND c.family = $3
          AND c.key = $4
          AND COALESCE(c.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY c.version DESC
        LIMIT 1`,
      [facilityId, departmentId ?? null, family, key],
    );
    const row = result.rows[0];
    return row ? toRecord(row) : undefined;
  }

  async listLatest(facilityId: FacilityId): Promise<readonly SetupConfigRecord[]> {
    const result = await this.db.query<ConfigRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM sdis.setup_config c
         JOIN sdis.facilities f ON f.id = c.facility_id
        WHERE c.facility_id = $1
          AND c.version = (
              SELECT max(inner_c.version) FROM sdis.setup_config inner_c
               WHERE inner_c.facility_id = c.facility_id
                 AND inner_c.family = c.family
                 AND inner_c.key = c.key
                 AND COALESCE(inner_c.department_id, '00000000-0000-0000-0000-000000000000'::uuid)
                     = COALESCE(c.department_id, '00000000-0000-0000-0000-000000000000'::uuid))
        ORDER BY c.family, c.key`,
      [facilityId],
    );
    return result.rows.map(toRecord);
  }

  async findDepartmentFacility(
    departmentId: DepartmentId,
  ): Promise<FacilityId | undefined> {
    const result = await this.db.query<{ facility_id: string }>(
      `SELECT facility_id FROM sdis.departments WHERE id = $1`,
      [departmentId],
    );
    const row = result.rows[0];
    return row ? (row.facility_id as FacilityId) : undefined;
  }
}

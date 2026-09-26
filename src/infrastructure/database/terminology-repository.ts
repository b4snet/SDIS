/**
 * PostgreSQL Terminology Mapping Repository.
 *
 * Implements the `TerminologyMappingRepository` port against migration 008
 * (`sdis.terminology_mappings`). Uniqueness (canonical, external system,
 * external code, facility scope) is enforced by the schema UNIQUE constraint
 * — the last line of defense behind the service's exact-duplicate probe — and
 * surfaces as the stable CONFLICT contract. Scope filtering is applied by the
 * application service using the session; RLS remains the database-level
 * guarantee (policies in migration 008 mirror migration 006 conventions).
 */

import type { TerminologyMappingRepository } from '../../app/terminology/terminology-service';
import type { TerminologyMapping } from '../../domain/terminology/terminology';
import type { FacilityId, TerminologyMappingId } from '../../types/ids';
import { ConflictError } from '../../app/errors';
import { Database, getDatabase } from './database';

interface TerminologyRow {
  id: string;
  canonical_code: string;
  external_system: string;
  external_code: string;
  facility_id: string | null;
  validated: boolean;
}

function mapRow(row: TerminologyRow): TerminologyMapping {
  return {
    id: row.id as TerminologyMappingId,
    canonical: { system: 'sdis', code: row.canonical_code },
    external: { system: row.external_system, code: row.external_code },
    ...(row.facility_id ? { facilityId: row.facility_id as FacilityId } : {}),
    validated: row.validated,
  };
}

export class PostgresTerminologyMappingRepository implements TerminologyMappingRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(mapping: TerminologyMapping): Promise<TerminologyMapping> {
    try {
      await this.db.query(
        `INSERT INTO sdis.terminology_mappings
                (id, canonical_code, external_system, external_code, facility_id, validated)
             VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          mapping.id,
          mapping.canonical.code,
          mapping.external.system,
          mapping.external.code,
          mapping.facilityId ?? null,
          mapping.validated,
        ],
      );
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === '23505'
      ) {
        throw new ConflictError('An identical mapping already exists in this facility');
      }
      throw error;
    }
    return mapping;
  }

  async findById(id: TerminologyMappingId): Promise<TerminologyMapping | undefined> {
    const result = await this.db.query<TerminologyRow>(
      'SELECT id, canonical_code, external_system, external_code, facility_id, validated FROM sdis.terminology_mappings WHERE id = $1',
      [id],
    );
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0] as TerminologyRow);
  }

  async listByCanonical(
    canonicalCode: string,
    externalSystem: string,
  ): Promise<readonly TerminologyMapping[]> {
    // Domain precedence: facility overrides before global defaults.
    const result = await this.db.query<TerminologyRow>(
      `SELECT id, canonical_code, external_system, external_code, facility_id, validated
             FROM sdis.terminology_mappings
             WHERE canonical_code = $1 AND external_system = $2
             ORDER BY (facility_id IS NULL), facility_id NULLS LAST`,
      [canonicalCode, externalSystem],
    );
    return result.rows.map(mapRow);
  }

  async findExact(params: {
    canonicalCode: string;
    externalSystem: string;
    externalCode: string;
    facilityId: TerminologyMapping['facilityId'];
  }): Promise<TerminologyMapping | undefined> {
    const result = await this.db.query<TerminologyRow>(
      `SELECT id, canonical_code, external_system, external_code, facility_id, validated
             FROM sdis.terminology_mappings
             WHERE canonical_code = $1 AND external_system = $2 AND external_code = $3
               AND facility_id IS NOT DISTINCT FROM $4`,
      [
        params.canonicalCode,
        params.externalSystem,
        params.externalCode,
        params.facilityId ?? null,
      ],
    );
    if (result.rows.length === 0) return undefined;
    return mapRow(result.rows[0] as TerminologyRow);
  }
}

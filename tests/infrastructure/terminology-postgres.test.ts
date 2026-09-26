/**
 * Terminology persistence — disposable PostgreSQL tests.
 *
 * Proves migration 008 from an empty database, mapping persistence and
 * retrieval through the application service, schema-level uniqueness
 * (23505) as the last line of defense, and tenant/facility boundary
 * behavior. SQL is used as evidence of persistence, never as the contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { TerminologyPersistenceService } from '../../src/app/terminology/terminology-service';
import { PostgresTerminologyMappingRepository } from '../../src/infrastructure/database/terminology-repository';
import {
  PostgresAuditPort,
  PostgresFacilityDirectory,
} from '../../src/infrastructure/database/repositories';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { ConflictError, NotFoundError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';

const PORT = 55444;
const FACILITY = '00000000-0000-4000-8000-000000000011';
// Same organization as FACILITY (seeded) — isolates FACILITY-scope behavior
// from the forged-tenant pairing guard, which other tests cover.
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'terminology-admin' },
    userId: 'terminology-admin',
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

const CREATE = {
  canonicalCode: 'GLUCOSE',
  externalSystem: 'loinc',
  externalCode: '2345-7',
};

let db: Database;
let service: TerminologyPersistenceService;
let repo: PostgresTerminologyMappingRepository;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  repo = new PostgresTerminologyMappingRepository(db);
  service = new TerminologyPersistenceService({
    mappings: repo,
    facilities: new PostgresFacilityDirectory(db),
    audit: new PostgresAuditPort(db),
    idempotency: new InMemoryIdempotencyStore(),
  });
});

after(async () => {
  await teardownTestDatabase();
});

describe('terminology postgres: persistence', () => {
  it('migration 008 created the table from an empty database', async () => {
    const table = await db.query(
      `SELECT to_regclass('sdis.terminology_mappings') AS reg`,
    );
    assert.ok(table.rows[0]?.reg, 'terminology table must exist');
    const policy = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy WHERE polrelid = 'sdis.terminology_mappings'::regclass`,
    );
    assert.ok((policy.rowCount ?? 0) >= 2, 'RLS policies must exist');
  });

  it('persists and retrieves a facility-scoped mapping', async () => {
    const dto = await service.createMapping(session(), CREATE);
    const row = await db.query<{
      canonical_code: string;
      external_system: string;
      external_code: string;
      facility_id: string;
      validated: boolean;
    }>(
      `SELECT canonical_code, external_system, external_code, facility_id, validated
             FROM sdis.terminology_mappings WHERE id = $1`,
      [dto.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0]?.canonical_code, 'GLUCOSE');
    assert.equal(row.rows[0]?.external_system, 'loinc');
    assert.equal(row.rows[0]?.facility_id, FACILITY);
    assert.equal(row.rows[0]?.validated, false);

    const found = await service.getMapping(session(), dto.id as never);
    assert.equal(found.id, dto.id);
  });

  it('enforces schema uniqueness (23505) as the last line of defense', async () => {
    await service.createMapping(session(), {
      ...CREATE,
      canonicalCode: 'HBA1C',
      externalCode: '4548-4',
    });
    const raw = await db
      .query(
        `INSERT INTO sdis.terminology_mappings (canonical_code, external_system, external_code, facility_id)
             VALUES ($1, $2, $3, $4)`,
        ['HBA1C', 'loinc', '4548-4', FACILITY],
      )
      .catch((error: { code?: string }) => error);
    assert.equal((raw as { code?: string }).code, '23505');
  });

  it('rejects duplicate creation as CONFLICT at the service boundary', async () => {
    await assert.rejects(
      () =>
        service.createMapping(session(), {
          ...CREATE,
          canonicalCode: 'HBA1C',
          externalCode: '4548-4',
        }),
      ConflictError,
    );
  });

  it('keeps facility boundaries: another facility cannot read the mapping', async () => {
    const dto = await service.createMapping(session(), {
      ...CREATE,
      canonicalCode: 'CREAT',
      externalCode: '2160-0',
    });
    await assert.rejects(
      () => service.getMapping(session(OTHER_FACILITY), dto.id as never),
      NotFoundError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () => service.createMapping(session(FACILITY, OTHER_ORG), CREATE),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('persists audit events for mapping creation', async () => {
    const dto = await service.createMapping(session(), {
      ...CREATE,
      canonicalCode: 'URIC',
      externalCode: '3084-1',
    });
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'terminology-mapping' AND object_id = $1`,
      [dto.id],
    );
    assert.equal(audit.rows[0]?.count, '1');
  });

  it('replays durably via the Postgres idempotency store without duplicate audit', async () => {
    const { PostgresIdempotencyStore, PostgresAuditPort } =
      await import('../../src/infrastructure/database/repositories');
    const durable = new TerminologyPersistenceService({
      mappings: repo,
      facilities: new PostgresFacilityDirectory(db),
      audit: new PostgresAuditPort(db),
      idempotency: new PostgresIdempotencyStore(db),
    });
    const payload = {
      ...CREATE,
      canonicalCode: 'TSH',
      externalCode: '3016-3',
      idempotencyKey: 'term-durable-replay-1',
    };
    const first = await durable.createMapping(session(), payload);
    const replay = await durable.createMapping(session(), payload);
    assert.equal(replay.id, first.id);
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.terminology_mappings WHERE id = $1',
      [first.id],
    );
    assert.equal(rows.rows[0]?.count, '1');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'terminology-mapping' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1');
  });
});

/**
 * Master setup configuration — disposable PostgreSQL tests (Step 15).
 *
 * Proves migration 013 from an empty database, append-only versioned
 * persistence (history preserved, nothing overwritten), schema-enforced scope
 * uniqueness, department reference validation, facility/tenant isolation, and
 * durable Postgres idempotency replay without duplicate rows or audit events.
 *
 * SQL is used as evidence of persistence, never as the contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { ConflictError, NotFoundError, ValidationError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import type { DepartmentId, SetupConfigId } from '../../src/types/ids';

const PORT = 55450;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';
/** Seeded synthetic departments of FACILITY (db/seeds/001_dev_seed.sql). */
const DEPT = '00000000-0000-4000-8000-000000000021';
const SIBLING_DEPT = '00000000-0000-4000-8000-000000000022';
/** Synthetic department belonging to ANOTHER facility (created in-test). */
const FOREIGN_DEPT = '00000000-0000-4000-8000-0000000000d9';
const UNKNOWN_DEPT = '00000000-0000-4000-8000-0000000000e9';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'setup-admin' },
    userId: 'setup-admin',
    roles: ['manager'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
});

after(async () => {
  await teardownTestDatabase();
});

let keyCounter = 0;
function nextKey(prefix = 'setting'): string {
  keyCounter += 1;
  return `${prefix}.pg${keyCounter}`;
}

describe('setup postgres: migration and versioned persistence', () => {
  it('migration 013 created the table with RLS and append-only privileges', async () => {
    const reg = await db.query(`SELECT to_regclass('sdis.setup_config') AS reg`);
    assert.ok(reg.rows[0]?.reg, 'setup_config must exist');
    const policy = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy WHERE polrelid = 'sdis.setup_config'::regclass`,
    );
    assert.ok((policy.rowCount ?? 0) >= 2, 'tenant + facility RLS policies must exist');
    const grants = await db.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE table_schema = 'sdis' AND table_name = 'setup_config'
           AND grantee = 'sdis_app'`,
    );
    const privileges = grants.rows.map((row) => row.privilege_type);
    assert.ok(privileges.includes('SELECT') && privileges.includes('INSERT'));
    assert.ok(
      !privileges.includes('UPDATE'),
      'no UPDATE grant: versions are append-only',
    );
    assert.ok(!privileges.includes('DELETE'), 'no DELETE grant: history is preserved');
  });

  it('persists version 1 and appends version 2 without losing history', async () => {
    const key = nextKey('worklist');
    const v1 = await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key,
      value: { size: 25 },
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    assert.equal(v1.version, 1);

    const v2 = await runtime.setup.updateConfig(session(), {
      family: 'FACILITY',
      key,
      value: { size: 50 },
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
    });
    assert.equal(v2.version, 2);

    const rows = await db.query<{ version: number; value: { size: number } }>(
      `SELECT version, value FROM sdis.setup_config
         WHERE facility_id = $1 AND family = 'FACILITY' AND key = $2
         ORDER BY version`,
      [FACILITY, key],
    );
    assert.equal(rows.rowCount, 2, 'both versions must remain persisted');
    assert.equal(rows.rows[0]?.version, 1);
    assert.equal(rows.rows[0]?.value.size, 25);
    assert.equal(rows.rows[1]?.value.size, 50);

    // The latest read wins and the older version stays addressable by id.
    const latest = await runtime.setup.getConfig(session(), { family: 'FACILITY', key });
    assert.equal(latest.version, 2);
    const history = await runtime.setup.getConfigById(session(), v1.id as SetupConfigId);
    assert.equal(history.version, 1);
  });

  it('enforces scope uniqueness at the schema level (no silent overwrite)', async () => {
    const key = nextKey('unique');
    await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key,
      value: 'first',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    await assert.rejects(
      () =>
        runtime.setup.createConfig(session(), {
          family: 'FACILITY',
          key,
          value: 'second',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
        }),
      ConflictError,
    );
    const rows = await db.query(
      `SELECT count(*)::int AS n FROM sdis.setup_config
         WHERE facility_id = $1 AND key = $2`,
      [FACILITY, key],
    );
    assert.equal(rows.rows[0]?.n, 1);
  });

  it('validates department references against the owning facility', async () => {
    const inScope = await runtime.setup.createConfig(session(), {
      family: 'DEPARTMENT',
      key: nextKey('bench'),
      value: 'Bench A',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: DEPT as DepartmentId,
    });
    assert.equal(inScope.departmentId, DEPT);
    const row = await db.query<{ department_id: string; family: string }>(
      `SELECT department_id, family FROM sdis.setup_config WHERE id = $1`,
      [inScope.id],
    );
    assert.equal(row.rows[0]?.department_id, DEPT);

    // A sibling department of the SAME facility is valid.
    await runtime.setup.createConfig(session(), {
      family: 'DEPARTMENT',
      key: nextKey('bench'),
      value: 'Bench B',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      departmentId: SIBLING_DEPT as DepartmentId,
    });

    // A REAL department of ANOTHER facility must not be attachable.
    await db.query(
      `INSERT INTO sdis.departments (id, facility_id, name, code, modalities)
       VALUES ($1, $2, 'Synthetic Other Facility Dept', 'SOD', ARRAY['LAB'])
       ON CONFLICT (id) DO NOTHING`,
      [FOREIGN_DEPT, OTHER_FACILITY],
    );
    await assert.rejects(
      () =>
        runtime.setup.createConfig(session(), {
          family: 'DEPARTMENT',
          key: nextKey('bench'),
          value: 'Bench C',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: FOREIGN_DEPT as DepartmentId,
        }),
      NotFoundError,
    );
    // An unknown department is rejected the same way (no existence leak).
    await assert.rejects(
      () =>
        runtime.setup.createConfig(session(), {
          family: 'DEPARTMENT',
          key: nextKey('bench'),
          value: 'Bench D',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: UNKNOWN_DEPT as DepartmentId,
        }),
      NotFoundError,
    );
    // Facility settings must not carry a department scope.
    await assert.rejects(
      () =>
        runtime.setup.createConfig(session(), {
          family: 'FACILITY',
          key: nextKey('facility'),
          value: 'x',
          effectiveFrom: '2026-09-21T00:00:00.000Z',
          departmentId: DEPT as DepartmentId,
        }),
      ValidationError,
    );
  });
});

describe('setup postgres: isolation, idempotency, and audit', () => {
  it('keeps facility boundaries: another facility cannot read the configuration', async () => {
    const key = nextKey('isolated');
    const created = await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key,
      value: 1,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    await assert.rejects(
      () =>
        runtime.setup.getConfigById(session(OTHER_FACILITY), created.id as SetupConfigId),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        runtime.setup.getConfig(session(OTHER_FACILITY), {
          family: 'FACILITY',
          key,
        }),
      NotFoundError,
    );
    assert.equal((await runtime.setup.listApplicable(session(OTHER_FACILITY))).length, 0);
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () =>
        runtime.setup.createConfig(session(FACILITY, OTHER_ORG), {
          family: 'FACILITY',
          key: nextKey('forged'),
          value: 1,
          effectiveFrom: '2026-09-21T00:00:00.000Z',
        }),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'SCOPE_MISMATCH');
        return true;
      },
    );
  });

  it('replays a keyed creation durably — one version row, one audit event', async () => {
    const key = nextKey('replay');
    const input = {
      family: 'FACILITY' as const,
      key,
      value: 'idempotent-value',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
      idempotencyKey: 'pg-setup-1',
    };
    const first = await runtime.setup.createConfig(session(), input);
    const second = await runtime.setup.createConfig(session(), input);
    assert.equal(second.id, first.id);

    const rows = await db.query(
      `SELECT id FROM sdis.setup_config WHERE facility_id = $1 AND key = $2`,
      [FACILITY, key],
    );
    assert.equal(rows.rowCount, 1);
    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM sdis.audit_events
         WHERE object_type = 'setup-config' AND object_id = $1`,
      [first.id],
    );
    assert.equal(Number(audit.rows[0]?.n), 1, 'no duplicate audit on replay');
  });

  it('audits configuration changes without recording values', async () => {
    const key = nextKey('audited');
    const created = await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key,
      value: 'non-secret-operational-value',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    await runtime.setup.updateConfig(session(), {
      family: 'FACILITY',
      key,
      value: 'non-secret-updated-value',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      expectedVersion: 1,
    });
    const audits = await db.query<{ action: string; detail: string | null }>(
      `SELECT action, detail FROM sdis.audit_events
         WHERE object_type = 'setup-config'
           AND detail LIKE $1
         ORDER BY at`,
      [`FACILITY key=${key}%`],
    );
    assert.deepEqual(
      audits.rows.map((row) => row.action),
      ['CREATED', 'UPDATED'],
    );
    for (const row of audits.rows) {
      assert.ok(!/non-secret-(operational|updated)-value/.test(row.detail ?? ''));
    }
    assert.ok(created.id);
  });
});

/**
 * Department master data & configuration — disposable PostgreSQL tests
 * (Step 24).
 *
 * Proves migration 021 (status lifecycle column), the department
 * administration boundary over the REAL `sdis.departments` table, per-facility
 * code uniqueness at the schema level, facility/tenant scope isolation,
 * versioned configuration persistence with typed registry keys, and the
 * historical-integrity invariant: configuration/master-data changes leave
 * finalized clinical records untouched. SQL is evidence, never the contract.
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
import type { DepartmentId } from '../../src/types/ids';
import { toBrandedId } from '../../src/types/ids';

const PORT = 55460;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';

/** Seeded synthetic departments of FACILITY (db/seeds/001_dev_seed.sql). */
const SEED_CLAB = '00000000-0000-4000-8000-000000000021';

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

describe('departments postgres: migration 021 and persistence', () => {
  it('migration 021 added the status column with the lifecycle constraint', async () => {
    const column = await db.query(
      `SELECT column_name, column_default FROM information_schema.columns
        WHERE table_schema = 'sdis' AND table_name = 'departments'
          AND column_name = 'status'`,
    );
    assert.equal(column.rowCount, 1);
    assert.match(column.rows[0]!.column_default ?? '', /ACTIVE/);

    const check = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'sdis.departments'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%INACTIVE%'`,
    );
    assert.ok((check.rowCount ?? 0) >= 1, 'status CHECK constraint must exist');
  });

  it('creates a department through the runtime and reads it back', async () => {
    const created = await runtime.departments.createDepartment(session(), {
      name: 'Molecular Diagnostics',
      code: 'MOLDX01',
      modalities: ['LAB'],
    });
    assert.ok(created.id);
    assert.equal(created.facilityId, FACILITY);
    assert.equal(created.status, 'ACTIVE');

    const fetched = await runtime.departments.getDepartment(
      session(),
      toBrandedId(created.id),
    );
    assert.equal(fetched.code, 'MOLDX01');
  });

  it('enforces per-facility code uniqueness and rejects foreign codes with 409', async () => {
    await runtime.departments.createDepartment(session(), {
      name: 'Cytogenetics',
      code: 'CYTO01',
    });
    await assert.rejects(
      () =>
        runtime.departments.createDepartment(session(), {
          name: 'Duplicate',
          code: 'CYTO01',
        }),
      ConflictError,
    );
    // Seeded code of the SAME facility cannot be re-registered either.
    await assert.rejects(
      () =>
        runtime.departments.createDepartment(session(), {
          name: 'Re-seed',
          code: 'CLAB',
        }),
      ConflictError,
    );
  });

  it('deactivates through the runtime without deleting the row (SQL evidence)', async () => {
    const created = await runtime.departments.createDepartment(session(), {
      name: 'Phlebotomy',
      code: 'PHLEB01',
    });
    const deactivated = await runtime.departments.deactivateDepartment(
      session(),
      toBrandedId(created.id),
    );
    assert.equal(deactivated.status, 'INACTIVE');

    const row = await db.query<{ status: string }>(
      `SELECT status FROM sdis.departments WHERE id = $1`,
      [created.id],
    );
    assert.equal(row.rows[0]!.status, 'INACTIVE');
    await assert.rejects(
      () =>
        runtime.departments.createDepartment(session(), {
          name: 'Recycled',
          code: 'PHLEB01',
        }),
      ConflictError,
    );
  });
});

describe('departments postgres: scope isolation', () => {
  it('never exposes another facility department (read, deactivate, list)', async () => {
    const otherSession = session(OTHER_FACILITY);
    const foreign = await runtime.departments.createDepartment(otherSession, {
      name: 'Away Dept',
      code: 'AWAY24',
    });

    await assert.rejects(
      () => runtime.departments.getDepartment(session(), toBrandedId(foreign.id)),
      NotFoundError,
    );
    await assert.rejects(
      () => runtime.departments.deactivateDepartment(session(), toBrandedId(foreign.id)),
      NotFoundError,
    );
    const listed = await runtime.departments.listDepartments(session());
    assert.ok(!listed.some((d) => d.code === 'AWAY24'));
  });

  it('rejects invalid department input before persistence (422, DB unchanged)', async () => {
    await assert.rejects(
      () =>
        runtime.departments.createDepartment(session(), {
          name: '',
          code: 'BAD01',
        }),
      ValidationError,
    );
    const rows = await db.query(`SELECT id FROM sdis.departments WHERE code = 'BAD01'`);
    assert.equal(rows.rowCount, 0);
  });
});

describe('configuration postgres: registry keys and worklist consumption', () => {
  it('persists a registered key and drives the runtime worklist page size', async () => {
    await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
      value: 3,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    const read = await runtime.setup.getConfig(session(), {
      family: 'FACILITY',
      key: 'worklist.defaultPageSize',
    });
    assert.equal(read.value, 3);

    const worklist = await runtime.worklist.listForSession(session());
    assert.ok(worklist.length <= 3);
  });

  it('keeps configuration facility-scoped across tenants and facilities', async () => {
    const key = 'worklist.includeHistory';
    await runtime.setup.createConfig(session(), {
      family: 'FACILITY',
      key,
      value: true,
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    });
    // Another facility reads its OWN (absent) configuration, not facility 11's.
    await assert.rejects(
      () =>
        runtime.setup.getConfig(session(OTHER_FACILITY), {
          family: 'FACILITY',
          key,
        }),
      NotFoundError,
    );
  });
});

describe('historical integrity over PostgreSQL', () => {
  it('configuration and department changes leave a finalized report untouched', async () => {
    const admin = session();
    const order = await runtime.orders.createOrder(admin, {
      patientId: toBrandedId('00000000-0000-4000-8000-0000000000e1'),
      encounterId: toBrandedId('00000000-0000-4000-8000-0000000000c1'),
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: '2026-09-21T08:00:00.000Z',
    });
    // Verification gate (Step 28): walk to VERIFIED before finalizing.
    // (No specimen is collected in this test, so ACQUIRED is explicit.)
    await runtime.orders.transitionOrder(
      admin,
      toBrandedId(order.id),
      'ACQUIRED',
      '2026-09-21T08:01:00.000Z',
    );
    await runtime.orders.transitionOrder(
      admin,
      toBrandedId(order.id),
      'PROCESSING',
      '2026-09-21T08:02:00.000Z',
    );
    await runtime.orders.transitionOrder(
      admin,
      toBrandedId(order.id),
      'RESULT_ENTERED',
      '2026-09-21T08:03:00.000Z',
    );
    await runtime.orders.transitionOrder(
      admin,
      toBrandedId(order.id),
      'VERIFIED',
      '2026-09-21T08:04:00.000Z',
    );
    const report = await runtime.reports.createReport(admin, {
      orderId: toBrandedId(order.id),
      content: 'Final synthetic impression.',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: '2026-09-21T08:10:00.000Z',
    });
    const finalized = await runtime.reports.finalizeReport(
      admin,
      report.id as never,
      'Dr. Synthetic',
      '2026-09-21T08:20:00.000Z',
    );

    await runtime.setup.createConfig(admin, {
      family: 'DEPARTMENT',
      key: 'worklist.defaultPageSize',
      value: 7,
      effectiveFrom: '2026-09-21T09:00:00.000Z',
      departmentId: toBrandedId('00000000-0000-4000-8000-000000000022'),
    });
    await runtime.departments.createDepartment(admin, {
      name: 'Post-Finalization Dept',
      code: 'POST24',
    });
    await runtime.departments.deactivateDepartment(admin, toBrandedId(SEED_CLAB));

    const reread = await runtime.reports.getReport(admin, finalized.id as never);
    assert.equal(reread.latestStatus, 'FINALIZED');
    const head = reread.versions[reread.versions.length - 1]!;
    assert.equal(head.content, 'Final synthetic impression.');

    // The deactivated seeded department is still resolvable for history.
    const clab = await runtime.departments.getDepartment(admin, toBrandedId(SEED_CLAB));
    assert.equal(clab.status, 'INACTIVE');
    assert.equal(clab.code, 'CLAB');
  });
});

/**
 * Step 27 — Laboratory workflow completion over disposable PostgreSQL.
 *
 * Proves migrations 022/023 from a real database: specimen accession numbers
 * (assignment at RECEIVED, immutable, persisted), rejection reasons (bounded
 * vocabulary, history preserved, required at the boundary), quality records
 * with the analytical-hold boundary (a hold pauses finalization; releasing it
 * unblocks; manager-tier authorization; facility isolation). SQL is evidence,
 * never the contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId } from '../../src/types/ids';

const PORT = 55470;
const ORG = '00000000-0000-4000-8000-000000000001';
const FACILITY = '00000000-0000-4000-8000-000000000011';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';

function session(): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'lab-admin' },
    userId: 'lab-admin',
    roles: ['manager'] as never,
    organizationId: ORG as never,
    facilityId: FACILITY as never,
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

/** Creates an order + collected specimen and returns both DTOs. */
async function collectedSpecimen(
  testCode: string,
  hour: number,
  kind: 'BLOOD' | 'SERUM' | 'URINE' = 'BLOOD',
) {
  const order = await runtime.orders.createOrder(session(), {
    patientId: toBrandedId(PATIENT),
    encounterId: toBrandedId(ENCOUNTER),
    modality: 'LAB',
    items: [{ testCode, codeSystem: 'sdis' }],
    orderedAt: `2026-09-23T${String(hour).padStart(2, '0')}:00:00.000Z`,
  });
  const specimen = await runtime.specimens.collectSpecimen(session(), {
    orderItemId: toBrandedId(order.items[0]!.id),
    patientId: toBrandedId(PATIENT),
    kind,
    collectedAt: `2026-09-23T${String(hour).padStart(2, '0')}:05:00.000Z`,
  });
  return { order, specimen };
}

describe('specimen accessioning over PostgreSQL (Step 27)', () => {
  it('migration 022 added the accession and rejection columns with constraints', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'sdis' AND table_name = 'specimens'
          AND column_name IN ('accession_number', 'rejection_reason')`,
    );
    assert.equal(columns.rowCount, 2);
    const index = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'sdis' AND indexname = 'uq_specimens_accession_global'`,
    );
    assert.equal(index.rowCount, 1);
    const check = await db.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'sdis.specimens'::regclass
          AND conname = 'ck_specimens_rejection_consistency'`,
    );
    assert.equal(check.rowCount, 1);
  });

  it('accessions a specimen at RECEIVED and persists the number', async () => {
    const { order, specimen } = await collectedSpecimen('CBC', 8);
    void order;
    const received = await runtime.specimens.transitionSpecimen(
      session(),
      toBrandedId(specimen.id),
      'RECEIVED',
      '2026-09-23T08:10:00.000Z',
    );
    assert.ok(received.accessionNumber);

    const row = await db.query<{ accession_number: string; status: string }>(
      `SELECT accession_number, status FROM sdis.specimens WHERE id = $1`,
      [specimen.id],
    );
    assert.equal(row.rows[0]!.status, 'RECEIVED');
    assert.equal(row.rows[0]!.accession_number, received.accessionNumber);
  });

  it('rejection persists the bounded reason and retains the record (no deletion)', async () => {
    const { specimen } = await collectedSpecimen('LFT', 9, 'SERUM');
    await runtime.specimens.transitionSpecimen(
      session(),
      toBrandedId(specimen.id),
      'RECEIVED',
      '2026-09-23T09:10:00.000Z',
    );
    const rejected = await runtime.specimens.transitionSpecimen(
      session(),
      toBrandedId(specimen.id),
      'REJECTED',
      '2026-09-23T09:15:00.000Z',
      { rejectionReason: 'INSUFFICIENT_SPECIMEN' },
    );
    assert.equal(rejected.rejectionReason, 'INSUFFICIENT_SPECIMEN');

    const row = await db.query<{ status: string; rejection_reason: string }>(
      `SELECT status, rejection_reason FROM sdis.specimens WHERE id = $1`,
      [specimen.id],
    );
    assert.equal(row.rows[0]!.status, 'REJECTED');
    assert.equal(row.rows[0]!.rejection_reason, 'INSUFFICIENT_SPECIMEN');
  });

  it('rejects a rejection without a reason at the application boundary', async () => {
    const { specimen } = await collectedSpecimen('CBC', 11);
    await runtime.specimens.transitionSpecimen(
      session(),
      toBrandedId(specimen.id),
      'RECEIVED',
      '2026-09-23T11:10:00.000Z',
    );
    await assert.rejects(
      () =>
        runtime.specimens.transitionSpecimen(
          session(),
          toBrandedId(specimen.id),
          'REJECTED',
          '2026-09-23T11:15:00.000Z',
        ),
      ValidationError,
    );
  });

  it('the database CHECK rejects a reason on a non-rejected specimen', async () => {
    await assert.rejects(
      () =>
        db.query(
          `UPDATE sdis.specimens SET rejection_reason = 'DAMAGED_SPECIMEN'
            WHERE status <> 'REJECTED'`,
        ),
      (error: unknown) =>
        error instanceof Error &&
        /ck_specimens_rejection_consistency/.test(error.message),
    );
  });
});

describe('quality records over PostgreSQL (Step 27)', () => {
  it('migration 023 created the table with RLS policies and the active-hold index', async () => {
    const table = await db.query(`SELECT to_regclass('sdis.quality_records') AS reg`);
    assert.ok(table.rows[0]?.reg);
    const policies = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy
        WHERE polrelid = 'sdis.quality_records'::regclass`,
    );
    assert.ok((policies.rowCount ?? 0) >= 2);
    const index = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'sdis' AND indexname = 'uq_quality_records_active_hold'`,
    );
    assert.equal(index.rowCount, 1);
  });

  it('an active hold pauses finalization; releasing it unblocks', async () => {
    const order = await runtime.orders.createOrder(session(), {
      patientId: toBrandedId(PATIENT),
      encounterId: toBrandedId(ENCOUNTER),
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: '2026-09-23T12:00:00.000Z',
    });
    // Verification gate (Step 28): walk to VERIFIED before finalizing.
    // (No specimen is collected in this test, so ACQUIRED is explicit.)
    await runtime.orders.transitionOrder(
      session(),
      toBrandedId(order.id),
      'ACQUIRED',
      '2026-09-23T12:01:00.000Z',
    );
    await runtime.orders.transitionOrder(
      session(),
      toBrandedId(order.id),
      'PROCESSING',
      '2026-09-23T12:02:00.000Z',
    );
    await runtime.orders.transitionOrder(
      session(),
      toBrandedId(order.id),
      'RESULT_ENTERED',
      '2026-09-23T12:03:00.000Z',
    );
    await runtime.orders.transitionOrder(
      session(),
      toBrandedId(order.id),
      'VERIFIED',
      '2026-09-23T12:04:00.000Z',
    );
    const report = await runtime.reports.createReport(session(), {
      orderId: toBrandedId(order.id),
      content: 'Hold-boundary synthetic report.',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: '2026-09-23T12:10:00.000Z',
    });

    await runtime.quality.recordQuality(session(), {
      family: 'IQC',
      referenceType: 'analyzer-1',
      at: '2026-09-23T12:15:00.000Z',
      hold: { reason: 'IQC failure — hold analytical release' },
    });
    await assert.rejects(
      () =>
        runtime.reports.finalizeReport(
          session(),
          toBrandedId(report.id),
          'Dr. Synthetic',
          '2026-09-23T12:20:00.000Z',
        ),
      ConflictError,
    );

    // Release (the hold id is the record id) — finalization proceeds.
    const records = await runtime.quality.listQuality(session());
    const heldRecord = records.find((r) => r.hold && !r.hold.releasedAt);
    assert.ok(heldRecord);
    await runtime.quality.releaseHold(session(), {
      holdId: heldRecord.id,
      at: '2026-09-23T12:25:00.000Z',
    });
    await assert.doesNotReject(() =>
      runtime.reports.finalizeReport(
        session(),
        toBrandedId(report.id),
        'Dr. Synthetic',
        '2026-09-23T12:30:00.000Z',
      ),
    );
  });

  it('quality records require the manager tier (fail closed)', async () => {
    const operator = { ...session(), roles: ['operator', 'viewer'] as never };
    await assert.rejects(
      () =>
        runtime.quality.recordQuality(operator, {
          family: 'QC',
          referenceType: 'analyzer-1',
          at: '2026-09-23T13:00:00.000Z',
        }),
      ForbiddenError,
    );
  });

  it('quality records are invisible across facilities (RLS)', async () => {
    const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
    const foreign = {
      ...session(),
      facilityId: OTHER_FACILITY as never,
    };
    // Same organization (scope check passes), but RLS narrows every row to
    // the caller's facility: the foreign session sees NOTHING of facility 11's
    // records — isolation is by empty result, never by error leakage.
    const foreignRecords = await runtime.quality.listQuality(foreign);
    assert.equal(foreignRecords.length, 0);
    const ownRecords = await runtime.quality.listQuality(session());
    assert.ok(ownRecords.length > 0);
  });
});

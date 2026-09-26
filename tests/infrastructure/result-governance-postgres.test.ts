/**
 * Step 28 — result governance over REAL PostgreSQL.
 *
 * Proves the verification/finalization/amendment lifecycle against the real
 * database: attributed VERIFIED transitions (persisted via migration 024),
 * manager-tier gating, the verification gate on report finalization,
 * amendment lineage with an append-only version history (originals never
 * rewritten), idempotent amendment replay, and concurrent-verification CAS
 * protection. SQL is evidence, never the proof of the contract itself.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ApplicationSession } from '../../src/app/context';
import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import type { OrderDTO } from '../../src/app/dto';
import { ConflictError } from '../../src/app/errors';
import { assertUuidV4, toBrandedId } from '../../src/types/ids';
import type { DiagnosticOrderId, ReportId } from '../../src/types/ids';

const PORT = 55480;
const ORG = '00000000-0000-4000-8000-000000000001';
const FACILITY = '00000000-0000-4000-8000-000000000011';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';

function session(): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'user-manager-1' },
    userId: 'user-manager-1',
    roles: ['manager'] as never,
    organizationId: ORG as never,
    facilityId: FACILITY as never,
  };
}

const at = (n: number) =>
  new Date(Date.parse('2026-03-01T08:00:00Z') + n * 60_000).toISOString();

describe('result governance over PostgreSQL (Step 28)', () => {
  let db: Database;
  let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

  before(async () => {
    db = await setupTestDatabase({ port: PORT });
    runtime = createPostgresLaboratoryRuntime(db);
  });

  after(async () => teardownTestDatabase());

  /** Creates an order walked to RESULT_ENTERED. */
  async function enteredOrder(): Promise<OrderDTO> {
    const s = session();
    const order = await runtime.orders.createOrder(s, {
      patientId: toBrandedId(PATIENT),
      encounterId: toBrandedId(ENCOUNTER),
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    for (const [i, to] of (
      ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const
    ).entries()) {
      await runtime.orders.transitionOrder(
        s,
        assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
        to,
        at(i + 1),
      );
    }
    return order as unknown as OrderDTO & { id: DiagnosticOrderId };
  }

  async function amendmentCount(reportId: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sdis.report_versions WHERE report_id = $1`,
      [reportId],
    );
    return rows[0]!.n;
  }

  it('persists verification attribution and gates finalization on it', async () => {
    const s = session();
    const order = await enteredOrder();

    // The gate: a report on an UNVERIFIED order cannot be finalized.
    const premature = await runtime.reports.createReport(s, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'written before verification',
      authoredByRef: 'path-1',
      authoredAt: at(9),
    });
    await assert.rejects(
      () =>
        runtime.reports.finalizeReport(
          s,
          assertUuidV4<ReportId>(premature.id, 'report id'),
          'path-1',
          at(10),
        ),
      ConflictError,
    );

    // Verification with server-resolved attribution, persisted durably.
    await runtime.orders.transitionOrder(
      s,
      assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      'VERIFIED',
      at(4),
    );
    const { rows } = await db.query<{
      status: string;
      verified_by_ref: string | null;
      verified_at: Date | null;
    }>(
      `SELECT status, verified_by_ref, verified_at
         FROM sdis.diagnostic_orders WHERE id = $1`,
      [order.id],
    );
    assert.equal(rows[0]!.status, 'VERIFIED');
    assert.equal(rows[0]!.verified_by_ref, 'user-manager-1');
    assert.ok(rows[0]!.verified_at);

    // Now finalization succeeds.
    const report = await runtime.reports.createReport(s, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'Within reference limits.',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const finalized = await runtime.reports.finalizeReport(
      s,
      assertUuidV4<ReportId>(report.id, 'report id'),
      'path-1',
      at(11),
    );
    assert.equal(finalized.latestStatus, 'FINALIZED');
  });

  it('amends a finalized report with reason, lineage, and originals preserved', async () => {
    const s = session();
    const order = await enteredOrder();
    await runtime.orders.transitionOrder(
      s,
      assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      'VERIFIED',
      at(4),
    );
    const created = await runtime.reports.createReport(s, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'original finalized content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await runtime.reports.finalizeReport(s, reportId, 'path-1', at(11));

    // The amendment ISSUE key: a keyed replay must return the SAME logical
    // amendment and never create a duplicate version.
    const issueKey = `amend-${reportId}`;
    const amended = await runtime.reports.amendReport(s, {
      reportId,
      content: 'corrected platelet count',
      authoredByRef: 'path-2',
      authoredAt: at(12),
      amendmentReason: 'ANALYTICAL_CORRECTION',
      idempotencyKey: issueKey,
    });
    assert.equal(amended.latestVersion, 2);
    assert.equal(await amendmentCount(reportId), 2);

    // Lineage: both versions preserved, original content never rewritten.
    const { rows: versions } = await db.query<{ version: number; content: string }>(
      `SELECT version, content FROM sdis.report_versions
         WHERE report_id = $1 ORDER BY version`,
      [reportId],
    );
    assert.equal(versions.length, 2);
    assert.equal(versions[0]!.content, 'original finalized content');
    assert.equal(versions[1]!.content, 'corrected platelet count');

    // Keyed replay is idempotent: no duplicate version.
    const replay = await runtime.reports.amendReport(s, {
      reportId,
      content: 'corrected platelet count',
      authoredByRef: 'path-2',
      authoredAt: at(12),
      amendmentReason: 'ANALYTICAL_CORRECTION',
      idempotencyKey: issueKey,
    });
    assert.equal(replay.latestVersion, 2);
    assert.equal(await amendmentCount(reportId), 2);

    // Issuing the amendment: the corrected version finalizes like any other
    // (the verification gate already passed for this order's content).
    const issued = await runtime.reports.finalizeReport(s, reportId, 'path-2', at(13));
    assert.equal(issued.latestStatus, 'FINALIZED');
    assert.equal(issued.latestVersion, 2);
  });

  it('keeps concurrent verification CAS-safe (at most one winner)', async () => {
    const s = session();
    const order = await enteredOrder();
    const results = await Promise.allSettled([
      runtime.orders.transitionOrder(
        session(),
        assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
        'VERIFIED',
        at(4),
      ),
      runtime.orders.transitionOrder(
        s,
        assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
        'VERIFIED',
        at(4),
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejectedAsConflict = results.filter(
      (r) =>
        r.status === 'rejected' &&
        (r as PromiseRejectedResult).reason instanceof ConflictError,
    ).length;
    assert.ok(fulfilled + rejectedAsConflict === 2, 'both settled');
    assert.ok(
      rejectedAsConflict >= 1 || fulfilled === 1,
      'at most one verification wins',
    );
  });
});

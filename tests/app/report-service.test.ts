/**
 * Application tests: report service (creation, finalization, amendment).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUuidV4 } from '../../src/types/ids';
import type { DiagnosticOrderId, ReportId } from '../../src/types/ids';
import { ConflictError, NotFoundError, ScopeMismatchError } from '../../src/app/errors';
import {
  at,
  auditCountFor,
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  type LabFixture,
} from './helpers';
import type { OrderDTO } from '../../src/app/dto';
import type { ApplicationSession } from '../../src/app/context';

/** Manager-tier session (Step 28): amendments are an administrative act. */
function managerSession(fx: LabFixture): ApplicationSession {
  const session = fx.session;
  (session as { roles?: readonly string[] }).roles = [
    'manager',
    'operator',
    'viewer',
  ] as never;
  return session;
}

async function createOrder(fx: LabFixture): Promise<OrderDTO> {
  return fx.orders.createOrder(fx.session, {
    patientId: fx.patientId,
    encounterId: fx.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(0),
  });
}

/**
 * Walks an order through PROCESSING → RESULT_ENTERED → VERIFIED (Step 28:
 * reports finalize only after diagnostic content is verified). The VERIFIED
 * step requires the manager tier.
 */
async function verifyOrder(fx: LabFixture, orderId: string): Promise<void> {
  const id = assertUuidV4<DiagnosticOrderId>(orderId, 'order id');
  await fx.orders.transitionOrder(fx.session, id, 'ACQUIRED', at(1));
  await fx.orders.transitionOrder(fx.session, id, 'PROCESSING', at(2));
  await fx.orders.transitionOrder(fx.session, id, 'RESULT_ENTERED', at(3));
  const verifier = fx.session;
  (verifier as { roles?: readonly string[] }).roles = [
    'manager',
    'operator',
    'viewer',
  ] as never;
  await fx.orders.transitionOrder(verifier, id, 'VERIFIED', at(4));
}

/** Staff-claimed session: reaches the application scope checks under RBAC. */
function withOperator(session: ReturnType<typeof sessionFor>) {
  (session as { roles?: readonly string[] }).roles = ['operator'] as never;
  return session;
}

describe('app: report lifecycle', () => {
  it('creates a draft report bound to the order, patient, and facility', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'CBC within expected pattern',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    assert.equal(created.orderId, order.id);
    assert.equal(created.patientId, fx.patientId);
    assert.equal(created.latestStatus, 'DRAFT');
    assert.equal(created.latestVersion, 1);
    assert.equal(auditCountFor(fx, created.id, 'CREATED'), 1);
  });

  it('finalizes the report and rejects silent re-finalization', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'CBC within expected pattern',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    const finalized = await fx.reports.finalizeReport(
      fx.session,
      reportId,
      'path-1',
      at(11),
    );
    assert.equal(finalized.latestStatus, 'FINALIZED');
    assert.equal(auditCountFor(fx, created.id, 'FINALIZED'), 1);

    await assert.rejects(
      () => fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(12)),
      ConflictError,
    );
  });

  it('amends a finalized report as a new superseding version', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'original content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));
    const amended = await fx.reports.amendReport(managerSession(fx), {
      reportId,
      content: 'corrected content',
      authoredByRef: 'path-1',
      authoredAt: at(12),
      amendmentReason: 'TRANSCRIPTION_CORRECTION',
    });
    assert.equal(amended.latestVersion, 2);
    assert.equal(amended.latestStatus, 'DRAFT');
    assert.equal(amended.versions[0]?.content, 'original content');
    assert.equal(amended.versions[1]?.content, 'corrected content');
    assert.equal(amended.versions[1]?.supersedesVersionId, amended.versions[0]?.id);
    assert.equal(auditCountFor(fx, created.id, 'AMENDED'), 1);
  });

  it('rejects a report for an unknown order', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.reports.createReport(fx.session, {
          orderId: assertUuidV4<DiagnosticOrderId>(
            '00000000-0000-4000-8000-00000000ffff',
            'order id',
          ),
          content: 'content',
          authoredByRef: 'path-1',
          authoredAt: at(10),
        }),
      NotFoundError,
    );
  });

  it('rejects reading a report through another facility session', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    await assert.rejects(
      () =>
        fx.reports.getReport(
          withOperator(sessionFor(OTHER_FACILITY)),
          assertUuidV4<ReportId>(created.id, 'report id'),
        ),
      ScopeMismatchError,
    );
  });

  it('replays an idempotency key without duplicating the report', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const input = {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
      idempotencyKey: 'req-report-1',
    };
    const first = await fx.reports.createReport(fx.session, input);
    const second = await fx.reports.createReport(fx.session, input);
    assert.equal(first.id, second.id);
    assert.equal(auditCountFor(fx, first.id, 'CREATED'), 1);
  });

  it('LAB-01 regression: keyed finalize replay returns the stored result instead of a false CONFLICT', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');

    const first = await fx.reports.finalizeReport(
      fx.session,
      reportId,
      'path-1',
      at(11),
      {
        idempotencyKey: 'lab-01-finalize-1',
      },
    );
    const replay = await fx.reports.finalizeReport(
      fx.session,
      reportId,
      'path-1',
      at(11),
      {
        idempotencyKey: 'lab-01-finalize-1',
      },
    );
    assert.equal(replay.id, first.id);
    assert.equal(replay.latestStatus, 'FINALIZED');
    assert.equal(auditCountFor(fx, reportId, 'FINALIZED'), 1);

    // A DIFFERENT (unkeyed-equivalent) request still surfaces the domain
    // CONFLICT — the idempotency scope does not weaken immutability.
    await assert.rejects(
      () =>
        fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(12), {
          idempotencyKey: 'lab-01-finalize-2',
        }),
      ConflictError,
    );
  });

  it('LAB-01 regression: keyed amend replay returns the stored amendment, never a second version', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await verifyOrder(fx, order.id);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'original content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));

    const input = {
      reportId,
      content: 'corrected content',
      authoredByRef: 'path-1',
      authoredAt: at(12),
      amendmentReason: 'TRANSCRIPTION_CORRECTION' as const,
      idempotencyKey: 'lab-01-amend-1',
    };
    const first = await fx.reports.amendReport(managerSession(fx), input);
    const replay = await fx.reports.amendReport(managerSession(fx), input);
    assert.equal(replay.id, first.id);
    assert.equal(replay.latestVersion, 2, 'replay must not create version 3');
    assert.equal(replay.versions[1]?.content, 'corrected content');
    assert.equal(auditCountFor(fx, reportId, 'AMENDED'), 1);
  });
});

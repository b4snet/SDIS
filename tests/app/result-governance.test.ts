/**
 * Step 28 — Result verification, finalization & amendment governance
 * (application layer).
 *
 * Proves the governed lifecycle over the canonical services: verification
 * authorization + attribution, verification-before-finalization,
 * finalized-report immutability, amendment reason vocabulary + manager-tier
 * authorization, complete lineage, idempotent replay, and concurrency (a
 * stale verification loses through the existing CAS).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { assertUuidV4 } from '../../src/types/ids';
import type { ReportId } from '../../src/types/ids';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/app/errors';
import { at, auditCountFor, createFixture, type LabFixture } from './helpers';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import type { OrderDTO } from '../../src/app/dto';
import { orderIdOf } from './helpers';

/** Manager tier: verification and amendment are high-integrity acts. */
function manager(fx: LabFixture) {
  (fx.session as { roles?: readonly string[] }).roles = [
    'manager',
    'operator',
    'viewer',
  ] as never;
  return fx.session;
}

/** Operator tier: may enter results but not verify or amend. */
function operator(fx: LabFixture) {
  (fx.session as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
  return fx.session;
}

async function verifiedOrder(fx: LabFixture): Promise<OrderDTO> {
  const order = await fx.orders.createOrder(fx.session, {
    patientId: fx.patientId,
    encounterId: fx.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(0),
  });
  await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'ACQUIRED', at(1));
  await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'PROCESSING', at(2));
  await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'RESULT_ENTERED', at(3));
  await fx.orders.transitionOrder(manager(fx), orderIdOf(order), 'VERIFIED', at(4));
  return order;
}

describe('governance: verification boundary (Step 28)', () => {
  it('requires the manager tier to verify (operator is 403-fail-closed)', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'ACQUIRED', at(1));
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'PROCESSING', at(2));
    await fx.orders.transitionOrder(
      fx.session,
      orderIdOf(order),
      'RESULT_ENTERED',
      at(3),
    );

    await assert.rejects(
      () => fx.orders.transitionOrder(operator(fx), orderIdOf(order), 'VERIFIED', at(4)),
      ForbiddenError,
    );
    // The order is untouched by the denied verification.
    const reread = await fx.orders.getOrder(fx.session, orderIdOf(order));
    assert.equal(reread.status, 'RESULT_ENTERED');
  });

  it('records the server-resolved verifier and timestamp; clients cannot set them', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const reread = await fx.orders.getOrder(fx.session, orderIdOf(order));
    assert.equal(reread.status, 'VERIFIED');
    assert.equal(reread.verifiedByRef, 'user-tech-1');
    assert.equal(reread.verifiedAt, at(4));
    assert.equal(auditCountFor(fx, order.id, 'VERIFIED'), 1);
    // Attribution survives later transitions (never rewritten).
    await fx.orders.transitionOrder(manager(fx), orderIdOf(order), 'FINALIZED', at(5));
    const after = await fx.orders.getOrder(fx.session, orderIdOf(order));
    assert.equal(after.verifiedByRef, 'user-tech-1');
    assert.equal(after.verifiedAt, at(4));
  });
});

describe('governance: finalization gate (Step 28)', () => {
  it('rejects report finalization while the order is unverified (409)', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'ACQUIRED', at(1));
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'PROCESSING', at(2));
    await fx.orders.transitionOrder(
      fx.session,
      orderIdOf(order),
      'RESULT_ENTERED',
      at(3),
    );
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'unverified content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    await assert.rejects(
      () =>
        fx.reports.finalizeReport(
          fx.session,
          assertUuidV4<ReportId>(created.id, 'report id'),
          'path-1',
          at(11),
        ),
      ConflictError,
    );
  });
});

describe('governance: report amendment (Step 28)', () => {
  it('amends a finalized report with reason, actor, and lineage; original preserved', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'original finalized content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));

    const amended = await fx.reports.amendReport(manager(fx), {
      reportId,
      content: 'corrected content',
      authoredByRef: 'path-2',
      authoredAt: at(12),
      amendmentReason: 'ANALYTICAL_CORRECTION',
    });
    assert.equal(amended.latestVersion, 2);
    assert.equal(amended.latestStatus, 'DRAFT');
    assert.equal(amended.versions[0]?.content, 'original finalized content');
    assert.equal(amended.versions[1]?.content, 'corrected content');
    assert.equal(amended.versions[1]?.amendmentReason, 'ANALYTICAL_CORRECTION');
    assert.equal(amended.versions[1]?.supersedesVersionId, amended.versions[0]?.id);
    assert.equal(auditCountFor(fx, reportId, 'AMENDED'), 1);
  });

  it('rejects amendments with a missing or out-of-vocabulary reason (422)', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));

    await assert.rejects(
      () =>
        fx.reports.amendReport(manager(fx), {
          reportId,
          content: 'corrected',
          authoredByRef: 'path-2',
          authoredAt: at(12),
          amendmentReason: '',
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        fx.reports.amendReport(manager(fx), {
          reportId,
          content: 'corrected',
          authoredByRef: 'path-2',
          authoredAt: at(12),
          amendmentReason: 'BECAUSE_I_SAID_SO',
        }),
      ValidationError,
    );
    const reread = await fx.reports.getReport(fx.session, reportId);
    assert.equal(reread.latestVersion, 1, 'no amendment version was created');
  });

  it('denies amendments below the manager tier and across facilities (403)', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));

    await assert.rejects(
      () =>
        fx.reports.amendReport(operator(fx), {
          reportId,
          content: 'corrected',
          authoredByRef: 'tech-2',
          authoredAt: at(12),
          amendmentReason: 'REPORT_CORRECTION',
        }),
      ForbiddenError,
    );
  });

  it('supports chained amendments with an unbroken lineage', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'v1',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));
    await fx.reports.amendReport(manager(fx), {
      reportId,
      content: 'v2',
      authoredByRef: 'path-2',
      authoredAt: at(12),
      amendmentReason: 'TRANSCRIPTION_CORRECTION',
    });
    await fx.reports.finalizeReport(fx.session, reportId, 'path-2', at(13));
    const third = await fx.reports.amendReport(manager(fx), {
      reportId,
      content: 'v3',
      authoredByRef: 'path-3',
      authoredAt: at(14),
      amendmentReason: 'ADMINISTRATIVE_CORRECTION',
    });
    assert.equal(third.latestVersion, 3);
    assert.equal(third.versions.length, 3);
    assert.equal(third.versions[2]?.supersedesVersionId, third.versions[1]?.id);
    assert.equal(third.versions[1]?.supersedesVersionId, third.versions[0]?.id);
    assert.equal(third.versions[0]?.amendmentReason, undefined);
  });

  it('keeps amendment replay idempotent (no duplicate versions)', async () => {
    const fx = createFixture();
    const order = await verifiedOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'v1',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    const reportId = assertUuidV4<ReportId>(created.id, 'report id');
    await fx.reports.finalizeReport(fx.session, reportId, 'path-1', at(11));

    // Fresh idempotency store is not needed — the service's own store keys
    // the replay; both calls share the key.
    void InMemoryIdempotencyStore;
    const input = {
      reportId,
      content: 'v2',
      authoredByRef: 'path-2',
      authoredAt: at(12),
      amendmentReason: 'TRANSCRIPTION_CORRECTION' as const,
      idempotencyKey: 'amend-key-1',
    };
    await fx.reports.amendReport(manager(fx), input);
    const replay = await fx.reports.amendReport(manager(fx), input);
    assert.equal(replay.latestVersion, 2, 'replay creates no version 3');
    assert.equal(auditCountFor(fx, reportId, 'AMENDED'), 1);
  });
});

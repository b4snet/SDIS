/**
 * Step 29 — diagnostic worklists (application).
 *
 * Proves the typed operational views over the EXISTING authoritative state:
 * each view selects exactly the canonical lifecycle stage it names, ordering
 * is deterministic (priority rank -> ordered-at -> id; collected-at -> id),
 * pagination is bounded and keyset-stable, per-view RBAC reuses the existing
 * permission matrix, scope is server-derived, the exception view surfaces
 * rejected specimens + the active QC hold, and no view can bypass the
 * Step-27/28 lifecycle gates.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  OTHER_ORG,
  orderIdOf,
  specimenIdOf,
} from './helpers';
import type { LabFixture } from './helpers';
import type { ApplicationSession } from '../../src/app/context';
import { ForbiddenError } from '../../src/app/errors';
import {
  assertUuidV4,
  type DiagnosticOrderId,
  type OrderItemId,
  type SpecimenId,
} from '../../src/types/ids';

const at = (n: number) =>
  new Date(Date.parse('2026-03-01T08:00:00Z') + n * 60_000).toISOString();

function manager(fx: LabFixture): ApplicationSession {
  return {
    ...fx.session,
    actor: { kind: 'USER', id: 'user-manager-1' },
    userId: 'user-manager-1',
    roles: ['manager'],
  } as never;
}

/** Creates an order walked to the given lifecycle stage. */
async function orderAt(
  fx: LabFixture,
  to: 'ACQUIRED' | 'PROCESSING' | 'RESULT_ENTERED' | 'VERIFIED',
  priority: 'ROUTINE' | 'URGENT' | 'EMERGENCY' = 'ROUTINE',
): Promise<DiagnosticOrderId> {
  const created = await fx.orders.createOrder(fx.session, {
    patientId: fx.patientId,
    encounterId: fx.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(0),
    priority,
  } as never);
  const orderId = orderIdOf(created);
  const stages = { ACQUIRED: 1, PROCESSING: 2, RESULT_ENTERED: 3, VERIFIED: 4 } as const;
  for (const stage of ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED', 'VERIFIED'] as const) {
    if (stages[stage] > stages[to]) break;
    await fx.orders.transitionOrder(fx.session, orderId, stage, at(stages[stage]));
  }
  return orderId;
}

/** Creates an order with a COLLECTED specimen and returns both ids. */
async function orderWithSpecimen(
  fx: LabFixture,
): Promise<{ orderId: DiagnosticOrderId; specimenId: SpecimenId }> {
  const orderId = await orderAt(fx, 'ACQUIRED');
  const order = await fx.orders.getOrder(fx.session, orderId);
  const specimen = await fx.specimens.collectSpecimen(fx.session, {
    orderItemId: assertUuidV4<OrderItemId>(order.items[0]!.id, 'order item id'),
    patientId: fx.patientId,
    kind: 'BLOOD',
    collectedAt: at(1),
  });
  return { orderId, specimenId: specimenIdOf(specimen) };
}

describe('worklist views: correctness (Step 29)', () => {
  it('collection view lists ACQUIRED orders awaiting collection', async () => {
    const fx = createFixture();
    const orderId = await orderAt(fx, 'ACQUIRED');
    const page = await fx.worklist.listView(fx.session, 'collection');
    assert.ok(page.items.some((item) => (item as { id: string }).id === orderId));
  });

  it('accessioning view lists COLLECTED specimens; processing lists RECEIVED', async () => {
    const fx = createFixture();
    const { specimenId } = await orderWithSpecimen(fx);
    const accessioning = await fx.worklist.listView(fx.session, 'accessioning');
    assert.ok(
      accessioning.items.some(
        (item) => (item as { specimenId: string }).specimenId === specimenId,
      ),
    );
    await fx.specimens.transitionSpecimen(fx.session, specimenId, 'RECEIVED', at(2));
    const afterAccession = await fx.worklist.listView(fx.session, 'accessioning');
    assert.ok(
      !afterAccession.items.some(
        (item) => (item as { specimenId: string }).specimenId === specimenId,
      ),
    );
    const processing = await fx.worklist.listView(fx.session, 'processing');
    assert.ok(
      processing.items.some(
        (item) => (item as { specimenId: string }).specimenId === specimenId,
      ),
    );
  });

  it('result-entry, verification, and finalization views track the order lifecycle', async () => {
    const fx = createFixture();
    const orderId = await orderAt(fx, 'PROCESSING');
    const entry = await fx.worklist.listView(fx.session, 'result-entry');
    assert.ok(entry.items.some((item) => (item as { id: string }).id === orderId));
    await fx.orders.transitionOrder(fx.session, orderId, 'RESULT_ENTERED', at(4));
    // Verification/finalization views are manager-tier reads (the permission
    // of the WORK they lead to): staff below that tier is 403.
    await assert.rejects(
      () => fx.worklist.listView(fx.session, 'verification'),
      ForbiddenError,
    );
    await fx.orders.transitionOrder(manager(fx), orderId, 'VERIFIED', at(5));
    const finalization = await fx.worklist.listView(manager(fx), 'finalization');
    assert.ok(finalization.items.some((item) => (item as { id: string }).id === orderId));
    const stillVerification = await fx.worklist.listView(manager(fx), 'verification');
    assert.ok(
      !stillVerification.items.some((item) => (item as { id: string }).id === orderId),
    );
  });

  it('exception view lists rejected specimens and the active QC hold', async () => {
    const fx = createFixture();
    const { specimenId } = await orderWithSpecimen(fx);
    await fx.specimens.transitionSpecimen(fx.session, specimenId, 'RECEIVED', at(2));
    await fx.specimens.transitionSpecimen(fx.session, specimenId, 'REJECTED', at(3), {
      rejectionReason: 'DAMAGED_SPECIMEN',
    });
    await fx.quality.recordQuality(manager(fx), {
      family: 'IQC',
      referenceType: 'device',
      at: at(3),
      hold: { reason: 'IQC out of range' },
    });
    // CANCELLED orders are part of the exception view (Step 29): the view's
    // order branch selects the CANCELLED lifecycle state. The worklist read
    // model must never pre-hide CANCELLED rows (BASELINE-06 — the PostgreSQL
    // query honors this exactly like the in-memory twin).
    const cancelledOrder = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(4),
    } as never);
    const cancelledId = orderIdOf(cancelledOrder);
    await fx.orders.cancelOrder(fx.session, cancelledId, at(5));
    const page = await fx.worklist.listView(manager(fx), 'exception');
    const rejected = page.items.find(
      (item) => (item as { specimenId?: string }).specimenId === specimenId,
    ) as { status: string; rejectionReason?: string } | undefined;
    assert.ok(rejected);
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'DAMAGED_SPECIMEN');
    assert.ok(
      page.items.some((item) => (item as { id: string }).id === cancelledId),
      'cancelled orders must surface in the exception view',
    );
    assert.ok(page.hold);
    assert.equal(page.hold.reason, 'IQC out of range');
  });
});

describe('worklist views: ordering, filters, pagination (Step 29)', () => {
  it('orders by priority rank then ordered-at (deterministic, operational only)', async () => {
    const fx = createFixture();
    const routine = await orderAt(fx, 'ACQUIRED', 'ROUTINE');
    const emergency = await orderAt(fx, 'ACQUIRED', 'EMERGENCY');
    const urgent = await orderAt(fx, 'ACQUIRED', 'URGENT');
    const page = await fx.worklist.listView(fx.session, 'collection');
    const ids = page.items.map((item) => (item as { id: string }).id);
    const index = (id: string) => ids.indexOf(id);
    assert.ok(index(emergency) < index(urgent) && index(urgent) < index(routine));
  });

  it('applies priority and testCode filters without widening scope', async () => {
    const fx = createFixture();
    await orderAt(fx, 'ACQUIRED', 'EMERGENCY');
    await orderAt(fx, 'ACQUIRED', 'ROUTINE');
    const emergencies = await fx.worklist.listView(fx.session, 'collection', {
      priority: 'EMERGENCY',
    });
    assert.ok(emergencies.items.length >= 1);
    assert.ok(
      emergencies.items.every(
        (i) => (i as { priority: string }).priority === 'EMERGENCY',
      ),
    );
    const cbc = await fx.worklist.listView(fx.session, 'collection', { testCode: 'CBC' });
    assert.ok(cbc.items.length >= 1);
    const none = await fx.worklist.listView(fx.session, 'collection', {
      testCode: 'NOPE',
    });
    assert.equal(none.items.length, 0);
  });

  it('paginates with a bounded page and a stable keyset cursor (no duplicates or gaps)', async () => {
    const fx = createFixture();
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      created.push(await orderAt(fx, 'ACQUIRED'));
    }
    const page1 = await fx.worklist.listView(fx.session, 'collection', { limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    const page2 = await fx.worklist.listView(fx.session, 'collection', {
      limit: 2,
      cursor: page1.nextCursor!,
    });
    assert.equal(page2.items.length, 2);
    const page3 = await fx.worklist.listView(fx.session, 'collection', {
      limit: 2,
      cursor: page2.nextCursor!,
    });
    assert.equal(page3.items.length, 1);
    // API-01: the final (non-full) page carries a null cursor — no extra
    // empty fetch is advertised.
    assert.equal(page3.nextCursor, null);
    const seen = [...page1.items, ...page2.items, ...page3.items].map(
      (item) => (item as { id: string }).id,
    );
    assert.deepEqual(
      [...seen].sort(),
      [...created].sort(),
      'keyset pagination must cover every item exactly once',
    );
  });
});

describe('worklist views: authorization & isolation (Step 29)', () => {
  it('denies views to roles without the view permission (fail-closed)', async () => {
    const fx = createFixture();
    await orderAt(fx, 'RESULT_ENTERED');
    const viewer = { ...fx.session, roles: ['viewer'] } as never;
    // Read-only roles are denied WORK views (collection = operator work,
    // verification = manager work) — fail-closed on the work permission.
    await assert.rejects(
      () => fx.worklist.listView(viewer, 'collection'),
      ForbiddenError,
    );
    await assert.rejects(
      () => fx.worklist.listView(viewer, 'verification'),
      ForbiddenError,
    );
  });

  it('rejects an unknown view as not found and never serves foreign-facility work', async () => {
    const fx = createFixture();
    await orderAt(fx, 'ACQUIRED');
    await assert.rejects(
      () => fx.worklist.listView(fx.session, 'nonexistent' as never),
      (error: unknown) => error instanceof Error,
    );
    // A session from ANOTHER organization sees nothing of this facility's work
    // (server-derived scope; the foreign facility session fails the scope
    // assert, mirroring every other scoped read).
    const foreign = sessionFor(OTHER_FACILITY, OTHER_ORG);
    (foreign as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(() => fx.worklist.listView(foreign, 'collection'));
  });
});

describe('worklist views: lifecycle integrity (Step 29)', () => {
  it('surfacing work never bypasses governance: finalization view does not finalize', async () => {
    const fx = createFixture();
    const orderId = await orderAt(fx, 'RESULT_ENTERED');
    await fx.orders.transitionOrder(manager(fx), orderId, 'VERIFIED', at(5));
    const page = await fx.worklist.listView(manager(fx), 'finalization');
    assert.ok(page.items.some((item) => (item as { id: string }).id === orderId));
    // The report on this order still cannot finalize while a QC hold is
    // active — worklist visibility is not authorization (Step 27 boundary).
    await fx.quality.recordQuality(manager(fx), {
      family: 'IQC',
      referenceType: 'device',
      at: at(6),
      hold: { reason: 'IQC out of range' },
    });
    await fx.reports.createReport(manager(fx), {
      orderId,
      content: 'governed content',
      authoredByRef: 'user-manager-1',
      authoredAt: at(7),
    });
    await assert.rejects(
      () =>
        fx.reports.finalizeReport(manager(fx), orderId as never, 'user-manager-1', at(8)),
      (error: unknown) =>
        error instanceof Error && /hold/i.test((error as Error).message),
    );
  });

  it('unauthenticated access is denied on every view', async () => {
    const fx = createFixture();
    await assert.rejects(() => fx.worklist.listView(undefined, 'collection'));
    await assert.rejects(() => fx.worklist.listView(undefined, 'exception'));
  });
});

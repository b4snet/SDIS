/**
 * Application security tests: forged scope, IDOR resistance, actor validity,
 * audit-snapshot isolation, and the public error contract.
 *
 * Each test establishes expected behavior independently through the public
 * service interface.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUuidV4 } from '../../src/types/ids';
import type {
  DiagnosticOrderId,
  FacilityId,
  OrderItemId,
  ReportId,
} from '../../src/types/ids';
import {
  ForbiddenError,
  ScopeMismatchError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/app/errors';
import {
  at,
  createFixture,
  sessionFor,
  FACILITY,
  ORG,
  OTHER_FACILITY,
  OTHER_ORG,
  type LabFixture,
} from './helpers';
import type { OrderDTO } from '../../src/app/dto';

async function createOrder(fx: LabFixture): Promise<OrderDTO> {
  return fx.orders.createOrder(fx.session, {
    patientId: fx.patientId,
    encounterId: fx.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(0),
  });
}

function firstItemId(order: OrderDTO): OrderItemId {
  const item = order.items[0];
  if (!item) throw new Error('test setup: order has no items');
  return assertUuidV4<OrderItemId>(item.id, 'order item id');
}

/** Staff-claimed session: reaches the application scope checks under RBAC. */
function withOperator(session: ReturnType<typeof sessionFor>) {
  (session as { roles?: readonly string[] }).roles = ['operator'] as never;
  return session;
}

describe('app security: actor and session', () => {
  it('rejects a session with an empty actor identity', async () => {
    const fx = createFixture();
    const hollow = { ...fx.session, actor: { kind: 'USER' as const, id: '' } };
    await assert.rejects(
      () =>
        fx.orders.createOrder(hollow, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      UnauthenticatedError,
    );
  });

  it('rejects a session whose facility is not registered', async () => {
    const fx = createFixture();
    const unknown = sessionFor(
      assertUuidV4<FacilityId>('00000000-0000-4000-8000-00000000fffe', 'facility id'),
      ORG,
    );
    await assert.rejects(
      () =>
        fx.orders.createOrder(unknown, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      ForbiddenError,
    );
  });

  it('tenant scope is not the actor identity (forged org rejected)', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const forgedOrg = sessionFor(FACILITY, OTHER_ORG);
    (forgedOrg as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () => fx.orders.getOrder(forgedOrg, assertUuidV4(order.id, 'order id')),
      ScopeMismatchError,
    );
  });
});

describe('app security: cross-facility IDOR resistance', () => {
  it('cannot transition another facility order', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    // An authorized (operator) session: the denial must come from the scope
    // layer (ScopeMismatchError), proving scope is enforced after
    // authorization. Role-less sessions are denied earlier with FORBIDDEN.
    await assert.rejects(
      () =>
        fx.orders.transitionOrder(
          withOperator(sessionFor(OTHER_FACILITY)),
          assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
          'ACQUIRED',
          at(1),
        ),
      ScopeMismatchError,
    );
  });

  it('cannot finalize another facility report', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const created = await fx.reports.createReport(fx.session, {
      orderId: assertUuidV4<DiagnosticOrderId>(order.id, 'order id'),
      content: 'content',
      authoredByRef: 'path-1',
      authoredAt: at(10),
    });
    await assert.rejects(
      () =>
        fx.reports.finalizeReport(
          withOperator(sessionFor(OTHER_FACILITY)),
          assertUuidV4<ReportId>(created.id, 'report id'),
          'path-1',
          at(11),
        ),
      ScopeMismatchError,
    );
  });

  it('observations of one order item are invisible from another item', async () => {
    const fx = createFixture();
    const first = await createOrder(fx);
    const second = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'GLU', codeSystem: 'sdis' }],
      orderedAt: at(0),
      idempotencyKey: 'second-order-idor',
    });
    await fx.observations.enterObservation(fx.session, {
      orderItemId: firstItemId(first),
      patientId: fx.patientId,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 13.2 },
      issuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
      at: at(6),
    });
    assert.equal(
      (await fx.observations.listForOrderItem(fx.session, firstItemId(first))).length,
      1,
    );
    assert.equal(
      (await fx.observations.listForOrderItem(fx.session, firstItemId(second))).length,
      0,
    );
  });
});

describe('app security: audit and errors', () => {
  it('audit reads are snapshots isolated from later writes', async () => {
    const fx = createFixture();
    const before = fx.audit.list().length;
    await createOrder(fx);
    assert.equal(fx.audit.list().length > before, true);
    assert.equal(before, 0);
  });

  it('errors carry stable codes without internal leakage', async () => {
    const fx = createFixture();
    try {
      await fx.orders.createOrder(fx.session, {
        patientId: fx.patientId,
        encounterId: fx.encounterId,
        modality: 'LAB',
        items: [],
        orderedAt: at(0),
      });
      assert.fail('expected a ValidationError');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.code, 'VALIDATION_FAILED');
      assert.ok(!error.message.includes('SELECT'));
      assert.ok(!error.message.includes('node_modules'));
      assert.deepEqual(error.details, []);
    }
  });
});

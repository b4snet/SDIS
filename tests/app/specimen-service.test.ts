/**
 * Application tests: specimen service.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUuidV4 } from '../../src/types/ids';
import type { OrderItemId } from '../../src/types/ids';
import {
  InvalidStateTransitionError,
  NotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../../src/app/errors';
import {
  at,
  auditCountFor,
  createFixture,
  OTHER_PATIENT_ID,
  sessionFor,
  OTHER_FACILITY,
  type LabFixture,
  specimenIdOf,
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

describe('app: specimen collection', () => {
  it('collects a COLLECTED specimen and advances the order to ACQUIRED', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const collected = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(1),
    });
    assert.equal(collected.status, 'COLLECTED');
    assert.equal(collected.patientId, fx.patientId);
    assert.equal(collected.kind, 'BLOOD');

    const reread = await fx.orders.getOrder(fx.session, assertUuidV4(order.id, 'order'));
    assert.equal(reread.status, 'ACQUIRED');
    assert.equal(auditCountFor(fx, collected.id, 'CREATED'), 1);
  });

  it('rejects a specimen for the wrong patient', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.specimens.collectSpecimen(fx.session, {
          orderItemId: firstItemId(order),
          patientId: OTHER_PATIENT_ID,
          kind: 'BLOOD',
          collectedAt: at(1),
        }),
      ValidationError,
    );
  });

  it('rejects an unknown order item', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.specimens.collectSpecimen(fx.session, {
          orderItemId: assertUuidV4(
            '00000000-0000-4000-8000-00000000ffff',
            'order item id',
          ),
          patientId: fx.patientId,
          kind: 'BLOOD',
          collectedAt: at(1),
        }),
      NotFoundError,
    );
  });

  it('rejects collection for a cancelled order', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await fx.orders.cancelOrder(fx.session, assertUuidV4(order.id, 'order'), at(1));
    await assert.rejects(
      () =>
        fx.specimens.collectSpecimen(fx.session, {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          kind: 'BLOOD',
          collectedAt: at(2),
        }),
      InvalidStateTransitionError,
    );
  });

  it('replays an idempotency key without duplicating specimen or audit', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const input = {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD' as const,
      collectedAt: at(1),
      idempotencyKey: 'req-specimen-1',
    };
    const first = await fx.specimens.collectSpecimen(fx.session, input);
    const second = await fx.specimens.collectSpecimen(fx.session, input);
    assert.equal(first.id, second.id);
    assert.equal(auditCountFor(fx, first.id, 'CREATED'), 1);
  });

  it('rejects collection through another facility session', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.specimens.collectSpecimen(withOperator(sessionFor(OTHER_FACILITY)), {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          kind: 'BLOOD',
          collectedAt: at(1),
        }),
      ScopeMismatchError,
    );
  });
});

describe('app: specimen transitions', () => {
  it('walks COLLECTED → RECEIVED → ACCEPTED → PROCESSED', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const collected = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(1),
    });
    const id = specimenIdOf(collected);
    assert.equal(
      (await fx.specimens.transitionSpecimen(fx.session, id, 'RECEIVED', at(2))).status,
      'RECEIVED',
    );
    assert.equal(
      (await fx.specimens.transitionSpecimen(fx.session, id, 'ACCEPTED', at(3))).status,
      'ACCEPTED',
    );
    assert.equal(
      (await fx.specimens.transitionSpecimen(fx.session, id, 'PROCESSED', at(4))).status,
      'PROCESSED',
    );
    assert.equal(auditCountFor(fx, collected.id, 'TRANSITIONED'), 3);
  });

  it('rejects skipping RECEIVED', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const collected = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(1),
    });
    await assert.rejects(
      () =>
        fx.specimens.transitionSpecimen(
          fx.session,
          specimenIdOf(collected),
          'ACCEPTED',
          at(2),
        ),
      InvalidStateTransitionError,
    );
  });
});

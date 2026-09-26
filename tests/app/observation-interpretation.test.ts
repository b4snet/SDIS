/**
 * Application tests: observation and interpretation services.
 *
 * Observation ≠ Interpretation is preserved: entering an observation never
 * creates an interpretation, and interpretation sources are never collapsed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUuidV4 } from '../../src/types/ids';
import type { OrderItemId, SpecimenId } from '../../src/types/ids';
import { NotFoundError, ValidationError } from '../../src/app/errors';
import {
  at,
  auditCountFor,
  createFixture,
  OTHER_PATIENT_ID,
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

async function collectSpecimen(fx: LabFixture, order: OrderDTO): Promise<SpecimenId> {
  const collected = await fx.specimens.collectSpecimen(fx.session, {
    orderItemId: firstItemId(order),
    patientId: fx.patientId,
    kind: 'BLOOD',
    collectedAt: at(1),
  });
  return assertUuidV4<SpecimenId>(collected.id, 'specimen id');
}

describe('app: observation entry', () => {
  it('records a device observation bound to the specimen and order item', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const specimenId = await collectSpecimen(fx, order);
    const entered = await fx.observations.enterObservation(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      specimenId,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 13.2 },
      unit: 'g/dL',
      issuedBy: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
      at: at(6),
    });
    assert.equal(entered.orderItemId, firstItemId(order));
    assert.equal(entered.patientId, fx.patientId);
    assert.deepEqual(entered.value, { kind: 'QUANTITATIVE', value: 13.2 });
    assert.equal(entered.issuedByKind, 'DEVICE');
    assert.equal(auditCountFor(fx, entered.id, 'CREATED'), 1);

    const listed = await fx.observations.listForOrderItem(fx.session, firstItemId(order));
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.id, entered.id);
  });

  it('rejects an observation for the wrong patient', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.observations.enterObservation(fx.session, {
          orderItemId: firstItemId(order),
          patientId: OTHER_PATIENT_ID,
          code: 'HB',
          codeSystem: 'sdis',
          value: { kind: 'QUANTITATIVE', value: 13.2 },
          issuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
          at: at(6),
        }),
      ValidationError,
    );
  });

  it('rejects a specimen that serves a different order item', async () => {
    const fx = createFixture();
    const first = await createOrder(fx);
    const second = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'GLU', codeSystem: 'sdis' }],
      orderedAt: at(0),
      idempotencyKey: 'second-order',
    });
    const foreignSpecimen = await collectSpecimen(fx, second);
    await assert.rejects(
      () =>
        fx.observations.enterObservation(fx.session, {
          orderItemId: firstItemId(first),
          patientId: fx.patientId,
          specimenId: foreignSpecimen,
          code: 'HB',
          codeSystem: 'sdis',
          value: { kind: 'QUANTITATIVE', value: 13.2 },
          issuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
          at: at(6),
        }),
      ValidationError,
    );
  });

  it('rejects a missing provenance source', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.observations.enterObservation(fx.session, {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          code: 'HB',
          codeSystem: 'sdis',
          value: { kind: 'QUANTITATIVE', value: 13.2 },
          issuedBy: undefined as never,
          at: at(6),
        }),
      ValidationError,
    );
  });

  it('rejects an unknown specimen', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.observations.enterObservation(fx.session, {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          specimenId: assertUuidV4<SpecimenId>(
            '00000000-0000-4000-8000-00000000ffff',
            'specimen id',
          ),
          code: 'HB',
          codeSystem: 'sdis',
          value: { kind: 'QUANTITATIVE', value: 13.2 },
          issuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
          at: at(6),
        }),
      NotFoundError,
    );
  });

  it('replays an idempotency key without duplicating observation or audit', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const input = {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 13.2 } as const,
      issuedBy: { kind: 'DEVICE' as const, label: 'analyzer-x1' },
      at: at(6),
      idempotencyKey: 'req-observation-1',
    };
    const first = await fx.observations.enterObservation(fx.session, input);
    const second = await fx.observations.enterObservation(fx.session, input);
    assert.equal(first.id, second.id);
    assert.equal(auditCountFor(fx, first.id, 'CREATED'), 1);
  });
});

describe('app: interpretation', () => {
  it('preserves an algorithm source without implying human verification', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const added = await fx.interpretations.addInterpretation(fx.session, {
      orderItemId: firstItemId(order),
      source: { kind: 'ALGORITHM', label: 'rules-v3' },
      text: 'within expected pattern',
      at: at(7),
    });
    assert.equal(added.sourceKind, 'ALGORITHM');
    assert.equal(auditCountFor(fx, added.id, 'CREATED'), 1);

    const listed = await fx.interpretations.listForOrderItem(
      fx.session,
      firstItemId(order),
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.sourceKind, 'ALGORITHM');
  });

  it('records a human interpretation as human', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    const added = await fx.interpretations.addInterpretation(fx.session, {
      orderItemId: firstItemId(order),
      source: { kind: 'HUMAN', label: 'pathologist review', ref: 'path-1' },
      text: 'consistent with iron deficiency',
      at: at(7),
    });
    assert.equal(added.sourceKind, 'HUMAN');
  });

  it('rejects an invalid source kind', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await assert.rejects(
      () =>
        fx.interpretations.addInterpretation(fx.session, {
          orderItemId: firstItemId(order),
          source: { kind: 'SOMETHING_ELSE', label: 'x' } as never,
          text: 'text',
          at: at(7),
        }),
      ValidationError,
    );
  });

  it('does not create an interpretation when entering an observation', async () => {
    const fx = createFixture();
    const order = await createOrder(fx);
    await fx.observations.enterObservation(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      code: 'HB',
      codeSystem: 'sdis',
      value: { kind: 'QUANTITATIVE', value: 13.2 },
      issuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
      at: at(6),
    });
    assert.equal(
      (await fx.interpretations.listForOrderItem(fx.session, firstItemId(order))).length,
      0,
    );
  });
});

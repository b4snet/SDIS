/**
 * Billing test: idempotency keys guarantee retries cannot duplicate irreversible
 * financial effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChargeLedger } from '../../src/domain/billing/billing';
import { toBrandedId } from '../../src/types/ids';

const ORDER_ITEM = toBrandedId('00000000-0000-4000-8000-0000000000f1');
const SERVICE = toBrandedId('00000000-0000-4000-8000-0000000000f2');

describe('billing: idempotency', () => {
  it('replaying the same idempotency key creates exactly one charge', () => {
    const ledger = new ChargeLedger();
    const input = {
      orderItemId: ORDER_ITEM,
      serviceId: SERVICE,
      amount: 1200,
      currency: 'NPR',
      idempotencyKey: 'req-0001',
    };
    const first = ledger.addCharge(input);
    const replay = ledger.addCharge(input);
    assert.equal(replay.id, first.id);
    assert.equal(ledger.getByOrderItem(ORDER_ITEM).length, 1);
  });

  it('distinct idempotency keys create distinct charges', () => {
    const ledger = new ChargeLedger();
    ledger.addCharge({
      orderItemId: ORDER_ITEM,
      serviceId: SERVICE,
      amount: 100,
      currency: 'NPR',
      idempotencyKey: 'req-A',
    });
    ledger.addCharge({
      orderItemId: ORDER_ITEM,
      serviceId: SERVICE,
      amount: 200,
      currency: 'NPR',
      idempotencyKey: 'req-B',
    });
    assert.equal(ledger.getByOrderItem(ORDER_ITEM).length, 2);
  });
});

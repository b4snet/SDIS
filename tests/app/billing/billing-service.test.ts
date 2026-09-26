/**
 * Billing application tests — the diagnostic charge lifecycle.
 *
 * Prove the Step-8 capability over the EXISTING domain billing contract
 * (`Charge`/ledger semantics): order→charge linkage through the EXISTING
 * order service (which owns scope), recorded-price-only amounts, duplicate
 * CONFLICT, keyed idempotent replay without duplicate audit, scoped
 * retrieval, and fail-closed/forged-scope rejection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BillingService } from '../../../src/app/billing/billing-service';
import { InMemoryChargeRepository } from '../../../src/app/in-memory-billing';
import { createFixture, sessionFor, orderIdOf, at } from '../helpers';
import { toBrandedId, assertUuidV4 } from '../../../src/types/ids';
import type { BillableServiceId, ChargeId, OrderItemId } from '../../../src/types/ids';
import {
  ConflictError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../../src/app/errors';

const SERVICE_ID = toBrandedId(
  '00000000-0000-4000-8000-0000000003f1',
) as BillableServiceId;
const UNKNOWN_SERVICE = toBrandedId(
  '00000000-0000-4000-8000-0000000003f2',
) as BillableServiceId;

function billingFor(): {
  billing: BillingService;
  charges: InMemoryChargeRepository;
  fixture: ReturnType<typeof createFixture>;
} {
  const fixture = createFixture();
  const charges = new InMemoryChargeRepository();
  charges.registerService({
    id: SERVICE_ID,
    facilityId: toBrandedId('00000000-0000-4000-8000-000000000011'),
    name: 'CBC — Complete Blood Count',
    modality: 'LAB',
    priceCurrency: 'NPR',
    priceAmount: 350,
  });
  const billing = new BillingService({
    orders: fixture.orders,
    charges,
    facilities: (fixture.orders as unknown as { deps: { facilities: unknown } }).deps
      .facilities as never,
    audit: fixture.audit,
    idempotency: (fixture.orders as unknown as { deps: { idempotency: unknown } }).deps
      .idempotency as never,
  });
  return { billing, charges, fixture };
}

async function orderWithItem(fixture: ReturnType<typeof createFixture>) {
  const order = await fixture.orders.createOrder(fixture.session, {
    patientId: fixture.patientId,
    encounterId: fixture.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(1),
  });
  return {
    order,
    itemId: assertUuidV4<OrderItemId>(order.items[0]!.id, 'order item id'),
  };
}

describe('billing: charge creation', () => {
  it('creates a charge for an order item at the recorded price', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const charge = await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order),
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    assert.ok(charge.id);
    assert.equal(charge.orderId, order.id);
    assert.equal(charge.orderItemId, itemId);
    assert.equal(charge.serviceId, SERVICE_ID);
    assert.equal(charge.amount, 350);
    assert.equal(charge.currency, 'NPR');
  });

  it('rejects an order item that does not belong to the order', async () => {
    const { billing, fixture } = billingFor();
    const { order } = await orderWithItem(fixture);
    const { order: other } = await orderWithItem(fixture);
    const otherItem = other.items[0]!.id as never;
    await assert.rejects(
      () =>
        billing.createCharge(fixture.session, {
          orderId: orderIdOf(order),
          orderItemId: otherItem,
          serviceId: SERVICE_ID,
        }),
      ValidationError,
    );
  });

  it('rejects an unknown billable service', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        billing.createCharge(fixture.session, {
          orderId: orderIdOf(order),
          orderItemId: itemId,
          serviceId: UNKNOWN_SERVICE,
        }),
      NotFoundError,
    );
  });

  it('rejects charging the same order item twice for the same service (CONFLICT)', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const input = {
      orderId: orderIdOf(order) as never,
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    };
    await billing.createCharge(fixture.session, input);
    await assert.rejects(
      () => billing.createCharge(fixture.session, input),
      ConflictError,
    );
  });

  it('rejects an unauthenticated session (fail-closed)', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        billing.createCharge(undefined, {
          orderId: orderIdOf(order),
          orderItemId: itemId,
          serviceId: SERVICE_ID,
        }),
      UnauthenticatedError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const forged = sessionFor(
      toBrandedId('00000000-0000-4000-8000-000000000011'),
      toBrandedId('00000000-0000-4000-8000-000000000009'),
    );
    await assert.rejects(
      () =>
        billing.createCharge(forged, {
          orderId: orderIdOf(order),
          orderItemId: itemId,
          serviceId: SERVICE_ID,
        }),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('rejects cross-facility orders through the order service scope', async () => {
    const { billing, fixture } = billingFor();
    const outsider = sessionFor(
      toBrandedId('00000000-0000-4000-8000-000000000012'),
      toBrandedId('00000000-0000-4000-8000-000000000001'),
    );
    const { order, itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        billing.createCharge(outsider, {
          orderId: orderIdOf(order) as never,
          orderItemId: itemId,
          serviceId: SERVICE_ID,
        }),
      (error: unknown) => error instanceof Error && /scope/i.test(error.message),
    );
  });
});

describe('billing: retrieval and linkage', () => {
  it('returns a charge by id with its owning order', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const created = await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order),
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    const found = await billing.getCharge(fixture.session, created.id as ChargeId);
    assert.equal(found.id, created.id);
    assert.equal(found.orderId, order.id);
  });

  it('hides another facility charge behind the same 404 (no existence leak)', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const created = await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order),
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    const outsider = sessionFor(
      toBrandedId('00000000-0000-4000-8000-000000000012'),
      toBrandedId('00000000-0000-4000-8000-000000000001'),
    );
    await assert.rejects(
      () => billing.getCharge(outsider, created.id as ChargeId),
      (error: unknown) => error instanceof Error && /scope/i.test(error.message),
    );
  });

  it('404s unknown charges with the stable NOT_FOUND code', async () => {
    const { billing, fixture } = billingFor();
    await assert.rejects(
      () =>
        billing.getCharge(
          fixture.session,
          '00000000-0000-4000-8000-0000000003ff' as ChargeId,
        ),
      NotFoundError,
    );
  });

  it('lists charges linked to a scope-verified order', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order),
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    const charges = await billing.listChargesForOrder(fixture.session, orderIdOf(order));
    assert.equal(charges.length, 1);
    assert.equal(charges[0]?.orderId, order.id);
  });
});

describe('billing: audit and idempotency', () => {
  it('emits a CREATED audit event for the charge', async () => {
    const { billing, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const charge = await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order),
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    const events = fixture.audit
      .list()
      .filter((e) => e.objectType === 'charge' && e.objectId === charge.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, 'CREATED');
  });

  it('replays the same key to the same charge without duplicate audit or rows', async () => {
    const { billing, charges, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    const input = {
      orderId: orderIdOf(order) as never,
      orderItemId: itemId,
      serviceId: SERVICE_ID,
      idempotencyKey: 'charge-retry-1',
    };
    const first = await billing.createCharge(fixture.session, input);
    const replay = await billing.createCharge(fixture.session, input);
    assert.equal(replay.id, first.id);
    const stored = await charges.listByOrderItem(itemId);
    assert.equal(stored.length, 1);
    const events = fixture.audit
      .list()
      .filter((e) => e.objectType === 'charge' && e.objectId === first.id);
    assert.equal(events.length, 1);
  });

  it('distinct keys on distinct services create distinct charges', async () => {
    const { billing, charges, fixture } = billingFor();
    const { order, itemId } = await orderWithItem(fixture);
    charges.registerService({
      id: UNKNOWN_SERVICE,
      facilityId: toBrandedId('00000000-0000-4000-8000-000000000011'),
      name: 'Urinalysis',
      modality: 'LAB',
      priceCurrency: 'NPR',
      priceAmount: 200,
    });
    await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order) as never,
      orderItemId: itemId,
      serviceId: SERVICE_ID,
      idempotencyKey: 'charge-a',
    });
    await billing.createCharge(fixture.session, {
      orderId: orderIdOf(order) as never,
      orderItemId: itemId,
      serviceId: UNKNOWN_SERVICE,
      idempotencyKey: 'charge-b',
    });
    assert.equal((await charges.listByOrderItem(itemId)).length, 2);
  });
});

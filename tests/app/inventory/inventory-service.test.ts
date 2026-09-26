/**
 * Laboratory inventory application tests (Step 14).
 *
 * Proves the capability over the EXISTING domain contract
 * (`src/domain/inventory/inventory.ts`): item/lot registration, append-only
 * movement ledger, derived balance, expiry status (operational, not clinical),
 * scope enforcement, RBAC enforcement, idempotent replay, and audit. Fresh
 * fixture per test; the in-memory repository mirrors the PostgreSQL
 * uniqueness rules (SKU per facility, lot per item, movement key).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InventoryService } from '../../../src/app/inventory/inventory-service';
import { InMemoryInventoryRepository } from '../../../src/app/in-memory-inventory';
import { ConflictError, NotFoundError, ValidationError } from '../../../src/app/errors';
import { AuthorizationService, claimedRoleResolver } from '../../../src/app/authz/rbac';
import {
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  OTHER_ORG,
  type LabFixture,
} from '../helpers';
import { InMemoryIdempotencyStore, type AuditLogPort } from '../../../src/app/in-memory';
import type { FacilityDirectory } from '../../../src/app/ports';

interface Harness {
  readonly service: InventoryService;
  readonly session: ReturnType<typeof sessionFor>;
  readonly audit: AuditLogPort;
  readonly idempotency: InMemoryIdempotencyStore;
}

function harness(roles: readonly string[] = ['operator']): Harness {
  const fixture: LabFixture = createFixture();
  const audit = fixture.audit as AuditLogPort;
  const idempotency = new InMemoryIdempotencyStore();
  const session = sessionFor();
  const service = new InventoryService({
    inventory: new InMemoryInventoryRepository(),
    facilities: (fixture.orders as unknown as { deps: { facilities: FacilityDirectory } })
      .deps.facilities,
    audit,
    idempotency,
    // The ONE authorization engine, resolving the SAME role claims the
    // production credential binding supplies.
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  (session as { roles?: readonly string[] }).roles = roles as never;
  return { service, session, audit, idempotency };
}

const VALID_ITEM = {
  sku: 'RG-100',
  name: 'Synthetic reagent kit',
  category: 'REAGENT' as const,
};

describe('inventory: item and lot registration', () => {
  it('registers an item and returns a clean DTO', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    assert.ok(item.id);
    assert.equal(item.sku, 'RG-100');
    assert.equal(item.category, 'REAGENT');
  });

  it('rejects duplicate sku per facility as CONFLICT', async () => {
    const h = harness();
    await h.service.registerItem(h.session, VALID_ITEM);
    await assert.rejects(
      () => h.service.registerItem(h.session, VALID_ITEM),
      ConflictError,
    );
  });

  it('rejects invalid sku/name/category with the existing validation error', async () => {
    const h = harness();
    await assert.rejects(
      () => h.service.registerItem(h.session, { ...VALID_ITEM, sku: 'a' }),
      ValidationError,
    );
    await assert.rejects(
      () => h.service.registerItem(h.session, { ...VALID_ITEM, name: '   ' }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.registerItem(h.session, {
          ...VALID_ITEM,
          category: 'REAGENT_KIT' as never,
        }),
      ValidationError,
    );
  });

  it('registers a lot on an existing item and preserves expiry verbatim', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    const lot = await h.service.registerLot(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-A',
      expiryDate: '2027-06-30',
      receivedQuantity: 100,
    });
    assert.equal(lot.lotNumber, 'LOT-2026-A');
    assert.equal(lot.expiryDate, '2027-06-30');
    assert.equal(lot.receivedQuantity, 100);
  });

  it('rejects a duplicate lot number on the same item as CONFLICT', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    await h.service.registerLot(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-A',
      expiryDate: '2027-06-30',
      receivedQuantity: 100,
    });
    await assert.rejects(
      () =>
        h.service.registerLot(h.session, {
          itemId: item.id as never,
          lotNumber: 'LOT-2026-A',
          expiryDate: '2028-01-01',
          receivedQuantity: 50,
        }),
      ConflictError,
    );
  });

  it('rejects invalid lot data (non-positive quantity, bad date, unknown item)', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    await assert.rejects(
      () =>
        h.service.registerLot(h.session, {
          itemId: item.id as never,
          lotNumber: 'L1',
          expiryDate: '2027-06-30',
          receivedQuantity: 0,
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.registerLot(h.session, {
          itemId: item.id as never,
          lotNumber: 'L1',
          expiryDate: 'not-a-date',
          receivedQuantity: 10,
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        h.service.registerLot(h.session, {
          itemId: '00000000-0000-4000-8000-00000000b001' as never,
          lotNumber: 'L1',
          expiryDate: '2027-06-30',
          receivedQuantity: 10,
        }),
      NotFoundError,
    );
  });
});

describe('inventory: movements, balance, and expiry', () => {
  async function itemWithLot(h: Harness, quantity = 100) {
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    const lot = await h.service.registerLot(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-A',
      expiryDate: '2027-06-30',
      receivedQuantity: quantity,
    });
    return { item, lot };
  }

  it('receives stock (IN) and derives the balance from the ledger', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    await h.service.receiveStock(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-B',
      expiryDate: '2027-06-30',
      quantity: 50,
    });
    await h.service.receiveStock(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-B',
      expiryDate: '2027-06-30',
      quantity: 25,
    });
    const balance = await h.service.getBalance(h.session, item.id as never);
    assert.equal(balance.totalBalance, 75);
    assert.equal(balance.lots.length, 1);
    assert.equal(balance.lots[0]!.balance, 75);
  });

  it('issues stock (OUT) and never lets the ledger go negative', async () => {
    const h = harness();
    const { item } = await itemWithLot(h, 100);
    const lot = (await h.service.getBalance(h.session, item.id as never)).lots[0]!;
    await h.service.issueStock(h.session, {
      batchId: lot.lot.id as never,
      quantity: 40,
      movementType: 'OUT',
      reason: 'consumption',
    });
    const balance = await h.service.getBalance(h.session, item.id as never);
    assert.equal(balance.totalBalance, 60);
    await assert.rejects(
      () =>
        h.service.issueStock(h.session, {
          batchId: lot.lot.id as never,
          quantity: 100,
          movementType: 'OUT',
          reason: 'consumption',
        }),
      ValidationError,
    );
  });

  it('records WASTAGE as a signed-negative movement', async () => {
    const h = harness();
    const { item } = await itemWithLot(h, 30);
    const lot = (await h.service.getBalance(h.session, item.id as never)).lots[0]!;
    const movement = await h.service.issueStock(h.session, {
      batchId: lot.lot.id as never,
      quantity: 5,
      movementType: 'WASTAGE',
      reason: 'wastage',
    });
    assert.equal(movement.movementType, 'WASTAGE');
    assert.equal(movement.quantitySigned, -5);
  });

  it('reports expiry status without inventing clinical rules', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    await h.service.receiveStock(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-OLD',
      expiryDate: '2020-01-01',
      quantity: 10,
    });
    await h.service.receiveStock(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-NEW',
      expiryDate: '2099-01-01',
      quantity: 10,
    });
    const balance = await h.service.getBalance(h.session, item.id as never);
    const statuses = Object.fromEntries(
      balance.lots.map((l) => [l.lot.lotNumber, l.lot.expiryStatus]),
    );
    assert.equal(statuses['LOT-OLD'], 'EXPIRED');
    assert.equal(statuses['LOT-NEW'], 'VALID');
    // Balance is reported regardless of expiry — no automatic blocking.
    assert.equal(balance.totalBalance, 20);
  });

  it('replays a keyed receipt idempotently — no duplicate stock or audit', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    const input = {
      itemId: item.id,
      lotNumber: 'LOT-RETRY',
      expiryDate: '2027-06-30',
      quantity: 10,
      idempotencyKey: 'receipt-1',
    };
    const first = await h.service.receiveStock(h.session, input as never);
    const second = await h.service.receiveStock(h.session, input as never);
    assert.equal(second.id, first.id);
    const balance = await h.service.getBalance(h.session, item.id as never);
    assert.equal(balance.totalBalance, 10);
    const audits = await h.audit.list();
    const movementAudits = audits.filter((a) => a.objectType === 'inventory-movement');
    assert.equal(movementAudits.length, 1);
  });
});

describe('inventory: scope and authorization', () => {
  it('rejects unauthenticated calls', async () => {
    const h = harness();
    await assert.rejects(
      () => h.service.registerItem(undefined, VALID_ITEM),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'UNAUTHENTICATED');
        return true;
      },
    );
  });

  it('denies a session without the inventory permission (fail-closed RBAC)', async () => {
    const h = harness(['viewer']);
    await assert.rejects(
      () => h.service.registerItem(h.session, VALID_ITEM),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'FORBIDDEN');
        return true;
      },
    );
  });

  it('hides other-facility items behind a scope-unaware 404', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    // A VALID same-organization session at ANOTHER facility: authorization
    // accepts it, scope must not.
    const other = sessionFor(OTHER_FACILITY);
    (other as { roles?: readonly string[] }).roles = ['operator'];
    await assert.rejects(
      () => h.service.getBalance(other, item.id as never),
      NotFoundError,
    );
  });

  it('rejects a forged facility/organization pairing before any resource check', async () => {
    const h = harness();
    const forged = sessionFor(OTHER_FACILITY, OTHER_ORG);
    (forged as { roles?: readonly string[] }).roles = ['operator'];
    await assert.rejects(
      () => h.service.registerItem(forged, VALID_ITEM),
      (error: { readonly code?: string }) => {
        assert.ok(['FORBIDDEN', 'SCOPE_MISMATCH'].includes(error.code ?? ''));
        return true;
      },
    );
  });
});

describe('inventory: audit', () => {
  it('audits item, lot, and movement lifecycle events with non-PHI details', async () => {
    const h = harness();
    const item = await h.service.registerItem(h.session, VALID_ITEM);
    await h.service.registerLot(h.session, {
      itemId: item.id as never,
      lotNumber: 'LOT-2026-A',
      expiryDate: '2027-06-30',
      receivedQuantity: 100,
    });
    const lot = (await h.service.getBalance(h.session, item.id as never)).lots[0]!;
    await h.service.issueStock(h.session, {
      batchId: lot.lot.id as never,
      quantity: 10,
      movementType: 'OUT',
      reason: 'consumption',
    });
    const audits = await h.audit.list();
    const types = audits
      .filter((a) => a.objectType.startsWith('inventory-'))
      .map((a) => a.objectType);
    // item → lot (+ its receipt IN movement) → issue movement.
    assert.deepEqual(types, [
      'inventory-item',
      'inventory-lot',
      'inventory-movement',
      'inventory-movement',
    ]);
    for (const event of audits) {
      if (event.detail) {
        assert.ok(!/patient|name:/i.test(event.detail), `PHI in detail: ${event.detail}`);
      }
    }
  });
});

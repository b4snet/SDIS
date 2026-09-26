/**
 * Inventory — disposable PostgreSQL tests (Step 14).
 *
 * Proves migration 012 from an empty database, item/lot persistence with the
 * derived movement ledger (no balance column), schema-enforced uniqueness,
 * facility/tenant isolation, atomic movement behavior (an insufficient-stock
 * rejection leaves NO movement row), and durable Postgres idempotency replay
 * without duplicate rows or audit events.
 *
 * SQL is used as evidence of persistence, never as the contract.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { ConflictError, NotFoundError, ValidationError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import type { InventoryItemId } from '../../src/types/ids';

const PORT = 55449;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'lab-storekeeper' },
    userId: 'lab-storekeeper',
    roles: ['operator'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
});

after(async () => {
  await teardownTestDatabase();
});

let skuCounter = 0;
function nextSku(): string {
  skuCounter += 1;
  return `PG-RG-${skuCounter}`;
}

describe('inventory postgres: migration and persistence', () => {
  it('migration 012 created the tables with RLS from an empty database', async () => {
    for (const table of ['inventory_items', 'inventory_lots', 'stock_movements']) {
      const reg = await db.query(`SELECT to_regclass('sdis.${table}') AS reg`);
      assert.ok(reg.rows[0]?.reg, `${table} must exist`);
      const policy = await db.query<{ polname: string }>(
        `SELECT polname FROM pg_policy WHERE polrelid = 'sdis.${table}'::regclass`,
      );
      assert.ok((policy.rowCount ?? 0) >= 2, `${table} must carry RLS policies`);
    }
  });

  it('derives the balance from the ledger — no stored balance column', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'sdis' AND table_name IN ('inventory_items','inventory_lots')`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(!names.includes('balance'), 'balance must be derived, never stored');
    assert.ok(names.includes('received_quantity'), 'the lot receipt must be recorded');

    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic reagent',
      category: 'REAGENT',
    });
    const lot = await runtime.inventory.registerLot(session(), {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-1',
      expiryDate: '2027-06-30',
      receivedQuantity: 30,
    });
    assert.ok(lot.id);

    const movements = await db.query(
      `SELECT quantity_signed, movement_type FROM sdis.stock_movements WHERE lot_id = $1`,
      [lot.id],
    );
    assert.equal(movements.rowCount, 1);
    assert.equal(Number(movements.rows[0]?.quantity_signed), 30);
    assert.equal(movements.rows[0]?.movement_type, 'IN');

    const rows = await db.query(
      `SELECT lot_number FROM sdis.inventory_lots WHERE id = $1`,
      [lot.id],
    );
    assert.equal(rows.rows[0]?.lot_number, 'PG-LOT-1');
  });

  it('records issue movements and reports the derived balance and expiry', async () => {
    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic calibrator',
      category: 'CALIBRATOR',
    });
    await runtime.inventory.registerLot(session(), {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-2',
      expiryDate: '2020-01-01',
      receivedQuantity: 20,
    });
    const balance = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    assert.equal(balance.totalBalance, 20);
    assert.equal(balance.lots[0]?.lot.expiryStatus, 'EXPIRED');

    const movement = await runtime.inventory.issueStock(session(), {
      batchId: balance.lots[0]!.lot.id as InventoryItemId,
      quantity: 8,
      movementType: 'WASTAGE',
      reason: 'damaged vial',
    });
    assert.equal(movement.quantitySigned, -8);
    const after19 = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    assert.equal(after19.totalBalance, 12);
  });

  it('enforces item SKU and lot-number uniqueness at the schema level', async () => {
    const sku = nextSku();
    const item = await runtime.inventory.registerItem(session(), {
      sku,
      name: 'Synthetic consumable',
      category: 'CONSUMABLE',
    });
    await assert.rejects(
      () =>
        runtime.inventory.registerItem(session(), {
          sku,
          name: 'Duplicate synthetic item',
          category: 'CONSUMABLE',
        }),
      ConflictError,
    );
    await runtime.inventory.registerLot(session(), {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-DUP',
      expiryDate: '2027-06-30',
      receivedQuantity: 5,
    });
    await assert.rejects(
      () =>
        runtime.inventory.registerLot(session(), {
          itemId: item.id as InventoryItemId,
          lotNumber: 'PG-LOT-DUP',
          expiryDate: '2028-01-01',
          receivedQuantity: 5,
        }),
      ConflictError,
    );
  });

  it('rejects an over-issue with NO partial movement row (ledger atomicity)', async () => {
    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic control',
      category: 'CONTROL',
    });
    await runtime.inventory.registerLot(session(), {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-3',
      expiryDate: '2027-06-30',
      receivedQuantity: 10,
    });
    const balance = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    const lotId = balance.lots[0]!.lot.id;
    const before20 = await db.query(
      `SELECT count(*)::int AS n FROM sdis.stock_movements WHERE lot_id = $1`,
      [lotId],
    );
    await assert.rejects(
      () =>
        runtime.inventory.issueStock(session(), {
          batchId: lotId as InventoryItemId,
          quantity: 999,
          movementType: 'OUT',
          reason: 'test issue',
        }),
      ValidationError,
    );
    const after20 = await db.query(
      `SELECT count(*)::int AS n FROM sdis.stock_movements WHERE lot_id = $1`,
      [lotId],
    );
    assert.equal(after20.rows[0]?.n, before20.rows[0]?.n, 'no partial movement');
  });

  it('serializes concurrent distinct-key depletions: one winner, never negative (CON-01)', async () => {
    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic race control',
      category: 'CONTROL',
    });
    await runtime.inventory.registerLot(session(), {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-RACE',
      expiryDate: '2027-06-30',
      receivedQuantity: 10,
    });
    const balance = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    const lotId = balance.lots[0]!.lot.id as InventoryItemId;
    // Four competing depletions with DISTINCT idempotency keys (so the
    // per-key single-flight cannot serialize them): balance covers exactly
    // one. Under READ COMMITTED more racers widen the overlap window in
    // which a lock-free check would let several pass.
    const outcomes = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((racer) =>
        runtime.inventory.issueStock(session(), {
          batchId: lotId,
          quantity: 10,
          movementType: 'OUT',
          reason: `concurrent issue ${racer}`,
          idempotencyKey: `con-01-racer-${racer}`,
        }),
      ),
    );
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one depletion wins');
    assert.equal(rejected.length, 3, 'every other depletion is rejected');
    for (const outcome of rejected) {
      assert.match(
        String((outcome as PromiseRejectedResult).reason),
        /Insufficient stock/,
      );
    }
    // Ledger invariant: receipt (+10) plus exactly one issue (-10); the
    // derived balance is 0 and never went negative.
    const ledger = await db.query<{ quantity_signed: string }>(
      `SELECT quantity_signed FROM sdis.stock_movements WHERE lot_id = $1 ORDER BY at, id`,
      [lotId],
    );
    assert.equal(ledger.rows.length, 2, 'receipt plus exactly one issue');
    const running = ledger.rows.map((r) => Number(r.quantity_signed));
    assert.deepEqual(running, [10, -10]);
    let cumulative = 0;
    for (const delta of running) {
      cumulative += delta;
      assert.ok(cumulative >= 0, 'ledger never goes negative');
    }
    const finalBalance = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    assert.equal(finalBalance.totalBalance, 0);
  });
});

describe('inventory postgres: isolation, idempotency, and audit', () => {
  it('keeps facility boundaries: another facility cannot reach the item', async () => {
    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic kit',
      category: 'KIT',
    });
    await assert.rejects(
      () =>
        runtime.inventory.getBalance(session(OTHER_FACILITY), item.id as InventoryItemId),
      NotFoundError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () =>
        runtime.inventory.registerItem(session(FACILITY, OTHER_ORG), {
          sku: nextSku(),
          name: 'Forged synthetic item',
          category: 'OTHER',
        }),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'SCOPE_MISMATCH');
        return true;
      },
    );
  });

  it('replays a keyed receipt durably — one movement row, one audit event', async () => {
    const item = await runtime.inventory.registerItem(session(), {
      sku: nextSku(),
      name: 'Synthetic reagent for replay',
      category: 'REAGENT',
    });
    const input = {
      itemId: item.id as InventoryItemId,
      lotNumber: 'PG-LOT-RETRY',
      expiryDate: '2027-06-30',
      quantity: 7,
      idempotencyKey: 'pg-receipt-1',
    };
    const first = await runtime.inventory.receiveStock(session(), input);
    const second = await runtime.inventory.receiveStock(session(), input);
    assert.equal(second.id, first.id);

    const rows = await db.query(`SELECT id FROM sdis.stock_movements WHERE id = $1`, [
      first.id,
    ]);
    assert.equal(rows.rowCount, 1);
    const balance = await runtime.inventory.getBalance(
      session(),
      item.id as InventoryItemId,
    );
    assert.equal(balance.totalBalance, 7);

    const audit = await db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM sdis.audit_events
           WHERE object_type = 'inventory-movement' AND object_id = $1`,
      [first.id],
    );
    assert.equal(Number(audit.rows[0]?.n), 1, 'no duplicate audit on replay');
  });
});

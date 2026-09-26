/**
 * Billing — disposable PostgreSQL tests.
 *
 * Proves migration 009 from an empty database, charge persistence with real
 * order linkage (a REAL order created through the order service over the
 * seeded patient/encounter), schema-level idempotency-key uniqueness (23505)
 * as the last line of defense, cross-scope isolation, audit persistence, and
 * durable Postgres-store replay without duplicate rows or audit.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { BillingService } from '../../src/app/billing/billing-service';
import { PostgresChargeRepository } from '../../src/infrastructure/database/billing-repository';
import {
  PostgresAuditPort,
  PostgresFacilityDirectory,
  PostgresIdempotencyStore,
} from '../../src/infrastructure/database/repositories';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { ConflictError, NotFoundError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId } from '../../src/types/ids';
import type { BillableServiceId, ChargeId } from '../../src/types/ids';
import type { ChargeDTO } from '../../src/app/billing/billing-service';

const PORT = 55445;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';
const SERVICE = toBrandedId('00000000-0000-4000-8000-0000000003f1') as BillableServiceId;

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'billing-clerk' },
    userId: 'billing-clerk',
    roles: ['manager', 'operator', 'viewer'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let billing: BillingService;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;
let charges: PostgresChargeRepository;

async function seedService(id: BillableServiceId, amount: string): Promise<void> {
  await db.query(
    `INSERT INTO sdis.billable_services (id, facility_id, name, modality, price_amount, price_currency)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
    [id, FACILITY, 'CBC — Complete Blood Count', 'LAB', amount, 'NPR'],
  );
}

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
  charges = new PostgresChargeRepository(db);
  billing = new BillingService({
    orders: runtime.orders,
    charges,
    facilities: new PostgresFacilityDirectory(db),
    audit: new PostgresAuditPort(db),
    idempotency: new PostgresIdempotencyStore(db),
  });
  await seedService(SERVICE, '350.00');
});

after(async () => {
  await teardownTestDatabase();
});

async function createLabOrder(): Promise<{ orderId: string; itemId: string }> {
  const order = await runtime.orders.createOrder(session(), {
    patientId: toBrandedId(PATIENT) as never,
    encounterId: toBrandedId(ENCOUNTER) as never,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  });
  return { orderId: order.id, itemId: order.items[0]!.id };
}

describe('billing postgres: persistence', () => {
  it('migration 009 created both tables with RLS policies from an empty database', async () => {
    const chargesTable = await db.query(`SELECT to_regclass('sdis.charges') AS reg`);
    assert.ok(chargesTable.rows[0]?.reg, 'charges table must exist');
    const servicesTable = await db.query(
      `SELECT to_regclass('sdis.billable_services') AS reg`,
    );
    assert.ok(servicesTable.rows[0]?.reg, 'billable_services table must exist');
    const policies = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy
             WHERE polrelid IN ('sdis.charges'::regclass, 'sdis.billable_services'::regclass)`,
    );
    assert.ok((policies.rowCount ?? 0) >= 4, 'RLS policies must exist');
  });

  it('persists a charge linked to a real order item at the recorded price', async () => {
    const { orderId, itemId } = await createLabOrder();
    const charge = await billing.createCharge(session(), {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
    });
    const row = await db.query<{
      order_item_id: string;
      service_id: string;
      amount: string;
      currency: string;
      facility_id: string;
    }>(
      `SELECT c.order_item_id, c.service_id, c.amount, c.currency, c.facility_id
             FROM sdis.charges c WHERE c.id = $1`,
      [charge.id],
    );
    assert.equal(row.rowCount, 1);
    assert.equal(row.rows[0]?.order_item_id, itemId);
    assert.equal(row.rows[0]?.service_id, SERVICE);
    assert.equal(row.rows[0]?.amount, '350.00');
    assert.equal(row.rows[0]?.currency, 'NPR');
    assert.equal(row.rows[0]?.facility_id, FACILITY);
    // Linkage: the charged item belongs to the scope-verified order.
    const link = await db.query<{ order_id: string }>(
      'SELECT order_id FROM sdis.order_items WHERE id = $1',
      [itemId],
    );
    assert.equal(link.rows[0]?.order_id, orderId);
  });

  it('enforces idempotency-key uniqueness at the schema level (23505)', async () => {
    const { orderId, itemId } = await createLabOrder();
    await billing.createCharge(session(), {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
      idempotencyKey: 'charge-unique-1',
    });
    const raw = await db
      .query(
        `INSERT INTO sdis.charges (order_item_id, service_id, facility_id, amount, currency, idempotency_key)
             VALUES ($1, $2, $3, $4, $5, $6)`,
        [itemId, SERVICE, FACILITY, '350.00', 'NPR', 'charge-unique-1'],
      )
      .catch((error: { code?: string }) => error);
    assert.equal((raw as { code?: string }).code, '23505');
  });

  it('rejects charging the same item twice for the same service (CONFLICT)', async () => {
    const { orderId, itemId } = await createLabOrder();
    const input = {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
    };
    await billing.createCharge(session(), input);
    await assert.rejects(() => billing.createCharge(session(), input), ConflictError);
  });

  it('keeps facility boundaries: another facility session cannot read the charge', async () => {
    const { orderId, itemId } = await createLabOrder();
    const charge = await billing.createCharge(session(), {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
    });
    await assert.rejects(
      () => billing.getCharge(session(OTHER_FACILITY), charge.id as ChargeId),
      (error: unknown) => error instanceof Error && /scope/i.test(error.message),
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    const { orderId, itemId } = await createLabOrder();
    await assert.rejects(
      () =>
        billing.createCharge(session(FACILITY, OTHER_ORG), {
          orderId: orderId as never,
          orderItemId: itemId as never,
          serviceId: SERVICE,
        }),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('persists audit events for charge creation', async () => {
    const { orderId, itemId } = await createLabOrder();
    const charge = await billing.createCharge(session(), {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
    });
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'charge' AND object_id = $1`,
      [charge.id],
    );
    assert.equal(audit.rows[0]?.count, '1');
  });

  it('replays durably: same key, one charge row, one audit event', async () => {
    const { orderId, itemId } = await createLabOrder();
    const input = {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
      idempotencyKey: 'charge-durable-replay-1',
    };
    const first = await billing.createCharge(session(), input);
    const replay = await billing.createCharge(session(), input);
    assert.equal(replay.id, first.id);
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.charges WHERE order_item_id = $1',
      [itemId],
    );
    assert.equal(rows.rows[0]?.count, '1');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'charge' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1');
  });

  it('unknown billable service surfaces as NOT_FOUND', async () => {
    const { orderId, itemId } = await createLabOrder();
    await assert.rejects(
      () =>
        billing.createCharge(session(), {
          orderId: orderId as never,
          orderItemId: itemId as never,
          serviceId: toBrandedId(
            '00000000-0000-4000-8000-0000000003f9',
          ) as BillableServiceId,
        }),
      NotFoundError,
    );
  });

  it('BILL-01 regression: concurrent dual-create (different keys) yields exactly one charge and one conflict', async () => {
    const { orderId, itemId } = await createLabOrder();
    const inputA = {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
      idempotencyKey: 'bill-01-concurrent-a',
    };
    const inputB = {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
      idempotencyKey: 'bill-01-concurrent-b',
    };
    const outcomes = await Promise.allSettled([
      billing.createCharge(session(), inputA),
      billing.createCharge(session(), inputB),
    ]);
    const fulfilled = outcomes.filter(
      (o): o is PromiseFulfilledResult<ChargeDTO> => o.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (o): o is PromiseRejectedResult => o.status === 'rejected',
    );
    assert.equal(
      fulfilled.length,
      1,
      'the schema-unique (order_item, service) must admit exactly one writer',
    );
    assert.equal(rejected.length, 1);
    assert.ok(
      rejected[0]!.reason instanceof ConflictError,
      'the losing writer must surface the existing CONFLICT contract',
    );
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.charges WHERE order_item_id = $1',
      [itemId],
    );
    assert.equal(rows.rows[0]?.count, '1');
  });

  it('BILL-02 regression: save() for a non-existent order item throws and writes nothing', async () => {
    const ghostItem = toBrandedId('00000000-0000-4000-8000-000000000999');
    const before = await chargeRowCount();
    await assert.rejects(
      charges.save({
        id: toBrandedId('00000000-0000-4000-8000-000000000998') as ChargeId,
        orderItemId: ghostItem as never,
        serviceId: SERVICE,
        amount: 350,
        currency: 'NPR',
        createdAt: new Date().toISOString(),
        idempotencyKey: 'bill-02-ghost-item',
      }),
      (error: unknown) => error instanceof NotFoundError,
      'saving a charge against a missing order item must fail loudly',
    );
    const after = await chargeRowCount();
    assert.equal(after, before, 'no row may be written for a missing order item');
  });

  it('BILL-04 regression: keyed replay after idempotency-store expiry is served from the ledger row', async () => {
    const { orderId, itemId } = await createLabOrder();
    const input = {
      orderId: orderId as never,
      orderItemId: itemId as never,
      serviceId: SERVICE,
      idempotencyKey: 'bill-04-post-ttl-replay',
    };
    const first = await billing.createCharge(session(), input);
    // Expire the idempotency-store entry (24 h TTL lapsed).
    await db.query(
      `UPDATE sdis.idempotency_keys
          SET expires_at = now() - interval '1 second'
        WHERE key = 'charge.create:bill-04-post-ttl-replay'`,
    );
    const replay = await billing.createCharge(session(), input);
    assert.equal(replay.id, first.id, 'replay must return the stored first result');
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.charges WHERE order_item_id = $1',
      [itemId],
    );
    assert.equal(rows.rows[0]?.count, '1', 'no duplicate charge row');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
             WHERE object_type = 'charge' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1', 'no duplicate audit event');
  });
});

async function chargeRowCount(): Promise<number> {
  const result = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sdis.charges',
  );
  return Number(result.rows[0]?.count ?? 0);
}

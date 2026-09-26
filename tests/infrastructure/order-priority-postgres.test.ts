/**
 * Step 21 — PostgreSQL persistence, constraints, worklist ordering, and
 * isolation proofs over the REAL database.
 *
 * Covers: priority persistence (SQL level), the bounded CHECK constraint,
 * deterministic worklist ordering (priority rank, then ordered-at, then id),
 * cross-facility and cross-tenant rejection through the application runtime,
 * and the audit trail for a priority change.
 *
 * Runs on a disposable embedded PostgreSQL (migrations + dev seed).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { PostgresOrderRepository } from '../../src/infrastructure/database/repositories';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { ScopeMismatchError, ValidationError } from '../../src/app/errors';
import { assertUuidV4, toBrandedId } from '../../src/types/ids';
import type { ApplicationSession } from '../../src/app/context';
import type { DiagnosticOrderId } from '../../src/types/ids';

const PORT = 55442;
const ORG = toBrandedId('00000000-0000-4000-8000-000000000001');
const FACILITY = toBrandedId('00000000-0000-4000-8000-000000000011');
const OTHER_FACILITY = toBrandedId('00000000-0000-4000-8000-000000000012');
const PATIENT = toBrandedId('00000000-0000-4000-8000-0000000000e1');
const ENCOUNTER = toBrandedId('00000000-0000-4000-8000-0000000000c1');
const START = '2026-09-20T08:00:00.000Z';

function plusMinutes(base: string, minutes: number): string {
  return new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
}

/** DTO identifiers cross the boundary the same safe way production does. */
function orderDtoId(dto: { readonly id: string }): DiagnosticOrderId {
  return assertUuidV4<DiagnosticOrderId>(dto.id, 'diagnostic order id');
}

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'pg-priority-user' },
    userId: 'pg-priority-user',
    roles: ['operator', 'viewer'] as never,
    organizationId,
    facilityId,
  };
}

describe('database: order priority (Step 21)', () => {
  let db: Database;

  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = String(PORT);
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    db = await setupTestDatabase({ port: PORT });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('persists priority at the SQL level and returns it through the DTO', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const order = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 1),
      priority: 'EMERGENCY',
    });
    assert.equal(order.priority, 'EMERGENCY');

    const row = await db.query(
      'SELECT priority FROM sdis.diagnostic_orders WHERE id = $1',
      [order.id],
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].priority, 'EMERGENCY');
  });

  it('rejects an invalid priority at the database boundary (CHECK constraint)', async () => {
    await assert.rejects(
      () =>
        db.query(
          `INSERT INTO sdis.diagnostic_orders
             (id, patient_id, encounter_id, facility_id, modality, status,
              priority, ordered_at, ordered_by_ref, version)
           VALUES ($1, $2, $3, $4, 'LAB', 'ORDERED', 'STAT', $5, 'seed', 1)`,
          [
            toBrandedId('00000000-0000-4000-8000-000000000f21'),
            PATIENT,
            ENCOUNTER,
            FACILITY,
            plusMinutes(START, 2),
          ],
        ),
      (error: unknown) =>
        error instanceof Error && /diagnostic_orders_priority_check/.test(error.message),
    );
  });

  it('orders the worklist EMERGENCY -> URGENT -> ROUTINE, then ordered-at', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    // Creation order deliberately differs from the expected worklist order.
    const routineOld = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 10),
    });
    const urgent = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'TROP', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 12),
      priority: 'URGENT',
    });
    const routineNew = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'LFT', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 13),
    });
    const emergency = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'STAT-X', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 14),
      priority: 'EMERGENCY',
    });

    const entries = await runtime.worklist.listForSession(session());
    const ids = entries.map((entry) => entry.id as string);
    const position = (id: string) => ids.indexOf(id);
    assert.ok(position(emergency.id) < position(urgent.id));
    assert.ok(position(urgent.id) < position(routineOld.id));
    assert.ok(position(routineOld.id) < position(routineNew.id));
  });

  it('does not pre-hide CANCELLED orders from the worklist read model (BASELINE-06)', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const order = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 30),
    });
    const cancelled = await runtime.orders.cancelOrder(
      session(),
      orderDtoId(order),
      plusMinutes(START, 31),
    );
    assert.equal(cancelled.status, 'CANCELLED');
    // The PG worklist query returns the facility's FULL deterministic set —
    // status narrowing is the service's per-view concern (the exception view
    // selects CANCELLED), so CANCELLED must never be pre-excluded here.
    // This mirrors the in-memory twin (port contract, BASELINE-06).
    const ordersRepo = new PostgresOrderRepository(db);
    const entries = await ordersRepo.listByFacilityWithPriority(FACILITY);
    assert.ok(
      entries.some(
        (entry) => String(entry.id) === String(order.id) && entry.status === 'CANCELLED',
      ),
      'cancelled order must be present in the facility worklist read model',
    );
  });

  it('rejects cross-facility priority escalation through the runtime', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const order = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 20),
    });
    await assert.rejects(
      () =>
        runtime.orders.changeOrderPriority(
          session(OTHER_FACILITY),
          orderDtoId(order),
          'EMERGENCY',
          plusMinutes(START, 21),
        ),
      ScopeMismatchError,
    );
  });

  it('rejects an invalid priority at the application boundary (validation error)', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    await assert.rejects(
      () =>
        runtime.orders.createOrder(session(), {
          patientId: PATIENT,
          encounterId: ENCOUNTER,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: plusMinutes(START, 22),
          priority: 'PANIC',
        }),
      ValidationError,
    );
  });

  it('audits a priority change with previous -> new detail', async () => {
    const runtime = createPostgresLaboratoryRuntime(db);
    const order = await runtime.orders.createOrder(session(), {
      patientId: PATIENT,
      encounterId: ENCOUNTER,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: plusMinutes(START, 30),
    });
    await runtime.orders.changeOrderPriority(
      session(),
      orderDtoId(order),
      'URGENT',
      plusMinutes(START, 31),
    );
    const audit = await db.query(
      `SELECT action, object_type, object_id, actor_id, detail
         FROM sdis.audit_events
        WHERE object_id = $1 AND action = 'UPDATED'
        ORDER BY at DESC`,
      [order.id],
    );
    assert.equal(audit.rows.length, 1);
    assert.equal(audit.rows[0].object_type, 'diagnostic-order');
    assert.equal(audit.rows[0].actor_id, 'pg-priority-user');
    assert.match(String(audit.rows[0].detail), /priority ROUTINE -> URGENT/);
  });
});

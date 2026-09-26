/**
 * LAB-02 regression — order/specimen transition lost-update guard (version CAS).
 *
 * Pre-fix, `PostgresOrderRepository.save` / `PostgresSpecimenRepository.save`
 * upserted with `ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status` and
 * a version column that was bumped but never read. Two concurrent transitions
 * that both read the same starting state both validated against their stale
 * snapshot and both succeeded — the last write won, silently discarding the
 * other writer's committed transition.
 *
 * Fix: the domain aggregates now carry `version` (the version the caller
 * read); the repositories refuse an UPDATE whose version no longer matches the
 * persisted row, surfacing ConflictError instead of a silent overwrite.
 *
 * These tests use TWO separate `Database` pools — the cross-process shape the
 * ledger describes. Every test uses its OWN order/specimen ids so the suites
 * stay isolated in the shared disposable database.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { Database } from '../../src/infrastructure/database/database';
import {
  PostgresOrderRepository,
  PostgresSpecimenRepository,
} from '../../src/infrastructure/database/repositories';
import { ConflictError } from '../../src/app/errors';
import { toBrandedId } from '../../src/types/ids';
import type { DiagnosticOrder } from '../../src/domain/ordering/diagnostic-order';
import type { Specimen } from '../../src/domain/specimen/specimen';

const PORT = 55458;

const PATIENT_A = toBrandedId('00000000-0000-4000-8000-0000000000e1');
const ENCOUNTER_A = toBrandedId('00000000-0000-4000-8000-0000000000c1');
const FAC_A1 = toBrandedId('00000000-0000-4000-8000-000000000011');

function orderLiteral(orderId: string, itemId: string): DiagnosticOrder {
  return {
    id: orderId as DiagnosticOrder['id'],
    patientId: PATIENT_A,
    encounterId: ENCOUNTER_A,
    facilityId: FAC_A1,
    priority: 'ROUTINE',
    modality: 'LAB',
    status: 'ORDERED',
    orderedAt: '2026-09-20T08:00:00.000Z',
    orderedByRef: 'user-tech-1',
    version: 1,
    items: [
      {
        id: itemId as DiagnosticOrder['items'][number]['id'],
        orderId: orderId as DiagnosticOrder['items'][number]['orderId'],
        testCode: 'CBC',
        codeSystem: 'sdis',
      },
    ],
  };
}

function specimenLiteral(specimenId: string, itemId: string): Specimen {
  return {
    id: specimenId as Specimen['id'],
    orderItemId: itemId as Specimen['orderItemId'],
    patientId: PATIENT_A,
    kind: 'BLOOD',
    collectedAt: '2026-09-20T08:01:00.000Z',
    collectedByRef: 'user-tech-1',
    status: 'COLLECTED',
    version: 1,
  };
}

describe('LAB-02: optimistic concurrency (version CAS)', () => {
  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = String(PORT);
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    await setupTestDatabase({ port: PORT });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('order: a stale snapshot save loses with CONFLICT; the committed transition is never overwritten', async () => {
    const poolA = new Database();
    const poolB = new Database();
    const repoA = new PostgresOrderRepository(poolA);
    const repoB = new PostgresOrderRepository(poolB);
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a1');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a2');
    try {
      const created = await repoA.save(orderLiteral(orderId, itemId));
      assert.equal(created.version, 1, 'fresh insert persists at the initial version');

      // Both "processes" read the SAME starting state (version 1).
      const snapshotA = await repoA.findById(orderId);
      const snapshotB = await repoB.findById(orderId);
      assert.ok(snapshotA && snapshotB);
      assert.equal(snapshotA.version, 1);
      assert.equal(snapshotB.version, 1);

      // Process A wins the race: ORDERED -> ACQUIRED applies.
      const winner = await repoA.save({
        ...snapshotA,
        status: 'ACQUIRED',
      } as DiagnosticOrder);
      assert.equal(winner.status, 'ACQUIRED');
      assert.equal(winner.version, 2);

      // Process B carries a stale snapshot (version 1): ORDERED -> CANCELLED
      // must be refused, never silently overriding A's ACQUIRED.
      await assert.rejects(
        repoB.save({ ...snapshotB, status: 'CANCELLED' } as DiagnosticOrder),
        (error) => error instanceof ConflictError,
        'stale snapshot must surface CONFLICT, not a silent overwrite',
      );

      // Final state is monotonic: the loser's write did not regress the flow.
      const final = await repoA.findById(orderId);
      assert.ok(final);
      assert.equal(final.status, 'ACQUIRED');
      assert.equal(final.version, 2);
    } finally {
      await Promise.all([poolA.close(), poolB.close()]);
    }
  });

  it('order: same-state race — exactly one apply wins, the loser gets CONFLICT', async () => {
    const poolA = new Database();
    const poolB = new Database();
    const repoA = new PostgresOrderRepository(poolA);
    const repoB = new PostgresOrderRepository(poolB);
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a3');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a4');
    try {
      // Fresh order (version 1).
      await repoA.save(orderLiteral(orderId, itemId));
      const snapA = await repoA.findById(orderId);
      const snapB = await repoB.findById(orderId);
      assert.ok(snapA && snapB);

      const [a, b] = await Promise.allSettled([
        repoA.save({ ...snapA, status: 'ACQUIRED' } as DiagnosticOrder),
        repoB.save({ ...snapB, status: 'ACQUIRED' } as DiagnosticOrder),
      ]);
      const applied = a.status === 'fulfilled' ? a : b;
      const rejected = a.status === 'rejected' ? a : b;
      assert.equal(applied.status, 'fulfilled', 'exactly one writer applies');
      assert.equal(rejected.status, 'rejected', 'the other writer loses the race');
      assert.ok(
        rejected.status === 'rejected' && rejected.reason instanceof ConflictError,
        'loser gets CONFLICT',
      );
    } finally {
      await Promise.all([poolA.close(), poolB.close()]);
    }
  });

  it('specimen: a stale transition loses with CONFLICT; version advances monotonically', async () => {
    const poolA = new Database();
    const poolB = new Database();
    const orderRepo = new PostgresOrderRepository(poolA);
    const specimenRepoA = new PostgresSpecimenRepository(poolA);
    const specimenRepoB = new PostgresSpecimenRepository(poolB);
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a5');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a6');
    const specimenId = toBrandedId('00000000-0000-4000-8000-0000000000b5');
    try {
      await orderRepo.save(orderLiteral(orderId, itemId));
      // Both processes read COLLECTED -> version 1.
      const winner = await specimenRepoA.save(specimenLiteral(specimenId, itemId));
      assert.equal(winner.status, 'COLLECTED');
      assert.equal(winner.version, 1, 'fresh specimen insert at the initial version');

      const snapshotB = await specimenRepoB.findById(specimenId);
      assert.ok(snapshotB);
      assert.equal(snapshotB.version, 1);

      // Process A applies RECEIVED (version 1 -> 2).
      const advanced = await specimenRepoA.save({
        ...snapshotB,
        status: 'RECEIVED',
      } as Specimen);
      assert.equal(advanced.status, 'RECEIVED');
      assert.equal(advanced.version, 2);

      // Process B still holds version 1 and tries COLLECTED -> REJECTED.
      await assert.rejects(
        // snapshotB is the v1 read; REJECTED is a legal target from COLLECTED,
        // but B's snapshot is stale — the CAS must refuse it.
        specimenRepoB.save({ ...snapshotB, status: 'REJECTED' } as Specimen),
        (error) => error instanceof ConflictError,
        'specimen stale write must surface CONFLICT',
      );

      const final = await specimenRepoA.findById(specimenId);
      assert.ok(final);
      assert.equal(final.status, 'RECEIVED');
      assert.equal(final.version, 2);
    } finally {
      await Promise.all([poolA.close(), poolB.close()]);
    }
  });

  it('fresh re-reads continue the chain — no false positives for sequential transitions', async () => {
    const pool = new Database();
    const repo = new PostgresOrderRepository(pool);
    const orderId = toBrandedId('00000000-0000-4000-8000-0000000000a7');
    const itemId = toBrandedId('00000000-0000-4000-8000-0000000000a8');
    try {
      await repo.save(orderLiteral(orderId, itemId));
      let current = await repo.findById(orderId);
      assert.ok(current);
      for (const status of ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const) {
        const next = await repo.save({ ...current, status } as DiagnosticOrder);
        assert.equal(next.status, status);
        current = next;
      }
      const final = await repo.findById(orderId);
      assert.ok(final);
      assert.equal(final.status, 'RESULT_ENTERED');
      assert.equal(final.version, 4);
    } finally {
      await pool.close();
    }
  });
});

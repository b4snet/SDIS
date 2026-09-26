/**
 * Data-integrity, concurrency & idempotency hardening (Step 33, INT-33).
 *
 * Regression evidence for the integrity boundary:
 *  - §10 same-key/different-payload protection (fingerprint, hash-only storage)
 *  - §11 concurrent same-key idempotent creation (single authoritative result)
 *  - §37 repository CAS parity: the in-memory adapters refuse stale writes
 *    exactly like PostgreSQL (no weaker test double)
 *  - §14 stock floor: concurrent in-process consumers cannot overdraw a lot
 *  - §9 setup-config replays are facility-scoped (Step-32 residual closed)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  InMemoryIdempotencyStore,
  InMemoryOrderRepository,
  InMemorySpecimenRepository,
} from '../../src/app/in-memory';
import { InMemoryInventoryRepository } from '../../src/app/in-memory-inventory';
import { InMemorySetupConfigRepository } from '../../src/app/in-memory-setup';
import { createFixture, sessionFor, at, OTHER_FACILITY } from './helpers';
import {
  requestFingerprintOf,
  scopedIdempotencyKey,
  IDEMPOTENCY_SCOPES,
  RequestFingerprintMismatchError,
} from '../../src/app/idempotency';
import { ConflictError, ValidationError } from '../../src/app/errors';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { SetupConfigService } from '../../src/app/setup/setup-config-service';
import {
  toBrandedId,
  type FacilityId,
  type InventoryItemId,
  type OrderItemId,
  type PatientId,
  type SpecimenId,
} from '../../src/types/ids';
import type { ApplicationSession } from '../../src/app/context';
import type { FacilityDirectory } from '../../src/app/ports';
import type {
  DiagnosticOrder,
  OrderItem,
} from '../../src/domain/ordering/diagnostic-order';
import type { Specimen } from '../../src/domain/specimen/specimen';
import type { StockBatch, StockMovement } from '../../src/domain/inventory/inventory';

/** A staff-tier session (operator) — the fixture does not auto-role it. */
function operator(facilityId?: FacilityId): ApplicationSession {
  const session = sessionFor(facilityId);
  (session as { roles?: readonly string[] }).roles = ['operator'] as never;
  return session;
}

const ORDER_INPUT = {
  patientId: toBrandedId('00000000-0000-4000-8000-0000000000e1') as PatientId,
  encounterId: toBrandedId('00000000-0000-4000-8000-0000000000c1'),
  modality: 'LAB' as const,
  items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
  orderedAt: at(0),
  idempotencyKey: 'int33-order-001',
};

describe('integrity: same-key/different-payload protection (§10)', () => {
  it('rejects a replayed key carrying a DIFFERENT logical operation', async () => {
    const fixture = createFixture();
    const session = operator();
    const first = await fixture.orders.createOrder(session, ORDER_INPUT);
    assert.ok(first.id);

    await assert.rejects(
      fixture.orders.createOrder(session, {
        ...ORDER_INPUT,
        items: [{ testCode: 'LFT', codeSystem: 'sdis' }],
      }),
      (error: unknown) => {
        assert.ok(error instanceof RequestFingerprintMismatchError);
        assert.equal((error as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
        return true;
      },
    );
  });

  it('serves the stored result for the same logical operation with a regenerated timestamp', async () => {
    const fixture = createFixture();
    const session = operator();
    const first = await fixture.orders.createOrder(session, ORDER_INPUT);
    // A client retry legitimately regenerates its clock (recovery contract).
    const retry = await fixture.orders.createOrder(session, {
      ...ORDER_INPUT,
      orderedAt: at(30),
    });
    assert.equal(retry.id, first.id, 'same logical operation must replay');
  });

  it('stores only the SHA-256 fingerprint — never the request payload', async () => {
    const fixture = createFixture();
    const session = operator();
    await fixture.orders.createOrder(session, ORDER_INPUT);
    const store = (
      fixture.orders as unknown as { deps: { idempotency: InMemoryIdempotencyStore } }
    ).deps.idempotency;
    const fp = await store.get<string>(
      `${scopedIdempotencyKey(IDEMPOTENCY_SCOPES.ORDER_CREATE, session, ORDER_INPUT.idempotencyKey)}:fp`,
    );
    assert.ok(fp, 'fingerprint record exists');
    assert.match(fp as string, /^[0-9a-f]{64}$/, 'fingerprint is a hex digest');
    assert.equal(
      (fp as string).includes('CBC'),
      false,
      'no payload fragment is recoverable from the record',
    );
    // Determinism: the digest of the same logical shape is stable.
    assert.equal(
      fp,
      requestFingerprintOf({
        patientId: ORDER_INPUT.patientId,
        encounterId: ORDER_INPUT.encounterId,
        modality: ORDER_INPUT.modality,
        priority: 'ROUTINE',
        items: ORDER_INPUT.items,
        source: { kind: 'HUMAN', label: 'application order entry' },
      }),
    );
  });
});

describe('integrity: concurrent idempotent creation (§11)', () => {
  it('two racing same-key creates commit exactly one order and share the result', async () => {
    const fixture = createFixture();
    const session = operator();
    const [a, b] = await Promise.all([
      fixture.orders.createOrder(session, ORDER_INPUT),
      fixture.orders.createOrder(session, ORDER_INPUT),
    ]);
    assert.equal(a.id, b.id, 'both callers receive the same authoritative order');
  });

  it('a different payload racing the same key resolves to a safe conflict', async () => {
    const fixture = createFixture();
    const session = operator();
    const results = await Promise.allSettled([
      fixture.orders.createOrder(session, ORDER_INPUT),
      fixture.orders.createOrder(session, {
        ...ORDER_INPUT,
        items: [{ testCode: 'LFT', codeSystem: 'sdis' }],
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const mismatch = results.find(
      (r) =>
        r.status === 'rejected' && r.reason instanceof RequestFingerprintMismatchError,
    );
    assert.equal(fulfilled.length, 1, 'exactly one authoritative create commits');
    assert.ok(mismatch, 'the divergent payload conflicts instead of memoizing');
  });
});

describe('integrity: repository CAS parity (§37)', () => {
  it('the in-memory order repository refuses a stale version like PostgreSQL', async () => {
    const repo = new InMemoryOrderRepository();
    const id = toBrandedId('00000000-0000-4000-8000-0000000003a1');
    const items: readonly OrderItem[] = [
      {
        id: toBrandedId('00000000-0000-4000-8000-0000000003a2'),
        orderId: id,
        testCode: 'CBC',
        codeSystem: 'sdis',
      },
    ];
    const order: DiagnosticOrder = {
      id,
      patientId: toBrandedId('00000000-0000-4000-8000-0000000000e1') as PatientId,
      encounterId: toBrandedId('00000000-0000-4000-8000-0000000000c1'),
      facilityId: sessionFor().facilityId,
      modality: 'LAB',
      status: 'ORDERED',
      priority: 'ROUTINE',
      orderedAt: at(0),
      orderedByRef: 'user-tech-1',
      items,
      version: 1,
    };
    await repo.save(order);
    // A legitimate update advances the stored version (1 → 2).
    const advanced = await repo.save({ ...order, status: 'ACQUIRED', version: 1 });
    assert.equal(advanced.version, 2);
    // A write still claiming the read-at version 1 is now STALE and conflicts
    // — exactly like the PostgreSQL adapter.
    await assert.rejects(repo.save({ ...order, version: 1 }), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match((error as Error).message, /modified concurrently/);
      return true;
    });
    // The CURRENT version flows through (and advances).
    const ok = await repo.save({ ...order, status: 'CANCELLED', version: 2 });
    assert.equal(ok.status, 'CANCELLED');
    assert.equal(ok.version, 3);
  });

  it('the in-memory specimen repository refuses a stale version like PostgreSQL', async () => {
    const repo = new InMemorySpecimenRepository();
    const id = toBrandedId('00000000-0000-4000-8000-0000000003b1') as SpecimenId;
    const specimen: Specimen = {
      id,
      orderItemId: toBrandedId('00000000-0000-4000-8000-0000000003a2') as OrderItemId,
      patientId: toBrandedId('00000000-0000-4000-8000-0000000000e1') as PatientId,
      kind: 'BLOOD',
      collectedAt: at(0),
      collectedByRef: 'user-tech-1',
      status: 'COLLECTED',
      version: 1,
    };
    const saved = await repo.save(specimen);
    assert.equal(saved.version, 1); // INSERT stores the caller's version
    // A legitimate update advances the stored version (1 → 2).
    const advanced = await repo.save({ ...specimen, version: 1 });
    assert.equal(advanced.version, 2);
    // A write still claiming version 1 is now STALE and conflicts.
    await assert.rejects(repo.save(specimen), (error: unknown) => {
      assert.ok(error instanceof ConflictError);
      assert.match((error as Error).message, /modified concurrently/);
      return true;
    });
    // The CURRENT version flows through.
    const ok = await repo.save({ ...specimen, status: 'RECEIVED', version: 2 });
    assert.equal(ok.status, 'RECEIVED');
    assert.equal(ok.version, 3);
  });
});

describe('integrity: inventory stock floor under concurrency (§14)', () => {
  it('two concurrent consumers cannot overdraw a lot (balance never negative)', async () => {
    const repo = new InMemoryInventoryRepository();
    const facility = sessionFor().facilityId as FacilityId;
    const item = {
      id: toBrandedId('00000000-0000-4000-8000-0000000003c1') as InventoryItemId,
      facilityId: facility,
      sku: 'INT33-SKU-1',
      name: 'Integrity synthetic reagent',
      category: 'REAGENT' as const,
      active: true,
    };
    await repo.saveItem(item);
    const batch: StockBatch = {
      id: toBrandedId('00000000-0000-4000-8000-0000000003d1') as InventoryItemId,
      itemId: item.id,
      lotNumber: 'LOT-INT33-1',
      expiryDate: '2027-01-01T00:00:00.000Z',
      receivedAt: at(0),
      receivedQuantity: 10,
      status: 'AVAILABLE',
    };
    await repo.saveBatch(batch);
    await repo.saveMovement({
      id: toBrandedId('00000000-0000-4000-8000-0000000003e1') as InventoryItemId,
      batchId: batch.id,
      movementType: 'IN',
      quantitySigned: 10,
      at: at(0),
      actorRef: 'user-tech-1',
      reason: 'receipt',
    });

    const movement = (id: string, qty: number): StockMovement => ({
      id: toBrandedId(`00000000-0000-4000-8000-0000000003${id}`) as InventoryItemId,
      batchId: batch.id,
      movementType: 'OUT',
      quantitySigned: -qty,
      at: at(1),
      actorRef: 'user-tech-1',
      reason: 'qc-consumption',
    });

    // 10 on hand; two consumers race for 7 each.
    const outcomes = await Promise.allSettled([
      repo.applyDepletingMovement(movement('f1', 7), 7),
      repo.applyDepletingMovement(movement('f2', 7), 7),
    ]);
    const fulfilled = outcomes.filter((r) => r.status === 'fulfilled');
    const rejected = outcomes.filter((r) => r.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one consumer depletes');
    assert.equal(rejected.length, 1, 'the loser is refused');
    assert.ok(
      rejected.every(
        (r) => (r as PromiseRejectedResult).reason instanceof ValidationError,
      ),
      'refusal is the insufficient-stock contract',
    );
    const balance = (await repo.listMovementsByBatch(batch.id)).reduce(
      (sum, m) => sum + m.quantitySigned,
      0,
    );
    assert.equal(balance, 3, 'final balance is exactly the remaining stock');
    assert.ok(balance >= 0, 'stock can never go negative');
  });
});

describe('integrity: facility-scoped configuration replays (§9, Step-32 residual)', () => {
  function configHarness(): {
    service: SetupConfigService;
    sessionA: ApplicationSession;
    sessionB: ApplicationSession;
  } {
    const fixture = createFixture();
    const repo = new InMemorySetupConfigRepository();
    const facilities = (
      fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
    ).deps.facilities;
    const service = new SetupConfigService({
      config: repo,
      facilities,
      audit: fixture.audit,
      idempotency: new InMemoryIdempotencyStore(),
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const withRole = (facilityId?: FacilityId): ApplicationSession => {
      const session = sessionFor(facilityId);
      (session as { roles?: readonly string[] }).roles = ['manager'] as never;
      return session;
    };
    return { service, sessionA: withRole(), sessionB: withRole(OTHER_FACILITY) };
  }

  it('the same update key under two facilities never replays the other facility record', async () => {
    const { service, sessionA, sessionB } = configHarness();
    const setting = {
      family: 'FACILITY' as const,
      key: 'worklist.defaultPageSize',
      effectiveFrom: '2026-09-21T00:00:00.000Z',
    };
    await service.createConfig(sessionA, { ...setting, value: 25 });
    await service.createConfig(sessionB, { ...setting, value: 50 });

    const updateA = await service.updateConfig(sessionA, {
      ...setting,
      value: 30,
      expectedVersion: 1,
      idempotencyKey: 'int33-cfg-upd-001',
    });
    assert.equal(updateA.value, 30);

    // The SAME client key in facility B must resolve B's record, never A's
    // memoized result (Step-32 residual: SETUP_CONFIG_UPDATE was unscoped).
    const updateB = await service.updateConfig(sessionB, {
      ...setting,
      value: 60,
      expectedVersion: 1,
      idempotencyKey: 'int33-cfg-upd-001',
    });
    assert.equal(updateB.value, 60, 'facility B updates its own record');
    assert.notEqual(updateB.id, updateA.id);
  });
});

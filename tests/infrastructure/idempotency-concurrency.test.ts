/**
 * IDEM-01 regression — idempotency single-flight across processes.
 *
 * The pre-fix shape was `get → create() → put()` with no serialization: two
 * requests racing the same key across processes BOTH saw `get undefined`, BOTH
 * persisted their domain rows, and the write-once `put` silently dropped the
 * loser (its domain row became an orphan). The fix is a per-key advisory lock
 * around the whole get→create→put unit (`PostgresIdempotencyStore
 * .withExclusive`), so the loser of the race never runs `create` and reads the
 * winner's stored result.
 *
 * These tests use TWO separate `Database` pools against the same PostgreSQL —
 * the exact cross-process shape from the ledger entry.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { Database } from '../../src/infrastructure/database/database';
import { PostgresIdempotencyStore } from '../../src/infrastructure/database/repositories';
import { runIdempotent, IDEMPOTENCY_SCOPES } from '../../src/app/idempotency';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';

const PORT = 55456;
const ORG = '00000000-0000-4000-8000-000000000001';
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';

describe('idempotency: cross-process single-flight (IDEM-01)', () => {
  let testDb: Database;

  before(async () => {
    // Env-driven Database construction (as the audit concurrency suite does):
    // every `new Database()` below resolves to THIS embedded server — two
    // independent pools, i.e. two "processes".
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = String(PORT);
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    testDb = await setupTestDatabase({ port: PORT });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('two pools racing the same key run create exactly once and receive the same result', async () => {
    const poolB = new Database();
    const poolC = new Database();
    const storeB = new PostgresIdempotencyStore(poolB);
    const storeC = new PostgresIdempotencyStore(poolC);
    let creates = 0;
    const make = async (n: number) => {
      // Widen the race window so both callers are in flight before either
      // commits — pre-fix, both would run create.
      await new Promise((resolve) => setTimeout(resolve, 40));
      creates += 1;
      return { n };
    };
    try {
      const [a, b] = await Promise.all([
        storeB.withExclusive('idem:race:same-key', () => make(1)),
        storeC.withExclusive('idem:race:same-key', () => make(2)),
      ]);
      assert.equal(creates, 1, 'exactly one create ran across both pools');
      assert.deepEqual(a, b, 'both callers receive the same stored result');
    } finally {
      await Promise.all([poolB.close(), poolC.close()]);
    }
    const rows = await testDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sdis.idempotency_keys
        WHERE key = 'idem:race:same-key'`,
    );
    assert.equal(rows.rows[0]?.n, 1, 'exactly one idempotency row');
  });

  it('runIdempotent routes through withExclusive when the store supports it', async () => {
    const poolB = new Database();
    const poolC = new Database();
    const storeB = new PostgresIdempotencyStore(poolB);
    const storeC = new PostgresIdempotencyStore(poolC);
    let creates = 0;
    const key = 'shared-patient-key';
    try {
      const [r1, r2] = await Promise.all([
        runIdempotent(storeB, IDEMPOTENCY_SCOPES.PATIENT_CREATE, key, async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          creates += 1;
          return { patientId: 'B' };
        }),
        runIdempotent(storeC, IDEMPOTENCY_SCOPES.PATIENT_CREATE, key, async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          creates += 1;
          return { patientId: 'C' };
        }),
      ]);
      assert.equal(creates, 1, 'the losing process never ran its create');
      assert.deepEqual(r1, r2, 'both callers receive the same stored result');
      // Exactly one of the two bodies won the advisory-lock race; the contract
      // under test is single-flight + identical results, NOT which pool wins
      // (scheduler order between two pools is not deterministic).
      const winner = JSON.stringify(r1);
      assert.ok(
        winner === '{"patientId":"B"}' || winner === '{"patientId":"C"}',
        'the stored result is exactly one of the two create bodies',
      );
    } finally {
      await Promise.all([poolB.close(), poolC.close()]);
    }
    const rows = await testDb.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sdis.idempotency_keys
        WHERE key = 'patient.create:shared-patient-key'`,
    );
    assert.equal(rows.rows[0]?.n, 1, 'exactly one idempotency row');
  });

  it('same-key replay after a completed run returns the stored result without re-creating', async () => {
    const poolB = new Database();
    const store = new PostgresIdempotencyStore(poolB);
    let creates = 0;
    try {
      const first = await store.withExclusive('idem:replay:key', async () => {
        creates += 1;
        return { token: 'one' };
      });
      const replay = await store.withExclusive('idem:replay:key', async () => {
        creates += 1;
        return { token: 'two' };
      });
      assert.equal(creates, 1, 'replay never re-runs create');
      assert.deepEqual(replay, first);
      assert.deepEqual(replay, { token: 'one' });
    } finally {
      await poolB.close();
    }
  });

  it('a failed create records nothing: the next caller may run create (no poison)', async () => {
    const poolB = new Database();
    const store = new PostgresIdempotencyStore(poolB);
    let attempts = 0;
    try {
      await assert.rejects(
        store.withExclusive('idem:failure:key', async () => {
          attempts += 1;
          throw new Error('boom');
        }),
        /boom/,
      );
      const result = await store.withExclusive('idem:failure:key', async () => {
        attempts += 1;
        return { ok: true };
      });
      assert.equal(attempts, 2, 'failed attempt never poisons the key');
      assert.deepEqual(result, { ok: true });
    } finally {
      await poolB.close();
    }
  });

  it('isolates facility-tagged rows and denies DELETE to the app role (SEC-03)', async () => {
    const store = new PostgresIdempotencyStore(testDb);
    // Facility-composed key shape (scope:facility:key), as every
    // session-scoped runIdempotent caller produces.
    const key = `sec03.probe:${FACILITY}:op-1`;
    await runWithTenantScope({ organizationId: ORG, facilityId: FACILITY }, () =>
      store.put<string>(key, 'result-a'),
    );
    // The row is tagged with the writing facility.
    const tagged = await testDb.query<{ facility_id: string }>(
      `SELECT facility_id FROM sdis.idempotency_keys WHERE key = $1`,
      [key],
    );
    assert.equal(tagged.rows[0]?.facility_id, FACILITY);
    // Same-facility replay keeps working.
    const replay = await runWithTenantScope(
      { organizationId: ORG, facilityId: FACILITY },
      () => store.get<string>(key),
    );
    assert.equal(replay, 'result-a');
    // Another facility cannot read the tagged row.
    const foreign = await runWithTenantScope(
      { organizationId: ORG, facilityId: OTHER_FACILITY },
      () => store.get<string>(key),
    );
    assert.equal(foreign, undefined, 'cross-facility read of a tagged row finds nothing');
    // DELETE is revoked from the application role (expiry is predicate-based).
    await assert.rejects(
      () =>
        runWithTenantScope({ organizationId: ORG, facilityId: FACILITY }, () =>
          testDb.query(`DELETE FROM sdis.idempotency_keys WHERE key = $1`, [key]),
        ),
      (error: { readonly message?: string }) =>
        /permission|denied|policy/i.test(error?.message ?? ''),
      'app-role DELETE of idempotency keys must be denied',
    );
    // The row survives for its owning facility.
    const still = await runWithTenantScope(
      { organizationId: ORG, facilityId: FACILITY },
      () => store.get<string>(key),
    );
    assert.equal(still, 'result-a');
  });
});

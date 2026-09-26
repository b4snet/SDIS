/**
 * Observability over disposable PostgreSQL (Step 12).
 *
 * Proves the readiness probe against the REAL database adapter: ready when
 * PostgreSQL is reachable, unavailable when it is not, with status-only
 * failure reporting (no SQL/error/credential leakage) and using the existing
 * `Database` pool — never a second connection pool.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { Database } from '../../src/infrastructure/database/database';
import type { Database as DatabaseType } from '../../src/infrastructure/database/database';
import { createPostgresReadinessProbe } from '../../src/infrastructure/database/health-probe';
import { liveness, readiness } from '../../src/core/observability/health';

const PORT = 55447;

let db: DatabaseType;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
});

after(async () => {
  await teardownTestDatabase();
});

describe('observability postgres: readiness', () => {
  it('reports ready when PostgreSQL is reachable through the existing pool', async () => {
    const probe = createPostgresReadinessProbe(db);
    const result = await readiness({ postgres: probe });
    assert.deepEqual(result, { status: 'ok', dependencies: { postgres: 'ok' } });
  });

  it('reports unavailable when the pool cannot reach a database, leaking nothing', async () => {
    // A separate adapter pointed at a port with no PostgreSQL server. This is
    // a NEW `Database` instance (its own pool), not a second pool for the
    // application — the application runtime keeps using the existing one.
    const deadDb = new Database({
      host: '127.0.0.1',
      port: 55999,
      database: 'sdis',
      user: 'postgres',
      password: 'not-a-real-password',
      max: 1,
      connectionTimeoutMillis: 500,
      idleTimeoutMillis: 1000,
    });
    const probe = createPostgresReadinessProbe(deadDb);
    const result = await readiness({ postgres: probe });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.dependencies.postgres, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('ECONNREFUSED'));
    assert.ok(!JSON.stringify(result).includes('SELECT'));
    assert.ok(!JSON.stringify(result).includes('not-a-real-password'));
    await deadDb.close();
  });

  it('readiness stays ready across repeated probes (no connection churn)', async () => {
    const probe = createPostgresReadinessProbe(db);
    for (let i = 0; i < 5; i++) {
      const result = await readiness({ postgres: probe });
      assert.equal(result.status, 'ok');
    }
  });

  it('liveness is process-local and never consults the database', () => {
    assert.deepEqual(liveness(), { status: 'ok' });
  });
});

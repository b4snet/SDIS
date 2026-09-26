/**
 * Database configuration tests (DB-03).
 *
 * The built-in default password is a local-development convenience. A
 * production process without an explicit password must fail fast instead of
 * silently authenticating with a guessable default. Constructing the pool
 * performs no I/O, so these tests never touch a database.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';

describe('database: production password fail-fast (DB-03)', () => {
  const savedNodeEnv = process.env['NODE_ENV'];
  const savedPassword = process.env['PGPASSWORD'];

  afterEach(async () => {
    if (savedNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = savedNodeEnv;
    if (savedPassword === undefined) delete process.env['PGPASSWORD'];
    else process.env['PGPASSWORD'] = savedPassword;
  });

  it('refuses the built-in default password in production without PGPASSWORD', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['PGPASSWORD'];
    assert.throws(() => new Database(), /Database password is required in production/);
  });

  it('accepts an explicit config in production without PGPASSWORD', async () => {
    process.env['NODE_ENV'] = 'production';
    delete process.env['PGPASSWORD'];
    const db = new Database({
      host: 'localhost',
      port: 5432,
      database: 'sdis',
      user: 'postgres',
      password: 'explicit-test-only',
    });
    await db.close();
  });

  it('keeps the local-development default outside production', async () => {
    delete process.env['NODE_ENV'];
    delete process.env['PGPASSWORD'];
    const db = new Database();
    await db.close();
  });
});

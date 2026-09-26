/**
 * Database Migration Tests
 *
 * Tests that migrations apply cleanly and schema is correct.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setupTestDatabase,
  teardownTestDatabase,
  getTestDb,
} from '../../src/infrastructure/database/test-db';
import { MigrationRunner } from '../../src/infrastructure/database/migrations';
import { getDatabase } from '../../src/infrastructure/database/database';

let testDb: any;

describe('database: migrations', () => {
  before(async () => {
    testDb = await setupTestDatabase({ port: 55434 });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('applies all migrations without error', async () => {
    const runner = new MigrationRunner(testDb);
    const pending = await runner.getPendingMigrations();
    assert.equal(pending.length, 0, 'All migrations should be applied');
  });

  it('creates all expected tables', async () => {
    const tables = [
      'organizations',
      'facilities',
      'departments',
      'patients',
      'patient_external_identifiers',
      'encounters',
      'modalities',
      'diagnostic_orders',
      'order_items',
      'specimens',
      'specimen_events',
      'observations',
      'interpretations',
      'reports',
      'report_versions',
      'audit_events',
      'idempotency_keys',
      'schema_migrations',
    ];

    for (const table of tables) {
      const result = await testDb.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = 'sdis' AND table_name = $1`,
        [table],
      );
      assert.ok(result.rowCount > 0, `Table sdis.${table} should exist`);
    }
  });

  it('creates required indexes', async () => {
    const result = await testDb.query(`
            SELECT indexname FROM pg_indexes 
            WHERE schemaname = 'sdis' AND indexname LIKE 'idx_%'
        `);
    assert.ok(result.rowCount > 10, 'Should have many indexes');
  });

  it('creates RLS policies', async () => {
    const result = await testDb.query(`
          SELECT p.polname
          FROM pg_policy p
          JOIN pg_class c ON c.oid = p.polrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'sdis'
        `);
    assert.ok(result.rowCount > 20, 'Should have many RLS policies');
  });

  it('creates audit hash chain function', async () => {
    const result = await testDb.query(`
            SELECT 1 FROM pg_proc WHERE proname = 'compute_audit_hash'
        `);
    assert.ok(result.rowCount > 0, 'compute_audit_hash function should exist');
  });

  it('creates audit insert trigger', async () => {
    const result = await testDb.query(`
            SELECT 1 FROM pg_trigger t
            JOIN pg_class c ON t.tgrelid = c.oid
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = 'sdis' AND c.relname = 'audit_events'
        `);
    assert.ok(result.rowCount > 0, 'Audit insert trigger should exist');
  });

  it('creates application role', async () => {
    const result = await testDb.query(`
            SELECT 1 FROM pg_roles WHERE rolname = 'sdis_app'
        `);
    assert.ok(result.rowCount > 0, 'sdis_app role should exist');
  });

  it('enables RLS on all tenant tables', async () => {
    const result = await testDb.query(`
            SELECT relname FROM pg_class c
            JOIN pg_namespace n ON c.relnamespace = n.oid
            WHERE n.nspname = 'sdis' AND c.relrowsecurity = true
        `);
    const rlsTables = result.rows.map((row: { relname: string }) => row.relname);
    const requiredTables = [
      'organizations',
      'facilities',
      'departments',
      'patients',
      'encounters',
      'diagnostic_orders',
      'order_items',
      'specimens',
      'specimen_events',
      'observations',
      'interpretations',
      'reports',
      'report_versions',
      'audit_events',
      // Post-014 tables (remediation TEST-01): every tenant table must ride
      // RLS, including Step 17/19/22/23/25 additions and the idempotency store.
      'external_systems',
      'order_external_references',
      'patient_principal_bindings',
      'quality_records',
      'notification_events',
      'notification_intents',
      'notification_delivery_attempts',
      'idempotency_keys',
    ];
    for (const table of requiredTables) {
      assert.ok(rlsTables.includes(table), `RLS should be enabled on ${table}`);
    }
  });

  it('migration runner tracks applied migrations', async () => {
    const runner = new MigrationRunner(getDatabase());
    const status = await runner.getMigrationStatus();
    assert.ok(status.length >= 7, 'Should have at least 7 migrations applied');
  });

  it('refuses to run when an applied migration file was modified (DB-02)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sdis-mig-'));
    try {
      await writeFile(
        join(dir, '900_probe_one.sql'),
        'CREATE TABLE IF NOT EXISTS sdis.mig_probe_a (id INT PRIMARY KEY);',
      );
      await writeFile(
        join(dir, '901_probe_two.sql'),
        'CREATE TABLE IF NOT EXISTS sdis.mig_probe_b (id INT PRIMARY KEY);',
      );
      const runner = new MigrationRunner(getDatabase());
      assert.equal(await runner.runMigrations(dir), 2);
      // Tamper with an applied file: the next run must abort before applying.
      await writeFile(
        join(dir, '900_probe_one.sql'),
        'CREATE TABLE IF NOT EXISTS sdis.mig_probe_a (id INT PRIMARY KEY); -- tampered',
      );
      await assert.rejects(
        () => runner.runMigrations(dir),
        (error: unknown) =>
          error instanceof Error && error.name === 'MigrationChecksumMismatchError',
        'history is immutable',
      );
    } finally {
      await testDb.query(
        'DROP TABLE IF EXISTS sdis.mig_probe_a; DROP TABLE IF EXISTS sdis.mig_probe_b;',
      );
      await testDb.query(`DELETE FROM sdis.schema_migrations WHERE id IN ('900', '901')`);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

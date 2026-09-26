/**
 * Step 34 — operator CLI (`scripts/sdis-admin.mjs`) tests.
 *
 * The CLI is exercised as an OPERATOR runs it — spawned as a subprocess with
 * environment-based configuration — against the disposable embedded
 * PostgreSQL. Synthetic data only. The CLI drives the repository's own
 * backup-restore tooling, so these tests prove the whole operational chain:
 * script → CLI → backup-restore module → pg_dump/pg_restore.
 *
 * The pg client tools directory is provisioned from the embedded-postgres
 * package binaries when SDIS_PG_CLIENT_DIR is not already configured, so the
 * suite is hermetic (no server-side downloads).
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';

const PORT = 55445;
const BACKUP_DIR = join(process.cwd(), 'tmp', 'ops-cli-test');
const GARBAGE = join(BACKUP_DIR, 'garbage.dump');
const VERIFY_TARGET = 'sdis_ops_cli_verify';

function clientBinDir(): string {
  // Same provisioning convention as backup-restore.test.ts / recovery.test.ts:
  // SDIS_PG_CLIENT_DIR or the TEMP-provisioned PG18 client set.
  if (process.env.SDIS_PG_CLIENT_DIR) return process.env.SDIS_PG_CLIENT_DIR;
  const provisioned = join(process.env.TEMP ?? '', 'sdis-pg18-client', 'bin');
  if (!existsSync(provisioned))
    throw new Error(`pg client tools not found: ${provisioned}`);
  return provisioned;
}

const CLI_ENV = {
  ...process.env,
  PGPASSWORD: 'password',
  PGPORT: String(PORT),
  PGHOST: 'localhost',
  PGUSER: 'postgres',
  PGDATABASE: 'sdis_test',
  SDIS_PG_CLIENT_DIR: clientBinDir(),
};

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [join('scripts', 'sdis-admin.mjs'), ...args],
    {
      encoding: 'utf8',
      env: CLI_ENV,
      timeout: 120_000,
    },
  );
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Database({
    host: 'localhost',
    port: PORT,
    database: 'postgres',
    user: 'postgres',
    password: 'password',
  });
  try {
    await admin.query(sql);
  } finally {
    await admin.close();
  }
}

before(async () => {
  mkdirSync(BACKUP_DIR, { recursive: true });
  await setupTestDatabase({ port: PORT });
});

after(async () => {
  await teardownTestDatabase();
  await adminQuery(`DROP DATABASE IF EXISTS ${VERIFY_TARGET}`).catch(() => undefined);
  if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true });
});

describe('ops CLI: backup / verify-restore / check (Step 34)', () => {
  it('creates a checksummed backup via the npm-script path and verifies a restore drill', async () => {
    const backup = runCli(['backup', '--out-dir', BACKUP_DIR]);
    assert.equal(backup.status, 0, backup.stderr || backup.stdout);
    const report = JSON.parse(backup.stdout);
    assert.ok(report.ok === true);
    assert.ok(existsSync(report.artifact), `artifact must exist: ${report.artifact}`);
    assert.ok(report.sha256.match(/^[0-9a-f]{64}$/));
    assert.ok(report.bytes > 1000);

    // Full drill into a disposable target, checksum supplied as an operator would.
    const drill = runCli([
      'verify-restore',
      '--artifact',
      report.artifact,
      '--sha256',
      report.sha256,
      '--database',
      VERIFY_TARGET,
    ]);
    assert.equal(drill.status, 0, drill.stderr || drill.stdout);
    const verification = JSON.parse(drill.stdout);
    assert.equal(verification.ok, true, drill.stderr || drill.stdout);
    assert.ok(verification.fingerprint.tables >= 20);
    await adminQuery(`DROP DATABASE IF EXISTS ${VERIFY_TARGET}`);
  });

  it('refuses to restore over a protected database and fails on a garbage artifact', async () => {
    // Protected target refusal happens BEFORE any restore side effect.
    const protectedTarget = runCli([
      'verify-restore',
      '--artifact',
      GARBAGE,
      '--database',
      'sdis',
    ]);
    assert.equal(protectedTarget.status, 1);
    assert.ok(protectedTarget.stderr.includes('IN_PLACE_REQUIRES_CONFIRMATION'));

    writeFileSync(GARBAGE, 'NOT A POSTGRES ARCHIVE', 'utf8');
    const scratch = runCli([
      'verify-restore',
      '--artifact',
      GARBAGE,
      '--database',
      'sdis_ops_cli_scratch',
    ]);
    assert.equal(scratch.status, 1, 'a garbage artifact must exit non-zero');
    assert.ok(scratch.stderr.includes('READABILITY_FAILED'));
    await adminQuery('DROP DATABASE IF EXISTS sdis_ops_cli_scratch');
  });

  it('check: read-only integrity diagnostics pass on a healthy database', async () => {
    const check = runCli(['check']);
    assert.equal(check.status, 0, check.stderr || check.stdout);
    const report = JSON.parse(check.stdout);
    assert.equal(report.ok, true);
    assert.ok(report.fingerprint.migrations >= 20);
    assert.ok(report.fingerprint.auditEvents >= 0);
  });

  it('check detects an inconsistent stock ledger (alertable failure, read-only)', async () => {
    // The audit ledger is append-only (UPDATE/DELETE are blocked by triggers),
    // so the tamper probe uses the append-only stock ledger instead: a direct
    // SQL INSERT of an over-drawing movement — exactly how real ledger
    // corruption appears. The CLI must detect the negative derived balance,
    // report it as an alertable finding, and perform NO repair.
    const db = new Database({
      host: 'localhost',
      port: PORT,
      database: 'sdis_test',
      user: 'postgres',
      password: 'password',
    });
    try {
      const item = await db.query<{ id: string }>(
        `INSERT INTO sdis.inventory_items (id, facility_id, sku, name, category)
         VALUES ('00000000-0000-4000-8000-0000000004a1',
                 '00000000-0000-4000-8000-000000000011', 'OPS-CLI-SKU', 'ops cli probe', 'REAGENT')
         RETURNING id::text`,
      );
      const lot = await db.query<{ id: string }>(
        `INSERT INTO sdis.inventory_lots (id, item_id, lot_number, expiry_date, received_quantity)
         VALUES ('00000000-0000-4000-8000-0000000004a2',
                 '00000000-0000-4000-8000-0000000004a1', 'OPS-CLI-LOT', '2099-01-01', 4)
         RETURNING id::text`,
      );
      await db.query(
        `INSERT INTO sdis.stock_movements
           (id, lot_id, movement_type, quantity_signed, at, actor_ref, idempotency_key)
         VALUES ('00000000-0000-4000-8000-0000000004a3',
                 '00000000-0000-4000-8000-0000000004a2', 'IN', 4, now(), 'ops-cli-probe', 'ops-cli-in'),
                ('00000000-0000-4000-8000-0000000004a4',
                 '00000000-0000-4000-8000-0000000004a2', 'OUT', -10, now(), 'ops-cli-probe', 'ops-cli-out')`,
      );
      void item;
      void lot;
    } finally {
      await db.close();
    }

    const check = runCli(['check']);
    assert.equal(check.status, 1, 'an inconsistent ledger must exit non-zero');
    const report = JSON.parse(check.stdout);
    assert.equal(report.ok, false);
    assert.ok(
      report.findings.some((f: { stage: string }) => f.stage === 'inventory-balance'),
    );
    await teardownTestDatabase(); // remove the tampered disposable instance
  });
});

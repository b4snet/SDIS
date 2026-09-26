#!/usr/bin/env node
/**
 * SDIS operations CLI (Step 34).
 *
 * A thin operator wrapper over the REPOSITORY'S OWN recovery tooling
 * (`src/infrastructure/database/backup-restore.ts`, compiled to `dist/`) —
 * no second backup implementation, no hidden credentials, no uploads.
 *
 * Commands:
 *
 *   node scripts/sdis-admin.mjs backup [--out-dir DIR] [--artifact-name NAME]
 *       Consistent `pg_dump --format=custom` snapshot written atomically
 *       (temp artifact → readability check → final name). The artifact is
 *       checksummed; a failed backup exits non-zero and never occupies the
 *       deterministic target name.
 *
 *   node scripts/sdis-admin.mjs verify-restore --artifact FILE [--sha256 HEX]
 *       [--target-database NAME]
 *       Full drill into a DISPOSABLE database: drop/create target, restore,
 *       schema/constraints/RLS/migration/audit-chain verification. Protected
 *       databases (postgres, sdis, sdis_dev) are refused. Exit non-zero on
 *       any verification failure.
 *
 *   node scripts/sdis-admin.mjs check
 *       READ-ONLY operational integrity diagnostics against the configured
 *       database (schema + constraints + RLS objects + audit hash chain +
 *       derived inventory balances + accession identity). No repair, ever.
 *
 * Connection (all commands): standard PG* environment variables
 * (PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD) or --database to override the
 * target database name. Credentials are passed to the environment only and
 * are never logged or written to artifacts.
 *
 * Run `npm run build` first — this CLI drives the compiled distribution.
 *
 * Retention/encryption/rotation are DEPLOYMENT POLICY (see
 * docs/OPERATIONS.md §7): this tool creates and verifies artifacts; it does
 * not delete or transmit them.
 */

import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function loadDist(modulePath) {
  // tsc compiles with `rootDir: "."`, so src/ lands at dist/src/.
  const absolute = resolve(process.cwd(), 'dist', 'src', modulePath);
  if (!existsSync(absolute)) {
    console.error(
      `SDIS operations CLI: ${absolute} not found. Run "npm run build" first.`,
    );
    process.exit(1);
  }
  return import(pathToFileURL(absolute).href);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function targetFrom(args, { databaseOverride = true } = {}) {
  const database =
    databaseOverride && args['database']
      ? String(args['database'])
      : (process.env.PGDATABASE ?? 'sdis');
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? '5432'),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database,
  };
}

function recoveryOptions() {
  const clientBinDir =
    process.env.SDIS_PG_CLIENT_DIR ??
    (process.platform === 'win32'
      ? join(process.env.TEMP ?? '.', 'sdis-pg18-client', 'bin')
      : '/usr/bin'); // documented repo convention: SDIS_PG_CLIENT_DIR overrides
  if (!existsSync(clientBinDir)) {
    console.error(
      `SDIS operations CLI: PostgreSQL client tools not found at "${clientBinDir}". ` +
        'Set SDIS_PG_CLIENT_DIR to the bin directory containing pg_dump/pg_restore.',
    );
    process.exit(1);
  }
  return { clientBinDir, env: process.env };
}

function expectedMigrationCount() {
  const dir = resolve(process.cwd(), 'db', 'migrations');
  if (!existsSync(dir)) return 0; // artifact-only drills without a checkout
  return readdirSync(dir).filter((f) => f.endsWith('.sql')).length;
}

async function cmdBackup(args) {
  const { createBackup } = await loadDist(
    join('infrastructure', 'database', 'backup-restore.js'),
  );
  const outDir = resolve(String(args['out-dir'] ?? join('tmp', 'backups')));
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');
  const artifactName = String(args['artifact-name'] ?? `sdis_${stamp}.dump`);
  const result = createBackup(
    { target: targetFrom(args), outputDir: outDir, artifactName },
    recoveryOptions(),
  );
  console.log(
    JSON.stringify(
      {
        command: 'backup',
        ok: true,
        artifact: result.artifactPath,
        sha256: result.sha256,
        bytes: result.bytes,
        database: result.database,
        note: 'Copy this artifact to secure storage; retention/encryption are deployment policy (docs/OPERATIONS.md).',
      },
      null,
      2,
    ),
  );
}

async function cmdVerifyRestore(args) {
  const backup = await loadDist(join('infrastructure', 'database', 'backup-restore.js'));
  const { Database: Db } = await loadDist(
    join('infrastructure', 'database', 'database.js'),
  );
  const artifactPath = resolve(String(args['artifact'] ?? ''));
  // Refuse protected targets BEFORE any other check (production safety):
  // the dangerous-target refusal must never depend on artifact validity.
  backup.assertRestoreTargetIsolated({
    artifactPath,
    target: targetFrom(args),
  });
  if (!artifactPath || !existsSync(artifactPath)) {
    console.error('verify-restore: --artifact <file> is required and must exist.');
    process.exit(1);
  }
  const target = targetFrom(args);
  const admin = new Db({ ...target, database: 'postgres' });
  console.error(
    `verify-restore: restoring "${artifactPath}" into disposable database "${target.database}"...`,
  );
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${target.database}`);
    await admin.query(`CREATE DATABASE ${target.database}`);
  } finally {
    await admin.close();
  }
  backup.restoreBackup(
    {
      artifactPath,
      ...(args['sha256'] ? { expectedSha256: String(args['sha256']) } : {}),
      target,
    },
    recoveryOptions(),
  );
  const db = new Db(target);
  try {
    const verification = await backup.verifyRecovery({
      db,
      expectedMigrations: expectedMigrationCount(),
    });
    console.log(
      JSON.stringify(
        {
          command: 'verify-restore',
          ok: verification.ok,
          failures: verification.failures,
          fingerprint: verification.fingerprint,
        },
        null,
        2,
      ),
    );
    if (!verification.ok) process.exit(1);
  } finally {
    await db.close();
  }
  console.error(
    'verify-restore: PASSED. The target database is disposable scratch; drop it when done.',
  );
}

async function cmdCheck(args) {
  const backup = await loadDist(join('infrastructure', 'database', 'backup-restore.js'));
  const { Database: Db } = await loadDist(
    join('infrastructure', 'database', 'database.js'),
  );
  const db = new Db(targetFrom(args));
  const findings = [];
  try {
    // Reuse the repository's own verification (schema, constraints, RLS
    // objects, migrations, audit hash chain) against the LIVE database.
    const verification = await backup.verifyRecovery({
      db,
      expectedMigrations: expectedMigrationCount(),
    });
    if (!verification.ok) findings.push(...verification.failures);

    // Derived inventory balance must never be negative (append-only ledger).
    const negativeLots = await db.query(
      `SELECT lot_id::text, SUM(quantity_signed) AS balance
         FROM sdis.stock_movements GROUP BY lot_id HAVING SUM(quantity_signed) < 0`,
    );
    if (negativeLots.rowCount > 0) {
      findings.push({
        stage: 'inventory-balance',
        category: 'CLINICAL_INTEGRITY_FAILURE',
        message: `${negativeLots.rowCount} lot(s) with a negative derived balance`,
      });
    }

    // Accession identity: uniqueness is enforced by a partial unique index;
    // this read-only probe double-checks the business identifier (specimens
    // scope via their order's facility).
    const duplicateAccessions = await db.query(
      `SELECT o.facility_id::text, s.accession_number, count(*) AS n
         FROM sdis.specimens s
         JOIN sdis.order_items oi ON oi.id = s.order_item_id
         JOIN sdis.diagnostic_orders o ON o.id = oi.order_id
        WHERE s.accession_number IS NOT NULL
        GROUP BY o.facility_id, s.accession_number HAVING count(*) > 1`,
    );
    if (duplicateAccessions.rowCount > 0) {
      findings.push({
        stage: 'accession-identity',
        category: 'CLINICAL_INTEGRITY_FAILURE',
        message: `${duplicateAccessions.rowCount} duplicate accession number(s) within a facility`,
      });
    }

    console.log(
      JSON.stringify(
        {
          command: 'check',
          ok: findings.length === 0,
          findings,
          fingerprint: verification.fingerprint,
          note: 'Read-only diagnostics. No automatic repair is provided by design.',
        },
        null,
        2,
      ),
    );
    if (findings.length > 0) process.exit(1);
  } finally {
    await db.close();
  }
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'backup') await cmdBackup(args);
  else if (command === 'verify-restore') await cmdVerifyRestore(args);
  else if (command === 'check') await cmdCheck(args);
  else {
    console.log(
      'Usage: node scripts/sdis-admin.mjs <backup|verify-restore|check> [options]\n' +
        '  backup [--out-dir DIR] [--artifact-name NAME]\n' +
        '  verify-restore --artifact FILE [--sha256 HEX] [--target-database NAME] [--database SOURCE]\n' +
        '  check [--database NAME]\n' +
        'Connection: PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD; tools dir: SDIS_PG_CLIENT_DIR.',
    );
    process.exit(command === undefined ? 0 : 1);
  }
} catch (error) {
  // RecoveryError carries a stable category (e.g. IN_PLACE_REQUIRES_CONFIRMATION,
  // READABILITY_FAILED) — operators and monitors key on it.
  const category =
    error !== null && typeof error === 'object' && 'category' in error
      ? ` [${String(error.category)}]`
      : '';
  console.error(
    `SDIS operations CLI: ${command} FAILED${category}: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

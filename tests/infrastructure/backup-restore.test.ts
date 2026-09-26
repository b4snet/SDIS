import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/infrastructure/database/database';
import { MigrationRunner } from '../../src/infrastructure/database/migrations';
import {
  seedTestData,
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import {
  PostgresOrderRepository,
  PostgresPatientDirectory,
  PostgresReportRepository,
} from '../../src/infrastructure/database/repositories';
import {
  createBackup,
  RecoveryError,
  verifyBackupArtifact,
  type RecoveryOptions,
} from '../../src/infrastructure/database/backup-restore';

const PORT = 55440;
const SOURCE_DATABASE = 'sdis_test';
const REPLAY_DATABASE = 'sdis_replay_test';
const RESTORE_DATABASE = 'sdis_restore_test';
const INVALID_DATABASE = 'sdis_invalid_restore_test';
const BACKUP_DIR = join(process.cwd(), 'tmp', 'backup-test');
const BACKUP_PATH = join(BACKUP_DIR, 'sdis_backup.dump');
const INVALID_BACKUP_PATH = join(BACKUP_DIR, 'invalid.sql');
const DB_ENV = { ...process.env, PGPASSWORD: 'password' };

// The schema-migration replay assertion must track the migrations directory
// rather than a magic number: every new migration (007, 008, 009, …) previously
// broke this test until bumped by hand.
const EXPECTED_MIGRATION_FILES = readdirSync(
  join(process.cwd(), 'db', 'migrations'),
).filter((file) => file.endsWith('.sql')).length;

interface IntegrityFingerprint {
  readonly tableCount: number;
  readonly organizationCount: number;
  readonly patientCount: number;
  readonly orderCount: number;
  readonly observationCount: number;
  readonly interpretationCount: number;
  readonly reportCount: number;
  readonly reportVersionCount: number;
  readonly auditCount: number;
  readonly migrationCount: number;
  readonly indexCount: number;
  readonly foreignKeyCount: number;
  readonly uniqueConstraintCount: number;
  readonly policyCount: number;
  readonly rlsTableCount: number;
}

function postgresTool(name: 'pg_dump.exe' | 'pg_restore.exe'): string {
  const clientDirectory =
    process.env.SDIS_PG_CLIENT_DIR ??
    join(process.env.TEMP ?? '', 'sdis-pg18-client', 'bin');
  return join(clientDirectory, name);
}

function databaseConfig(database: string): ConstructorParameters<typeof Database>[0] {
  return {
    host: 'localhost',
    port: PORT,
    database,
    user: 'postgres',
    password: 'password',
  };
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Database(databaseConfig('postgres'));
  try {
    await admin.query(sql);
  } finally {
    await admin.close();
  }
}

async function recreateDatabase(name: string): Promise<Database> {
  await adminQuery(`DROP DATABASE IF EXISTS ${name}`);
  await adminQuery(`CREATE DATABASE ${name}`);
  return new Database(databaseConfig(name));
}

async function seedSyntheticState(db: Database): Promise<void> {
  await db.query(`
    INSERT INTO sdis.diagnostic_orders
      (id, patient_id, encounter_id, facility_id, modality, status, ordered_at, ordered_by_ref)
    VALUES
      ('00000000-0000-4000-8000-0000000000a1',
       '00000000-0000-4000-8000-0000000000e1',
       '00000000-0000-4000-8000-0000000000c1',
       '00000000-0000-4000-8000-000000000011',
       'LAB', 'ORDERED', '2026-09-20T08:00:00Z', 'synthetic-user')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.order_items (id, order_id, test_code, code_system)
    VALUES ('00000000-0000-4000-8000-0000000000a2',
            '00000000-0000-4000-8000-0000000000a1', 'CBC', 'sdis')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.specimens
      (id, order_item_id, patient_id, kind, status, collected_at, collected_by_ref)
    VALUES ('00000000-0000-4000-8000-0000000000f1',
            '00000000-0000-4000-8000-0000000000a2',
            '00000000-0000-4000-8000-0000000000e1', 'BLOOD', 'COLLECTED',
            '2026-09-20T08:05:00Z', 'synthetic-user')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.observations
      (id, order_item_id, patient_id, specimen_id, code, code_system,
       value_kind, value_numeric, unit, issued_by_kind, issued_by_label, at)
    VALUES ('00000000-0000-4000-8000-0000000000b1',
            '00000000-0000-4000-8000-0000000000a2',
            '00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-0000000000f1', 'HB', 'sdis',
            'QUANTITATIVE', 13.2, 'g/dL', 'DEVICE', 'synthetic-analyzer',
            '2026-09-20T08:06:00Z')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.interpretations
      (id, order_item_id, source_kind, source_label, text, at)
    VALUES ('00000000-0000-4000-8000-0000000000c2',
            '00000000-0000-4000-8000-0000000000a2', 'ALGORITHM',
            'synthetic-rules', 'synthetic interpretation', '2026-09-20T08:07:00Z')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.reports
      (id, order_id, patient_id, facility_id, current_version)
    VALUES ('00000000-0000-4000-8000-0000000000c3',
            '00000000-0000-4000-8000-0000000000a1',
            '00000000-0000-4000-8000-0000000000e1',
            '00000000-0000-4000-8000-000000000011', 1)
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.report_versions
      (id, report_id, version, status, content, authored_by_ref, authored_at)
    VALUES ('00000000-0000-4000-8000-0000000000c4',
            '00000000-0000-4000-8000-0000000000c3', 1, 'DRAFT',
            'synthetic report', 'synthetic-user', '2026-09-20T08:08:00Z')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO sdis.audit_events
      (id, action, object_type, object_id, at, organization_id, facility_id,
       actor_kind, actor_id, source_kind, source_label, event_hash)
    VALUES ('00000000-0000-4000-8000-0000000000d1', 'CREATED', 'diagnostic-order',
            '00000000-0000-4000-8000-0000000000a1', '2026-09-20T08:00:00Z',
            '00000000-0000-4000-8000-000000000001',
            '00000000-0000-4000-8000-000000000011', 'SYSTEM', 'synthetic-test',
            'SYSTEM', 'synthetic-fixture', decode('00', 'hex'))
    ON CONFLICT (id) DO NOTHING;
  `);
}

async function assertSchemaAndData(db: Database): Promise<IntegrityFingerprint> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'sdis' ORDER BY table_name`,
  );
  assert.ok(tables.rows.some((row) => row.table_name === 'organizations'));
  assert.ok(tables.rows.some((row) => row.table_name === 'audit_events'));
  assert.ok(tables.rows.some((row) => row.table_name === 'schema_migrations'));

  const counts = await db.query<{
    organizations: string;
    patients: string;
    orders: string;
    observations: string;
    interpretations: string;
    reports: string;
    report_versions: string;
  }>(
    `SELECT
       (SELECT count(*) FROM sdis.organizations)::text AS organizations,
       (SELECT count(*) FROM sdis.patients)::text AS patients,
       (SELECT count(*) FROM sdis.diagnostic_orders)::text AS orders,
      (SELECT count(*) FROM sdis.observations)::text AS observations,
      (SELECT count(*) FROM sdis.interpretations)::text AS interpretations,
      (SELECT count(*) FROM sdis.reports)::text AS reports,
      (SELECT count(*) FROM sdis.report_versions)::text AS report_versions`,
  );
  const countRow = counts.rows[0];
  assert.ok(countRow);
  assert.equal(Number(countRow.organizations), 2);
  assert.equal(Number(countRow.patients), 1);
  assert.equal(Number(countRow.orders), 1);
  assert.equal(Number(countRow.observations), 1);
  assert.equal(Number(countRow.interpretations), 1);
  assert.equal(Number(countRow.reports), 1);
  assert.equal(Number(countRow.report_versions), 1);

  const relationship = await db.query<{ patient_id: string }>(
    `SELECT o.patient_id
     FROM sdis.diagnostic_orders o
     JOIN sdis.order_items oi ON oi.order_id = o.id
     JOIN sdis.specimens s ON s.order_item_id = oi.id
     WHERE o.id = '00000000-0000-4000-8000-0000000000a1'`,
  );
  assert.equal(relationship.rowCount, 1);
  assert.equal(relationship.rows[0]?.patient_id, '00000000-0000-4000-8000-0000000000e1');

  const migrationState = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM sdis.schema_migrations',
  );
  assert.equal(Number(migrationState.rows[0]?.count), EXPECTED_MIGRATION_FILES);

  const indexes = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname = 'sdis'`,
  );
  assert.ok(Number(indexes.rows[0]?.count) >= 30);

  const foreignKeys = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.table_constraints
     WHERE constraint_schema = 'sdis' AND constraint_type = 'FOREIGN KEY'`,
  );
  assert.ok(Number(foreignKeys.rows[0]?.count) >= 15);

  const uniqueConstraint = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM information_schema.table_constraints
     WHERE constraint_schema = 'sdis' AND constraint_type = 'UNIQUE'`,
  );
  assert.ok(Number(uniqueConstraint.rows[0]?.count) >= 3);

  const extensions = await db.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname IN ('uuid-ossp', 'pgcrypto')`,
  );
  assert.deepEqual(extensions.rows.map((row) => row.extname).sort(), [
    'pgcrypto',
    'uuid-ossp',
  ]);

  const policies = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_policy p
     JOIN pg_class c ON c.oid = p.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'sdis'`,
  );
  assert.ok(Number(policies.rows[0]?.count) >= 20);

  const rlsTables = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'sdis' AND c.relrowsecurity`,
  );
  assert.ok(Number(rlsTables.rows[0]?.count) >= 15);

  const scopeColumns = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'sdis'
       AND ((table_name = 'facilities' AND column_name = 'organization_id')
         OR (table_name IN ('diagnostic_orders', 'reports')
             AND column_name = 'facility_id')
         OR (table_name IN ('audit_events')
             AND column_name IN ('organization_id', 'facility_id')))`,
  );
  assert.ok(
    scopeColumns.rows.some(
      (row) => row.table_name === 'facilities' && row.column_name === 'organization_id',
    ),
  );
  assert.ok(
    scopeColumns.rows.some(
      (row) =>
        row.table_name === 'diagnostic_orders' && row.column_name === 'facility_id',
    ),
  );
  assert.ok(
    scopeColumns.rows.some(
      (row) => row.table_name === 'audit_events' && row.column_name === 'organization_id',
    ),
  );
  assert.ok(
    scopeColumns.rows.some(
      (row) => row.table_name === 'audit_events' && row.column_name === 'facility_id',
    ),
  );

  const audit = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM sdis.audit_events
     WHERE object_id = '00000000-0000-4000-8000-0000000000a1'`,
  );
  assert.equal(Number(audit.rows[0]?.count), 1);

  const auditIntegrity = await db.query<{ event_hash: string; source_kind: string }>(
    `SELECT encode(event_hash, 'hex') AS event_hash, source_kind
     FROM sdis.audit_events
     WHERE object_id = '00000000-0000-4000-8000-0000000000a1'`,
  );
  assert.ok(auditIntegrity.rows[0]?.event_hash);
  assert.equal(auditIntegrity.rows[0]?.source_kind, 'SYSTEM');

  return {
    tableCount: tables.rowCount,
    organizationCount: Number(countRow.organizations),
    patientCount: Number(countRow.patients),
    orderCount: Number(countRow.orders),
    observationCount: Number(countRow.observations),
    interpretationCount: Number(countRow.interpretations),
    reportCount: Number(countRow.reports),
    reportVersionCount: Number(countRow.report_versions),
    auditCount: Number(audit.rows[0]?.count),
    migrationCount: Number(migrationState.rows[0]?.count),
    indexCount: Number(indexes.rows[0]?.count),
    foreignKeyCount: Number(foreignKeys.rows[0]?.count),
    uniqueConstraintCount: Number(uniqueConstraint.rows[0]?.count),
    policyCount: Number(policies.rows[0]?.count),
    rlsTableCount: Number(rlsTables.rows[0]?.count),
  };
}

describe('database: backup/restore and migration replay proof', () => {
  before(async () => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    await setupTestDatabase({ port: PORT });
    const sourceDb = new Database(databaseConfig(SOURCE_DATABASE));
    await seedSyntheticState(sourceDb);
    await sourceDb.close();
  });

  after(async () => {
    await teardownTestDatabase();
    if (existsSync(BACKUP_DIR)) rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  it('replays all migrations from an empty database and validates the application schema', async () => {
    const replayDb = await recreateDatabase(REPLAY_DATABASE);
    try {
      const runner = new MigrationRunner(replayDb);
      assert.equal(await runner.runMigrations(), EXPECTED_MIGRATION_FILES);
      assert.equal(await runner.runMigrations(), 0);
      await seedTestData(replayDb);
      await seedSyntheticState(replayDb);
      await assertSchemaAndData(replayDb);
      const patient = await new PostgresPatientDirectory(replayDb).findById(
        '00000000-0000-4000-8000-0000000000e1' as never,
      );
      assert.equal(patient?.fullName, 'Test Patient One');
      const order = await new PostgresOrderRepository(replayDb).findById(
        '00000000-0000-4000-8000-0000000000a1' as never,
      );
      assert.equal(order?.items[0]?.testCode, 'CBC');
    } finally {
      await replayDb.close();
      await adminQuery(`DROP DATABASE IF EXISTS ${REPLAY_DATABASE}`);
    }
  });

  it('backs up synthetic state, restores into a destroyed target, and validates integrity', async () => {
    const sourceDb = new Database(databaseConfig(SOURCE_DATABASE));
    const beforeRestore = await assertSchemaAndData(sourceDb);
    await sourceDb.close();

    execFileSync(
      postgresTool('pg_dump.exe'),
      [
        '-h',
        'localhost',
        '-p',
        String(PORT),
        '-U',
        'postgres',
        '-d',
        SOURCE_DATABASE,
        '--format=custom',
        '--no-owner',
        '--no-privileges',
        '-f',
        BACKUP_PATH,
      ],
      { env: DB_ENV, stdio: 'pipe' },
    );
    assert.ok(readFileSync(BACKUP_PATH).byteLength > 1000);

    const restoredDb = await recreateDatabase(RESTORE_DATABASE);
    try {
      execFileSync(
        postgresTool('pg_restore.exe'),
        [
          '--exit-on-error',
          '--no-owner',
          '--no-privileges',
          '-h',
          'localhost',
          '-p',
          String(PORT),
          '-U',
          'postgres',
          '-d',
          RESTORE_DATABASE,
          BACKUP_PATH,
        ],
        { env: DB_ENV, stdio: 'pipe' },
      );
      const afterRestore = await assertSchemaAndData(restoredDb);
      assert.deepEqual(afterRestore, beforeRestore);
      const patient = await new PostgresPatientDirectory(restoredDb).findById(
        '00000000-0000-4000-8000-0000000000e1' as never,
      );
      assert.equal(patient?.fullName, 'Test Patient One');
      const order = await new PostgresOrderRepository(restoredDb).findById(
        '00000000-0000-4000-8000-0000000000a1' as never,
      );
      assert.equal(order?.items[0]?.testCode, 'CBC');
      const report = await new PostgresReportRepository(restoredDb).findById(
        '00000000-0000-4000-8000-0000000000c3' as never,
      );
      assert.equal(report?.versions[0]?.content, 'synthetic report');
    } finally {
      await restoredDb.close();
      await adminQuery(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE}`);
    }
  });

  it('rejects an invalid backup without leaving a schema behind', async () => {
    writeFileSync(INVALID_BACKUP_PATH, 'THIS IS NOT A POSTGRES BACKUP;\n', 'utf8');
    const invalidDb = await recreateDatabase(INVALID_DATABASE);
    try {
      assert.throws(() =>
        execFileSync(
          postgresTool('pg_restore.exe'),
          [
            '--exit-on-error',
            '-h',
            'localhost',
            '-p',
            String(PORT),
            '-U',
            'postgres',
            '-d',
            INVALID_DATABASE,
            INVALID_BACKUP_PATH,
          ],
          { env: DB_ENV, stdio: 'pipe' },
        ),
      );
      const schema = await invalidDb.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.schemata WHERE schema_name = 'sdis'
         )`,
      );
      assert.equal(schema.rows[0]?.exists, false);
    } finally {
      await invalidDb.close();
      await adminQuery(`DROP DATABASE IF EXISTS ${INVALID_DATABASE}`);
    }
  });

  // ---- Step 34: readability gate + atomic finalize -------------------------

  const recoveryOptions = (): RecoveryOptions => ({
    clientBinDir:
      process.env.SDIS_PG_CLIENT_DIR ??
      join(process.env.TEMP ?? '', 'sdis-pg18-client', 'bin'),
    env: DB_ENV,
  });

  it('verifies artifact readability without a database, rejecting garbage (Step 34)', () => {
    const garbagePath = join(BACKUP_DIR, 'garbage.dump');
    writeFileSync(garbagePath, 'DEFINITELY NOT A PG ARCHIVE', 'utf8');
    assert.throws(
      () => verifyBackupArtifact(garbagePath, recoveryOptions()),
      (error: unknown) =>
        error instanceof RecoveryError && error.category === 'READABILITY_FAILED',
    );
    assert.throws(
      () => verifyBackupArtifact(join(BACKUP_DIR, 'missing.dump'), recoveryOptions()),
      (error: unknown) =>
        error instanceof RecoveryError && error.category === 'MISSING_ARTIFACT',
    );
  });

  it('finalizes a backup atomically: failures never poison the artifact name (Step 34)', () => {
    const artifactName = 'sdis_step34_atomic.dump';
    const artifactPath = join(BACKUP_DIR, artifactName);

    // A failed dump (non-existent database) must leave NO final artifact and
    // NO .partial debris — the last known-good naming stays untouched.
    assert.throws(
      () =>
        createBackup(
          {
            target: {
              host: 'localhost',
              port: PORT,
              user: 'postgres',
              password: 'password',
              database: 'sdis_no_such_database_step34',
            },
            outputDir: BACKUP_DIR,
            artifactName,
          },
          recoveryOptions(),
        ),
      (error: unknown) =>
        error instanceof RecoveryError &&
        (error.category === 'TOOL_FAILURE' || error.category === 'UNAVAILABLE'),
    );
    assert.equal(existsSync(artifactPath), false);
    assert.equal(existsSync(`${artifactPath}.partial`), false);

    // The same deterministic name is immediately usable for a REAL backup of
    // the seeded source — a failed attempt never occupies the name.
    const result = createBackup(
      {
        target: {
          host: 'localhost',
          port: PORT,
          user: 'postgres',
          password: 'password',
          database: SOURCE_DATABASE,
        },
        outputDir: BACKUP_DIR,
        artifactName,
      },
      recoveryOptions(),
    );
    assert.ok(result.bytes > 1000);
    assert.equal(existsSync(`${artifactPath}.partial`), false); // finalized atomically
    // The readability gate accepts the produced artifact (restore-path proof).
    assert.doesNotThrow(() =>
      verifyBackupArtifact(result.artifactPath, recoveryOptions()),
    );
  });
});

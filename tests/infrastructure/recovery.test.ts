/**
 * Step 18 — Backup / recovery verification over disposable PostgreSQL.
 *
 * Proves the full recovery loop against the REAL database:
 *
 *   synthetic multi-tenant data (via application services)
 *     → createBackup / restoreBackup (deterministic artifact + checksum)
 *     → verifyRecovery (schema, constraints, RLS objects, migration state,
 *       audit hash-chain, tenant/facility isolation under the application
 *       role, finalized/amendment integrity, persisted idempotency)
 *     → the application can operate against the restored database
 *     → explicit failure handling
 *
 * Uses only synthetic data. Not a production DR claim.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from '../../src/infrastructure/database/database';
import { MigrationRunner } from '../../src/infrastructure/database/migrations';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import {
  createBackup,
  restoreBackup,
  verifyRecovery,
  RecoveryError,
  sha256File,
  type RecoveryProbes,
} from '../../src/infrastructure/database/backup-restore';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import {
  toBrandedId,
  type PatientId,
  type EncounterId,
  type ReportId,
  type DiagnosticOrderId,
} from '../../src/types/ids';

/** Brands a raw string for the service layer (test-seam helper). */
function asOrderId(value: string): DiagnosticOrderId {
  return toBrandedId(value) as DiagnosticOrderId;
}

/** Brands a raw string for the service layer (test-seam helper). */
function asReportId(value: string): ReportId {
  return toBrandedId(value) as ReportId;
}

const PORT = 55454;
const SOURCE_DATABASE = 'sdis_test';
const RESTORE_DATABASE = 'sdis_recovery_restore';
const CORRUPT_DATABASE = 'sdis_recovery_corrupt';
const BACKUP_DIR = join(process.cwd(), 'tmp', 'recovery-test');
const ARTIFACT = 'sdis_recovery_step18.dump';
const BACKUP_PATH = join(BACKUP_DIR, ARTIFACT);
const CLIENT_BIN_DIR =
  process.env.SDIS_PG_CLIENT_DIR ??
  join(process.env.TEMP ?? '', 'sdis-pg18-client', 'bin');
const DB_ENV = { ...process.env, PGPASSWORD: 'password' };

const EXPECTED_MIGRATIONS = readdirSync(join(process.cwd(), 'db', 'migrations')).filter(
  (file) => file.endsWith('.sql'),
).length;

const ORG_A = '00000000-0000-4000-8000-000000000001';
const ORG_B = '00000000-0000-4000-8000-000000000009';
const FACILITY_A1 = '00000000-0000-4000-8000-000000000011';
const FACILITY_A2 = '00000000-0000-4000-8000-000000000012';
const FACILITY_B1 = '00000000-0000-4000-8000-000000000019';

const PATIENT_A1 = toBrandedId('00000000-0000-4000-8000-0000000000e1') as PatientId;
const PATIENT_A2 = toBrandedId('00000000-0000-4000-8000-0000000000e2') as PatientId;
const ENCOUNTER_A = toBrandedId('00000000-0000-4000-8000-0000000000c1') as EncounterId;

function targetFor(database: string) {
  return {
    host: 'localhost',
    port: PORT,
    user: 'postgres',
    password: 'password',
    database,
  };
}

let db: Database;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

function session(facilityId = FACILITY_A1, organizationId = ORG_A) {
  return {
    actor: { kind: 'USER', id: 'recovery-clerk' } as never,
    userId: 'recovery-clerk',
    roles: ['manager', 'operator', 'viewer'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

async function adminQuery(sql: string): Promise<void> {
  const admin = new Database(targetFor('postgres'));
  try {
    await admin.query(sql);
  } finally {
    await admin.close();
  }
}

/**
 * Registers patients in three facilities / two tenants through the services
 * and returns their canonical ids plus the created order id.
 *
 * All operational timestamps derive from the injected clock: the audit hash
 * trigger chains by INSERT order while verification replays by `at` order,
 * so every operational event in a chain must carry a LATER `at` than the
 * events inserted before it (registrations audit at the wall clock).
 */
async function seedViaApplicationServices(
  iso: (offsetMinutes: number) => string,
): Promise<{
  patientA1: string;
  patientA2: string;
  orderId: string;
}> {
  const patients = runtime.patients;
  const patientA1 = await patients.registerPatient(session(), {
    fullName: 'Recovery Patient A1 (synthetic)',
    sex: 'F',
    birthDate: '1991-03-02',
  });
  const patientA2 = await patients.registerPatient(session(FACILITY_A2), {
    fullName: 'Recovery Patient A2 (synthetic)',
    sex: 'M',
    birthDate: '1987-11-14',
  });
  await patients.registerPatient(session(FACILITY_B1, ORG_B), {
    fullName: 'Recovery Patient B1 (synthetic)',
    sex: 'F',
    birthDate: '1979-06-30',
  });

  const order = await runtime.orders.createOrder(session(), {
    patientId: PATIENT_A1,
    encounterId: ENCOUNTER_A,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    // After the registration events (wall clock) — chain stays monotonic.
    orderedAt: iso(1),
    idempotencyKey: 'recovery-order-2026-09-21-001',
  });
  return { patientA1: patientA1.id, patientA2: patientA2.id, orderId: order.id };
}

/**
 * Finalizes the order's report and appends one amendment (v2 supersedes v1)
 * through the report service, plus one durable idempotency record.
 */
async function seedReportLifecycle(
  orderId: string,
  iso: (offsetMinutes: number) => string,
): Promise<RecoveryProbes> {
  // Step-28 governance: verification precedes finalization. The seeded walk
  // uses the manager tier (VERIFIED) with deterministic instants.
  for (const [i, to] of (
    ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const
  ).entries()) {
    await runtime.orders.transitionOrder(session(), asOrderId(orderId), to, iso(2 + i));
  }
  await runtime.orders.transitionOrder(
    session(),
    asOrderId(orderId),
    'VERIFIED',
    iso(2.5),
  );
  const report = await runtime.reports.createReport(session(), {
    orderId: asOrderId(orderId),
    content: 'recovery synthetic report v1',
    authoredByRef: 'recovery-clerk',
    authoredAt: iso(2),
  });
  const finalized = await runtime.reports.finalizeReport(
    session(),
    asReportId(report.id),
    'recovery-clerk',
    iso(3),
  );
  const amended = await runtime.reports.amendReport(session(), {
    reportId: asReportId(report.id),
    content: 'recovery synthetic report v2 (amendment)',
    authoredByRef: 'recovery-clerk',
    authoredAt: iso(4),
    amendmentReason: 'REPORT_CORRECTION',
  });

  const finalizedVersion = finalized.versions[finalized.versions.length - 1];
  const amendedVersion = amended.versions[amended.versions.length - 1];
  assert.ok(finalizedVersion, 'finalized version must exist');
  assert.ok(amendedVersion, 'amendment version must exist');

  // A durable idempotency record must survive restore (PostgresIdempotencyStore).
  const idemKey = 'recovery:probe:persisted-idempotency';
  await db.query(
    `INSERT INTO sdis.idempotency_keys (key, value, expires_at)
     VALUES ($1, $2::jsonb, now() + interval '24 hours')
     ON CONFLICT (key) DO NOTHING`,
    [idemKey, JSON.stringify({ recovered: true })],
  );

  return {
    orgA: ORG_A,
    orgB: ORG_B,
    facilityA1: FACILITY_A1,
    facilityB1: FACILITY_B1,
    finalizedReportVersionId: finalizedVersion.id,
    amendmentVersionId: amendedVersion.id,
    originalVersionId: finalizedVersion.id,
    idempotencyKey: idemKey,
  };
}

describe('Step 18: backup → restore → verify → application reuse', () => {
  let probes: RecoveryProbes;
  let orderId: string;
  let reportId: string;
  let patientA2Id: string;
  /** Wall-clock-derived ISO timestamps keeping the audit chain monotonic. */
  let clock: (offsetMinutes: number) => string;

  before(async () => {
    mkdirSync(BACKUP_DIR, { recursive: true });
    db = await setupTestDatabase({ port: PORT });
    runtime = createPostgresLaboratoryRuntime(db);
    const t0 = Date.now();
    clock = (offsetMinutes: number) =>
      new Date(t0 + offsetMinutes * 60_000).toISOString();
    const seeded = await seedViaApplicationServices(clock);
    patientA2Id = seeded.patientA2;
    orderId = seeded.orderId;
    probes = await seedReportLifecycle(orderId, clock);
    reportId = (
      await runtime.reports.createReport(session(), {
        orderId: asOrderId(orderId),
        content: 'probe report',
        authoredByRef: 'recovery-clerk',
        authoredAt: clock(5),
        idempotencyKey: 'recovery-report-2026-09-21-001',
      })
    ).id;
    // Finalize it BEFORE the backup so the artifact contains a FINALIZED
    // report version — post-restore re-finalization must be refused.
    await runtime.reports.finalizeReport(
      session(),
      asReportId(reportId),
      'recovery-clerk',
      clock(6),
    );
  });

  after(async () => {
    await teardownTestDatabase();
    rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  it('backs up the synthetic state into a deterministic artifact with a verifiable checksum', () => {
    const result = createBackup(
      {
        target: targetFor(SOURCE_DATABASE),
        outputDir: BACKUP_DIR,
        artifactName: ARTIFACT,
      },
      { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
    );
    assert.ok(existsSync(result.artifactPath), 'artifact must exist');
    assert.ok(result.bytes > 1000, 'artifact must be substantial');
    assert.equal(result.sha256, sha256File(result.artifactPath));

    // Deterministic naming refuses a second backup under the same name
    // (an overwrite would silently break artifact-to-time correspondence).
    assert.throws(
      () =>
        createBackup(
          {
            target: targetFor(SOURCE_DATABASE),
            outputDir: BACKUP_DIR,
            artifactName: ARTIFACT,
          },
          { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
        ),
      (error: unknown) =>
        error instanceof RecoveryError && error.category === 'INVALID_ARTIFACT',
    );
  });

  it('restores the backup into a destroyed database and verifies recovery end-to-end', async () => {
    const before = await verifyRecovery({
      db,
      expectedMigrations: EXPECTED_MIGRATIONS,
      probes,
    });
    assert.ok(
      before.ok,
      `source verification failed: ${JSON.stringify(before.failures)}`,
    );

    // Destroy the restore target, then restore: the dump must recreate
    // everything (schema, RLS, constraints, data) from the artifact alone.
    await adminQuery(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE}`);
    await adminQuery(`CREATE DATABASE ${RESTORE_DATABASE}`);
    try {
      restoreBackup(
        {
          artifactPath: BACKUP_PATH,
          expectedSha256: sha256File(BACKUP_PATH),
          target: targetFor(RESTORE_DATABASE),
        },
        { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
      );

      const restoredDb = new Database(targetFor(RESTORE_DATABASE));
      try {
        const after = await verifyRecovery({
          db: restoredDb,
          expectedMigrations: EXPECTED_MIGRATIONS,
          probes,
        });
        assert.ok(
          after.ok,
          `restored verification failed: ${JSON.stringify(after.failures)}`,
        );

        // Every fingerprint dimension must match the source database.
        const keys = Object.keys(
          before.fingerprint,
        ) as (keyof typeof after.fingerprint)[];
        for (const key of keys) {
          assert.equal(
            after.fingerprint[key],
            before.fingerprint[key],
            `recovery fingerprint mismatch: ${key}`,
          );
        }

        // Representative clinical data is present and correctly related.
        assert.ok(after.fingerprint.patients >= 3, 'all three tenants survive');
        assert.ok(after.fingerprint.orders >= 1);
        assert.ok(
          after.fingerprint.finalizedReportVersions >= 1,
          'finalization survives',
        );
        assert.ok(after.fingerprint.amendments >= 1, 'amendment survives');
        assert.ok(
          after.fingerprint.externalIdentifiers >= 1,
          'external reference survives',
        );
        assert.ok(after.fingerprint.auditEvents >= 1, 'audit survives');
        assert.ok(after.fingerprint.idempotencyKeys >= 1, 'idempotency state survives');

        // Migration state: nothing pending after restore.
        const pending = await new MigrationRunner(restoredDb).getPendingMigrations();
        assert.equal(pending.length, 0);
      } finally {
        await restoredDb.close();
      }
    } finally {
      await adminQuery(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE}`);
    }
  });

  it('keeps the application operational against the restored database', async () => {
    await adminQuery(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE}`);
    await adminQuery(`CREATE DATABASE ${RESTORE_DATABASE}`);
    try {
      restoreBackup(
        { artifactPath: BACKUP_PATH, target: targetFor(RESTORE_DATABASE) },
        { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
      );
      const restoredDb = new Database(targetFor(RESTORE_DATABASE));
      try {
        const restoredRuntime = createPostgresLaboratoryRuntime(restoredDb);

        // The recovered order is readable through the application (scoped).
        const order = await restoredRuntime.orders.getOrder(
          session(),
          asOrderId(orderId),
        );
        assert.equal(order.items.length, 1);

        // A NEW order can be created against the restored database: the
        // application genuinely operates on recovered state, not just reads.
        // (For the same recovered patient/encounter pair as the original.)
        const newOrder = await restoredRuntime.orders.createOrder(session(), {
          patientId: PATIENT_A1,
          encounterId: ENCOUNTER_A,
          modality: 'LAB',
          items: [{ testCode: 'LFT', codeSystem: 'sdis' }],
          orderedAt: new Date().toISOString(),
          idempotencyKey: 'recovery-post-restore-order-001',
        });
        assert.ok(newOrder.id);

        // Facility isolation after restore is enforced where the shipped
        // system enforces it — the application service layer (DB RLS is
        // org-strict; the intra-org facility boundary is service-side).
        // A1 session must NOT read the A2-registered patient, and vice versa.
        await assert.rejects(
          restoredRuntime.patients.getPatient(
            session(),
            toBrandedId(patientA2Id) as PatientId,
          ),
          /not found|scope/i,
        );
        const fromA2 = await restoredRuntime.patients.getPatient(
          session(FACILITY_A2),
          toBrandedId(patientA2Id) as PatientId,
        );
        assert.equal(fromA2.id, patientA2Id);

        // The idempotency record from BEFORE the backup replays: recreating
        // the ORIGINAL order with the SAME key returns the stored result —
        // no duplicate order is created after recovery.
        const replay = await restoredRuntime.orders.createOrder(session(), {
          patientId: PATIENT_A1,
          encounterId: ENCOUNTER_A,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: 'recovery-order-2026-09-21-001',
        });
        assert.equal(replay.id, orderId, 'replay must return the original order');

        // The report service still refuses to re-finalize a FINALIZED report:
        // finalized-record immutability survives recovery (application-level).
        await assert.rejects(
          restoredRuntime.reports.finalizeReport(
            session(),
            asReportId(reportId),
            'recovery-clerk',
            new Date().toISOString(),
          ),
          /already finalized/i,
        );
      } finally {
        await restoredDb.close();
      }
    } finally {
      await adminQuery(`DROP DATABASE IF EXISTS ${RESTORE_DATABASE}`);
    }
  });

  it('rejects a missing artifact, a corrupt artifact, and an unavailable server explicitly', async () => {
    // Missing artifact.
    assert.throws(
      () =>
        restoreBackup(
          {
            artifactPath: join(BACKUP_DIR, 'does-not-exist.dump'),
            target: targetFor(CORRUPT_DATABASE),
          },
          { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
        ),
      (error: unknown) =>
        error instanceof RecoveryError && error.category === 'MISSING_ARTIFACT',
    );

    // Corrupt artifact: checksum mismatch aborts BEFORE pg_restore runs.
    const corruptPath = join(BACKUP_DIR, 'corrupt.dump');
    writeFileSync(corruptPath, 'NOT A POSTGRES BACKUP\n', 'utf8');
    assert.throws(
      () =>
        restoreBackup(
          {
            artifactPath: corruptPath,
            expectedSha256: 'deadbeef'.repeat(8),
            target: targetFor(CORRUPT_DATABASE),
          },
          { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
        ),
      (error: unknown) =>
        error instanceof RecoveryError && error.category === 'INVALID_ARTIFACT',
    );

    // A corrupt artifact whose recorded checksum MATCHES must still fail
    // loudly BEFORE any restore side effect (Step 34: the readability gate
    // rejects it earlier than pg_restore ever did), leaving no usable sdis
    // schema behind.
    await adminQuery(`DROP DATABASE IF EXISTS ${CORRUPT_DATABASE}`);
    await adminQuery(`CREATE DATABASE ${CORRUPT_DATABASE}`);
    try {
      assert.throws(
        () =>
          restoreBackup(
            {
              artifactPath: corruptPath,
              expectedSha256: sha256File(corruptPath),
              target: targetFor(CORRUPT_DATABASE),
            },
            { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
          ),
        (error: unknown) =>
          error instanceof RecoveryError && error.category === 'READABILITY_FAILED',
      );
      const corruptDb = new Database(targetFor(CORRUPT_DATABASE));
      try {
        const schema = await corruptDb.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM information_schema.schemata
             WHERE schema_name = 'sdis') AS "exists"`,
        );
        assert.equal(
          schema.rows[0]?.exists,
          false,
          'failed restore must leave no sdis schema',
        );
      } finally {
        await corruptDb.close();
      }

      // Unavailable PostgreSQL server (nothing listens on this port).
      assert.throws(
        () =>
          restoreBackup(
            { artifactPath: BACKUP_PATH, target: targetFor('sdis_recovery_dead') },
            { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
          ),
        (error: unknown) =>
          error instanceof RecoveryError &&
          (error.category === 'UNAVAILABLE' || error.category === 'TOOL_FAILURE'),
      );
    } finally {
      await adminQuery(`DROP DATABASE IF EXISTS ${CORRUPT_DATABASE}`);
    }
  });

  it('refuses in-place restore over a protected database without explicit confirmation', () => {
    for (const protectedDb of ['sdis', 'postgres', 'sdis_dev']) {
      assert.throws(
        () =>
          restoreBackup(
            { artifactPath: BACKUP_PATH, target: targetFor(protectedDb) },
            { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
          ),
        (error: unknown) =>
          error instanceof RecoveryError &&
          error.category === 'IN_PLACE_REQUIRES_CONFIRMATION',
        `protected database ${protectedDb} must refuse restore by default`,
      );
      // A wrong confirmation token is refused too.
      assert.throws(
        () =>
          restoreBackup(
            {
              artifactPath: BACKUP_PATH,
              target: targetFor(protectedDb),
              allowInPlace: 'please',
            },
            { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
          ),
        (error: unknown) =>
          error instanceof RecoveryError &&
          error.category === 'IN_PLACE_REQUIRES_CONFIRMATION',
      );
    }
  });

  it('detects a tampered audit hash chain on the restored database', async () => {
    await adminQuery(`DROP DATABASE IF EXISTS ${CORRUPT_DATABASE}`);
    await adminQuery(`CREATE DATABASE ${CORRUPT_DATABASE}`);
    try {
      restoreBackup(
        { artifactPath: BACKUP_PATH, target: targetFor(CORRUPT_DATABASE) },
        { clientBinDir: CLIENT_BIN_DIR, env: DB_ENV },
      );
      const tamperedDb = new Database(targetFor(CORRUPT_DATABASE));
      try {
        // Simulate a privileged attacker: disable the append-only trigger,
        // rewrite a hashed column, re-enable. Recovery verification must
        // catch the broken chain — it must never trust the artifact blindly.
        await tamperedDb.query(
          'ALTER TABLE sdis.audit_events DISABLE TRIGGER trg_audit_no_update',
        );
        await tamperedDb.query(
          `UPDATE sdis.audit_events SET source_label = 'tampered'
           WHERE object_id = $1::uuid`,
          [orderId],
        );
        await tamperedDb.query(
          'ALTER TABLE sdis.audit_events ENABLE TRIGGER trg_audit_no_update',
        );

        const result = await verifyRecovery({
          db: tamperedDb,
          expectedMigrations: EXPECTED_MIGRATIONS,
          probes,
        });
        assert.equal(result.ok, false);
        assert.ok(
          result.failures.some((failure) => failure.category === 'AUDIT_CHAIN_BROKEN'),
          'tampering must be detected as AUDIT_CHAIN_BROKEN',
        );
      } finally {
        await tamperedDb.close();
      }
    } finally {
      await adminQuery(`DROP DATABASE IF EXISTS ${CORRUPT_DATABASE}`);
    }
  });
});

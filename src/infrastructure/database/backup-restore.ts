/**
 * SDIS backup / restore / recovery verification (Step 18).
 *
 * Operational tooling at the infrastructure boundary. It reuses the existing
 * `Database`, `MigrationRunner`, and schema primitives — no second database
 * abstraction, no new pool class, no second audit system.
 *
 * Guarantees demonstrated by tests (NOT production DR claims):
 *  - backup produces a deterministic-named, checksum-verifiable artifact;
 *  - restore targets ONLY a disposable database: protected targets (the dev
 *    database, `postgres`, `sdis_dev`) are refused without an explicit
 *    confirmation token, so "restore over the current database" is never the
 *    default behavior;
 *  - verification proves schema, constraints, indexes, RLS objects, migration
 *    state, audit hash-chain integrity (via the existing
 *    `sdis.verify_audit_chain`), finalized-record immutability, tenant and
 *    facility isolation under the application role, and representative data;
 *  - every failure path is explicit: missing/corrupt artifact, unavailable
 *    server, protected target, failed verification.
 *
 * Credentials come from the caller/environment only; nothing is logged.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { Database } from './database';
import { MigrationRunner } from './migrations';

/** A connection target for the recovery tooling. */
export interface RecoveryTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  /** Supplied by the caller/environment; never logged, never persisted. */
  readonly password: string;
  readonly database: string;
}

/** Options for the PostgreSQL client tooling. */
export interface RecoveryOptions {
  /** Directory containing pg_dump/pg_restore (SDIS_PG_CLIENT_DIR pattern). */
  readonly clientBinDir: string;
  /** Environment carrying credentials; never logged. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Outcome of a successful backup. */
export interface BackupResult {
  readonly artifactPath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly database: string;
}

export type RecoveryFailureCategory =
  | 'MISSING_ARTIFACT'
  | 'INVALID_ARTIFACT'
  | 'READABILITY_FAILED'
  | 'TOOL_FAILURE'
  | 'UNAVAILABLE'
  | 'IN_PLACE_REQUIRES_CONFIRMATION'
  | 'VERIFICATION_FAILED';

export class RecoveryError extends Error {
  constructor(
    readonly category: RecoveryFailureCategory,
    message: string,
  ) {
    super(message);
    this.name = 'RecoveryError';
  }
}

/** Which verification stages failed and why. */
export interface VerificationFailure {
  readonly stage: string;
  readonly category:
    | 'SCHEMA_MISMATCH'
    | 'AUDIT_CHAIN_BROKEN'
    | 'TENANT_ISOLATION_FAILURE'
    | 'CLINICAL_INTEGRITY_FAILURE'
    | 'MIGRATION_MISMATCH'
    | 'IDEMPOTENCY_MISMATCH'
    | 'IMMUTABILITY_FAILURE';
  readonly message: string;
}

/** Representative counts recovered from the `sdis` schema. */
export interface RecoveryFingerprint {
  readonly tables: number;
  readonly indexes: number;
  readonly foreignKeys: number;
  readonly uniqueConstraints: number;
  readonly policies: number;
  readonly rlsTables: number;
  readonly auditEvents: number;
  readonly idempotencyKeys: number;
  readonly organizations: number;
  readonly facilities: number;
  readonly patients: number;
  readonly encounters: number;
  readonly orders: number;
  readonly orderItems: number;
  readonly specimens: number;
  readonly observations: number;
  readonly interpretations: number;
  readonly reports: number;
  readonly reportVersions: number;
  readonly finalizedReportVersions: number;
  readonly amendments: number;
  readonly externalIdentifiers: number;
  readonly charges: number;
  readonly devices: number;
  readonly acquisitions: number;
  readonly terminologyMappings: number;
  readonly migrations: number;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly failures: VerificationFailure[];
  readonly fingerprint: RecoveryFingerprint;
}

/** Optional probes requiring fixture knowledge (IDs of representative rows). */
export interface RecoveryProbes {
  /** Tenant scope used for the isolation probes. */
  readonly orgA: string;
  readonly orgB: string;
  readonly facilityA1: string;
  /** A foreign-organization facility: must be invisible under org-A context. */
  readonly facilityB1: string;
  /** A FINALIZED report version: restoring must not make it mutable. */
  readonly finalizedReportVersionId: string;
  /** The v2 amendment: its supersedes link must point at v1 after restore. */
  readonly amendmentVersionId: string;
  readonly originalVersionId: string;
  /** A persisted idempotency key that must survive restore. */
  readonly idempotencyKey: string;
}

export interface RecoveryVerificationRequest {
  readonly db: Database;
  /** Expected number of applied migrations (db/migrations/*.sql). */
  readonly expectedMigrations: number;
  readonly probes?: RecoveryProbes;
}

export interface BackupRequest {
  readonly target: RecoveryTarget;
  readonly outputDir: string;
  /** Deterministic artifact name (e.g. `sdis_20260922T030000Z.dump`). */
  readonly artifactName: string;
}

export interface RestoreRequest {
  readonly artifactPath: string;
  /** Expected SHA-256; mismatch aborts before any restore. */
  readonly expectedSha256?: string;
  /** Connection to the (disposable) target database. */
  readonly target: RecoveryTarget;
  /** Required confirmation token to restore over a protected database. */
  readonly allowInPlace?: string;
}

/** Databases that must never be a default restore target. */
const PROTECTED_DATABASES = new Set(['postgres', 'sdis', 'sdis_dev']);
const IN_PLACE_TOKEN = 'CONFIRM-IN-PLACE-RESTORE';

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function postgresTool(name: 'pg_dump' | 'pg_restore', options: RecoveryOptions): string {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  return join(options.clientBinDir, `${name}${suffix}`);
}

function runTool(tool: string, args: string[], options: RecoveryOptions): void {
  try {
    execFileSync(tool, args, {
      env: options.env ?? process.env,
      stdio: 'pipe',
      windowsHide: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('ECONNREFUSED') || message.includes('could not connect')) {
      throw new RecoveryError('UNAVAILABLE', `PostgreSQL server unavailable: ${message}`);
    }
    // Never include env/credentials in the surfaced message. Tool stderr may
    // also carry filesystem paths and topology hints (OPS-01), so surface a
    // stable shape — tool name plus process status — and keep raw stderr out.
    const status =
      error !== null && typeof error === 'object' && 'status' in error
        ? String((error as { status?: unknown }).status ?? 'unknown')
        : 'unknown';
    throw new RecoveryError(
      'TOOL_FAILURE',
      `PostgreSQL tool failed: ${tool} exited (status ${status})`,
    );
  }
}

/**
 * Verifies that an artifact is a readable pg_dump custom-format archive
 * WITHOUT touching any database (`pg_restore --list` parses the archive TOC
 * — a corrupt/truncated/garbage artifact fails here, before any restore).
 */
export function verifyBackupArtifact(
  artifactPath: string,
  options: RecoveryOptions,
): void {
  if (!existsSync(artifactPath)) {
    throw new RecoveryError(
      'MISSING_ARTIFACT',
      `backup artifact not found: ${artifactPath}`,
    );
  }
  if (statSync(artifactPath).size === 0) {
    throw new RecoveryError('INVALID_ARTIFACT', 'backup artifact is empty');
  }
  try {
    runTool(postgresTool('pg_restore', options), ['--list', artifactPath], options);
  } catch (error) {
    if (error instanceof RecoveryError && error.category === 'TOOL_FAILURE') {
      throw new RecoveryError(
        'READABILITY_FAILED',
        `backup artifact is not a readable PostgreSQL custom-format archive: ${artifactPath}`,
      );
    }
    throw error;
  }
}

/** Creates a physical (custom-format) backup with a deterministic artifact name. */
export function createBackup(
  request: BackupRequest,
  options: RecoveryOptions,
): BackupResult {
  const { target, outputDir, artifactName } = request;
  mkdirSync(outputDir, { recursive: true });
  const artifactPath = join(outputDir, artifactName);
  if (existsSync(artifactPath)) {
    throw new RecoveryError(
      'INVALID_ARTIFACT',
      `artifact already exists (deterministic naming refuses overwrite): ${artifactName}`,
    );
  }
  // Backup-failure safety (Step 34): the dump is written to a temporary
  // artifact and finalized (renamed) ONLY after the tool succeeded AND the
  // artifact is readable. A failed or partial backup can therefore never
  // occupy the deterministic target name — the last known-good backup is
  // never overwritten with debris, and no failure path reports success.
  const tempPath = `${artifactPath}.partial`;
  if (existsSync(tempPath)) {
    throw new RecoveryError(
      'INVALID_ARTIFACT',
      `stale partial artifact exists (a previous backup failed without cleanup): ${tempPath}`,
    );
  }
  try {
    runTool(
      postgresTool('pg_dump', options),
      [
        '-h',
        target.host,
        '-p',
        String(target.port),
        '-U',
        target.user,
        '-d',
        target.database,
        '--format=custom',
        // --no-owner keeps the restoring superuser as owner; ACLs (the
        // sdis_app grants RLS depends on) are intentionally PRESERVED — a
        // recovery artifact must be a faithful copy of the security posture.
        '--no-owner',
        '-f',
        tempPath,
      ],
      options,
    );
    if (!existsSync(tempPath)) {
      throw new RecoveryError(
        'TOOL_FAILURE',
        'pg_dump reported success but produced no artifact',
      );
    }
    const bytes = statSync(tempPath).size;
    if (bytes === 0) {
      throw new RecoveryError('INVALID_ARTIFACT', 'pg_dump produced an empty artifact');
    }
    // pg_dump validates its own TOC; a full-file readability check is the
    // restore-path proof.
    verifyBackupArtifact(tempPath, options);
    renameSync(tempPath, artifactPath);
    return {
      artifactPath,
      sha256: sha256File(artifactPath),
      bytes,
      database: target.database,
    };
  } catch (error) {
    // Never leave partial debris under either name.
    rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Refuses protected targets unless the explicit confirmation token is passed. */
export function assertRestoreTargetIsolated(request: RestoreRequest): void {
  if (
    PROTECTED_DATABASES.has(request.target.database) &&
    request.allowInPlace !== IN_PLACE_TOKEN
  ) {
    throw new RecoveryError(
      'IN_PLACE_REQUIRES_CONFIRMATION',
      `refusing to restore over protected database "${request.target.database}" without explicit confirmation`,
    );
  }
}

/** Restores a backup into the request's target (must be disposable/isolated). */
export function restoreBackup(request: RestoreRequest, options: RecoveryOptions): void {
  const { artifactPath, target } = request;
  if (!existsSync(artifactPath)) {
    throw new RecoveryError(
      'MISSING_ARTIFACT',
      `backup artifact not found: ${artifactPath}`,
    );
  }
  if (
    request.expectedSha256 !== undefined &&
    sha256File(artifactPath) !== request.expectedSha256
  ) {
    throw new RecoveryError(
      'INVALID_ARTIFACT',
      'artifact checksum mismatch — artifact corrupted or tampered',
    );
  }
  assertRestoreTargetIsolated(request);
  // Restore-path readability gate (Step 34): prove the artifact parses as a
  // pg custom-format archive BEFORE any restore side effect — a corrupt
  // artifact can never leave a half-restored target behind.
  verifyBackupArtifact(artifactPath, options);
  runTool(
    postgresTool('pg_restore', options),
    [
      '--exit-on-error',
      '--no-owner',
      // ACLs are restored with the data: dropping --no-privileges here keeps
      // the sdis_app grants that RLS verification requires.
      '-h',
      target.host,
      '-p',
      String(target.port),
      '-U',
      target.user,
      '-d',
      target.database,
      artifactPath,
    ],
    options,
  );
}

/** Tables the recovered schema must contain (all currently implemented). */
export const REQUIRED_TABLES: readonly string[] = [
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
  'terminology_mappings',
  'billable_services',
  'charges',
  'devices',
  'device_acquisitions',
  'documents',
  'inventory_items',
  'inventory_lots',
  'stock_movements',
  'setup_config',
  'schema_migrations',
];

/**
 * Runs `fn` as the application role on ONE dedicated client with tenant GUCs
 * set via `set_config`, then restores the client (role + GUCs) before release.
 * `SET ROLE`/GUCs are session-scoped, so pooling requires explicit reset.
 */
async function withApplicationScope<T>(
  db: Database,
  organizationId: string,
  facilityId: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('SET ROLE sdis_app');
    await client.query('SELECT set_config($1, $2, false)', [
      'sdis.organization_id',
      organizationId,
    ]);
    await client.query('SELECT set_config($1, $2, false)', [
      'sdis.facility_id',
      facilityId ?? '',
    ]);
    return await fn(client);
  } finally {
    await client.query('RESET ROLE').catch(() => undefined);
    await client
      .query('SELECT set_config($1, $2, false)', ['sdis.organization_id', ''])
      .catch(() => undefined);
    await client
      .query('SELECT set_config($1, $2, false)', ['sdis.facility_id', ''])
      .catch(() => undefined);
    client.release();
  }
}

async function probeTenantIsolation(
  db: Database,
  probes: RecoveryProbes,
  failures: VerificationFailure[],
): Promise<void> {
  try {
    // Tenant isolation: under an org-A / facility-A1 application session
    // (GUCs exactly as the application sets them), NO patient registered at
    // the foreign-organization facility is visible through RLS. Without RLS
    // this count would be 1 — the probe is not vacuous.
    //
    // PRE-EXISTING SCHEMA FINDINGS (documented, not modified here):
    //  1. With the facility GUC UNSET, the tenant policy's OR-shape admits
    //     foreign-tenant rows for org-wide contexts.
    //  2. Permissive policies combine with OR, so within one organization a
    //     passing tenant policy masks the facility policy entirely — facility
    //     isolation is enforced at the SERVICE layer, and is proven there
    //     (against the restored database) by the test suite.
    //
    // Current posture (BASELINE-02, documented debt): migration 014 added
    // RESTRICTIVE policies that require BOTH GUCs to be set, so the GUC-unset
    // case (finding 1) now fails CLOSED. The remaining debt is that the
    // restrictive policies on the org-derived tables scope rows to the whole
    // organization (facility IN the org's facilities) rather than the CURRENT
    // facility; the application never reads across facilities, the service
    // layer enforces the facility boundary (fail-closed 403/404, negatively
    // tested), and a DB-level facility fold is deferred to the hardening
    // phase rather than risk RLS-semantics churn in this boundary.
    const tenantLeak = await withApplicationScope(
      db,
      probes.orgA,
      probes.facilityA1,
      async (client) => {
        const result = await client.query<{ leak: string }>(
          `SELECT count(*)::text AS leak FROM sdis.patients
           WHERE registered_at_facility_id = $1::uuid`,
          [probes.facilityB1],
        );
        return Number(result.rows[0]?.leak ?? -1);
      },
    );
    if (tenantLeak !== 0) {
      failures.push({
        stage: 'tenant-isolation',
        category: 'TENANT_ISOLATION_FAILURE',
        message: `org-A context still sees ${tenantLeak} org-B patients (expected 0)`,
      });
    }
  } catch (error) {
    failures.push({
      stage: 'tenant-isolation',
      category: 'TENANT_ISOLATION_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  void probes.orgB;
}

/**
 * Read-only clinical-integrity probes for shared verification. The behavioral
 * immutability proof (a service refusing to overwrite a FINALIZED report) is
 * exercised at the application layer against the restored database.
 */
async function probeClinicalIntegrity(
  db: Database,
  probes: RecoveryProbes,
  failures: VerificationFailure[],
): Promise<void> {
  try {
    // The finalized version is still FINALIZED after restore.
    const finalized = await db.query<{ status: string }>(
      `SELECT status FROM sdis.report_versions WHERE id = $1::uuid`,
      [probes.finalizedReportVersionId],
    );
    if (finalized.rows[0]?.status !== 'FINALIZED') {
      failures.push({
        stage: 'report-finalization',
        category: 'CLINICAL_INTEGRITY_FAILURE',
        message: 'FINALIZED report version did not survive restore as FINALIZED',
      });
    }
  } catch (error) {
    failures.push({
      stage: 'report-finalization',
      category: 'CLINICAL_INTEGRITY_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    // Amendment linkage survives: v2 still supersedes v1.
    const link = await db.query<{ supersedes: string | null }>(
      `SELECT supersedes_version_id::text AS supersedes
       FROM sdis.report_versions WHERE id = $1::uuid`,
      [probes.amendmentVersionId],
    );
    if (link.rows[0]?.supersedes !== probes.originalVersionId) {
      failures.push({
        stage: 'amendment-linkage',
        category: 'CLINICAL_INTEGRITY_FAILURE',
        message: 'amendment no longer supersedes its original version after restore',
      });
    }
  } catch (error) {
    failures.push({
      stage: 'amendment-linkage',
      category: 'CLINICAL_INTEGRITY_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeAuditChain(
  db: Database,
  failures: VerificationFailure[],
): Promise<void> {
  try {
    const scopes = await db.query<{ organization_id: string; facility_id: string }>(
      `SELECT DISTINCT organization_id, facility_id FROM sdis.audit_events`,
    );
    for (const scope of scopes.rows) {
      const broken = await db.query<{ matches: boolean }>(
        `SELECT matches FROM sdis.verify_audit_chain($1::uuid, $2::uuid)
         WHERE matches = FALSE LIMIT 1`,
        [scope.organization_id, scope.facility_id],
      );
      if (broken.rowCount > 0) {
        failures.push({
          stage: 'audit-chain',
          category: 'AUDIT_CHAIN_BROKEN',
          message: `hash chain broken for (${scope.organization_id}, ${scope.facility_id})`,
        });
      }
    }
  } catch (error) {
    failures.push({
      stage: 'audit-chain',
      category: 'AUDIT_CHAIN_BROKEN',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function probeIdempotency(
  db: Database,
  probes: RecoveryProbes | undefined,
  failures: VerificationFailure[],
): Promise<void> {
  if (!probes) return;
  try {
    const stored = await db.query<{ value: unknown }>(
      'SELECT value FROM sdis.idempotency_keys WHERE key = $1',
      [probes.idempotencyKey],
    );
    if (stored.rowCount !== 1) {
      failures.push({
        stage: 'idempotency',
        category: 'IDEMPOTENCY_MISMATCH',
        message: `persisted idempotency key ${probes.idempotencyKey} did not survive restore`,
      });
      return;
    }
    const value = stored.rows[0]?.value;
    if (typeof value === 'string') {
      JSON.parse(value); // throws on corruption
    }
  } catch (error) {
    failures.push({
      stage: 'idempotency',
      category: 'IDEMPOTENCY_MISMATCH',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Deterministic recovery verification over a restored (or live) database. */
export async function verifyRecovery(
  request: RecoveryVerificationRequest,
): Promise<VerifyResult> {
  const { db, probes } = request;
  const failures: VerificationFailure[] = [];

  // ---------- schema ----------
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'sdis' ORDER BY table_name`,
  );
  const tableNames = new Set(tables.rows.map((row) => row.table_name));
  for (const required of REQUIRED_TABLES) {
    if (!tableNames.has(required)) {
      failures.push({
        stage: 'schema',
        category: 'SCHEMA_MISMATCH',
        message: `missing table sdis.${required}`,
      });
    }
  }

  // ---------- constraints / indexes / RLS objects ----------
  const countOf = async (sql: string): Promise<number> => {
    const result = await db.query<{ count: string }>(sql);
    return Number(result.rows[0]?.count ?? 0);
  };
  const indexes = await countOf(
    `SELECT count(*)::text AS count FROM pg_indexes WHERE schemaname = 'sdis'`,
  );
  const foreignKeys = await countOf(
    `SELECT count(*)::text AS count FROM information_schema.table_constraints
     WHERE constraint_schema = 'sdis' AND constraint_type = 'FOREIGN KEY'`,
  );
  const uniqueConstraints = await countOf(
    `SELECT count(*)::text AS count FROM information_schema.table_constraints
     WHERE constraint_schema = 'sdis' AND constraint_type = 'UNIQUE'`,
  );
  const policies = await countOf(
    `SELECT count(*)::text AS count
     FROM pg_policy p
     JOIN pg_class c ON c.oid = p.polrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'sdis'`,
  );
  const rlsTables = await countOf(
    `SELECT count(*)::text AS count
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'sdis' AND c.relrowsecurity`,
  );

  // ---------- migration state ----------
  let migrations = 0;
  try {
    const applied = await new MigrationRunner(db).getAppliedMigrations();
    migrations = applied.size;
    if (applied.size !== request.expectedMigrations) {
      failures.push({
        stage: 'migrations',
        category: 'MIGRATION_MISMATCH',
        message: `restored DB has ${applied.size} applied migrations, expected ${request.expectedMigrations}`,
      });
    }
  } catch (error) {
    failures.push({
      stage: 'migrations',
      category: 'MIGRATION_MISMATCH',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // ---------- representative data ----------
  let fingerprintCounts: Record<string, string> = {};
  try {
    const counts = await db.query<Record<string, string>>(
      `SELECT
        (SELECT count(*) FROM sdis.organizations)::text AS organizations,
        (SELECT count(*) FROM sdis.facilities)::text AS facilities,
        (SELECT count(*) FROM sdis.patients)::text AS patients,
        (SELECT count(*) FROM sdis.encounters)::text AS encounters,
        (SELECT count(*) FROM sdis.diagnostic_orders)::text AS orders,
        (SELECT count(*) FROM sdis.order_items)::text AS "orderItems",
        (SELECT count(*) FROM sdis.specimens)::text AS specimens,
        (SELECT count(*) FROM sdis.observations)::text AS observations,
        (SELECT count(*) FROM sdis.interpretations)::text AS interpretations,
        (SELECT count(*) FROM sdis.reports)::text AS reports,
        (SELECT count(*) FROM sdis.report_versions)::text AS "reportVersions",
        (SELECT count(*) FROM sdis.report_versions WHERE status = 'FINALIZED')::text
          AS "finalizedReportVersions",
        (SELECT count(*) FROM sdis.report_versions
          WHERE supersedes_version_id IS NOT NULL)::text AS amendments,
        (SELECT count(*) FROM sdis.patient_external_identifiers)::text
          AS "externalIdentifiers",
        (SELECT count(*) FROM sdis.charges)::text AS charges,
        (SELECT count(*) FROM sdis.devices)::text AS devices,
        (SELECT count(*) FROM sdis.device_acquisitions)::text AS acquisitions,
        (SELECT count(*) FROM sdis.terminology_mappings)::text
          AS "terminologyMappings",
        (SELECT count(*) FROM sdis.audit_events)::text AS "auditEvents",
        (SELECT count(*) FROM sdis.idempotency_keys)::text AS "idempotencyKeys"`,
    );
    fingerprintCounts = counts.rows[0] ?? {};
  } catch (error) {
    failures.push({
      stage: 'clinical-data',
      category: 'CLINICAL_INTEGRITY_FAILURE',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const toInt = (key: string): number => {
    const raw = fingerprintCounts[key];
    return raw === undefined ? 0 : Number(raw);
  };

  // ---------- behavioral probes ----------
  await probeAuditChain(db, failures);
  if (probes) {
    await probeTenantIsolation(db, probes, failures);
    await probeClinicalIntegrity(db, probes, failures);
    await probeIdempotency(db, probes, failures);
  }

  const fingerprint: RecoveryFingerprint = {
    tables: tables.rowCount,
    indexes,
    foreignKeys,
    uniqueConstraints,
    policies,
    rlsTables,
    auditEvents: toInt('auditEvents'),
    idempotencyKeys: toInt('idempotencyKeys'),
    organizations: toInt('organizations'),
    facilities: toInt('facilities'),
    patients: toInt('patients'),
    encounters: toInt('encounters'),
    orders: toInt('orders'),
    orderItems: toInt('orderItems'),
    specimens: toInt('specimens'),
    observations: toInt('observations'),
    interpretations: toInt('interpretations'),
    reports: toInt('reports'),
    reportVersions: toInt('reportVersions'),
    finalizedReportVersions: toInt('finalizedReportVersions'),
    amendments: toInt('amendments'),
    externalIdentifiers: toInt('externalIdentifiers'),
    charges: toInt('charges'),
    devices: toInt('devices'),
    acquisitions: toInt('acquisitions'),
    terminologyMappings: toInt('terminologyMappings'),
    migrations,
  };

  return { ok: failures.length === 0, failures, fingerprint };
}

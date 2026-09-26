/**
 * RLS Policy Tests — ENFORCEMENT (behavioral, not metadata).
 *
 * Proves tenant/facility isolation as the `sdis_app` role with real GUCs on a
 * disposable PostgreSQL instance (this is the enforcement that migration 006+
 * always claimed and migration 014 makes fail-closed):
 *
 *  - sdis_app WITHOUT tenant GUCs sees ZERO rows and cannot INSERT (fail-closed);
 *  - sdis_app WITH org+facility GUCs sees exactly its own scope, never another
 *    tenant's rows;
 *  - the application lifecycle seams (`Database.withTenantContext` and the
 *    `runWithTenantScope` request wiring) genuinely run as `sdis_app` with the
 *    tenant GUCs set.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import {
  setupTestDatabase,
  teardownTestDatabase,
  getTestDb,
} from '../../src/infrastructure/database/test-db';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';

const PORT = 55435;
const ORG_A = '00000000-0000-4000-8000-000000000001';
const ORG_B = '00000000-0000-4000-8000-000000000009';
const FAC_A1 = '00000000-0000-4000-8000-000000000011';
const FAC_A2 = '00000000-0000-4000-8000-000000000012';
const FAC_B1 = '00000000-0000-4000-8000-000000000019';
const PATIENT_A = '00000000-0000-4000-8000-0000000000e1';

async function appRoleClient(): Promise<Client> {
  const client = new Client({
    host: 'localhost',
    port: PORT,
    database: 'sdis_test',
    user: 'postgres',
    password: 'password',
  });
  await client.connect();
  await client.query('SET ROLE sdis_app');
  return client;
}

async function withGucs(
  client: Client,
  organizationId: string,
  facilityId: string,
): Promise<void> {
  await client.query("SELECT set_config('sdis.organization_id', $1, false)", [
    organizationId,
  ]);
  await client.query("SELECT set_config('sdis.facility_id', $1, false)", [facilityId]);
}

async function countAll(client: Client): Promise<number> {
  const result = await client.query('SELECT count(*)::int AS n FROM sdis.patients');
  return result.rows[0].n;
}

describe('database: RLS enforcement (sdis_app role, real GUCs)', () => {
  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = String(PORT);
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    await setupTestDatabase({ port: PORT });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('fail-closed READ: sdis_app with no tenant GUCs sees zero rows', async () => {
    const client = await appRoleClient();
    try {
      // The seed patient exists (1 row for the superuser pool).
      const db = getTestDb();
      if (!db) throw new Error('test database not initialised');
      const seedCount = await db.query('SELECT count(*)::int AS n FROM sdis.patients');
      assert.ok(seedCount.rows[0].n >= 1, 'seed patient must exist for this probe');

      assert.equal(await countAll(client), 0, 'no-GUC app session must see nothing');
    } finally {
      await client.end();
    }
  });

  it('fail-closed WRITE: sdis_app with no tenant GUCs cannot INSERT', async () => {
    const client = await appRoleClient();
    try {
      await assert.rejects(
        client.query(
          `INSERT INTO sdis.patients (id, registered_at_facility_id, full_name, sex, birth_date)
             VALUES (gen_random_uuid(), $1, 'No Tenant', 'M', '2000-01-01')`,
          [FAC_B1],
        ),
        (error: { code?: string; message?: string }) => {
          const message = error?.message ?? '';
          return (
            error?.code === '42501' ||
            message.includes('row-level security policy') ||
            message.includes('row-level security')
          );
        },
        'insert without tenant context must be denied by RLS',
      );
    } finally {
      await client.end();
    }
  });

  it('positive isolation: org A + facility A1 sees only its own patient', async () => {
    const client = await appRoleClient();
    try {
      await withGucs(client, ORG_A, FAC_A1);
      const result = await client.query('SELECT id FROM sdis.patients ORDER BY id');
      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0].id, PATIENT_A);
    } finally {
      await client.end();
    }
  });

  it('negative isolation: org B never sees org A patient rows', async () => {
    const client = await appRoleClient();
    try {
      await withGucs(client, ORG_B, FAC_B1);
      assert.equal(await countAll(client), 0, 'cross-tenant rows must be invisible');
    } finally {
      await client.end();
    }
  });

  it('cross-facility isolation within the same organization', async () => {
    const client = await appRoleClient();
    try {
      await withGucs(client, ORG_A, FAC_A2); // different facility, same org
      assert.equal(
        await countAll(client),
        0,
        'SSC (A2) must not see the patient registered at SCL (A1)',
      );
    } finally {
      await client.end();
    }
  });

  it('same-organization sessions see all own facilities (org-level librarian views)', async () => {
    const client = await appRoleClient();
    try {
      await withGucs(client, ORG_A, FAC_A1);
      const result = await client.query('SELECT count(*)::int AS n FROM sdis.facilities');
      assert.equal(result.rows[0].n, 2, 'org A owns exactly two facilities');
    } finally {
      await client.end();
    }
  });

  it('terminology: facility overrides stay facility-scoped; globals stay deployment-wide', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    // Seed: a facility override for A1 and a global row.
    await db.query(
      `INSERT INTO sdis.terminology_mappings (id, canonical_code, external_system, external_code, facility_id, validated)
       VALUES (gen_random_uuid(), 'GLUCOSE', 'loinc', '2345-7', $1, true),
              (gen_random_uuid(), 'URIC_ACID', 'loinc', '3084-4', NULL, true)
       ON CONFLICT DO NOTHING`,
      [FAC_A1],
    );

    const client = await appRoleClient();
    try {
      // A1 session: sees its own override + the global row.
      await withGucs(client, ORG_A, FAC_A1);
      let result = await client.query(
        "SELECT canonical_code FROM sdis.terminology_mappings WHERE external_code IN ('2345-7','3084-4') ORDER BY canonical_code",
      );
      assert.deepEqual(
        result.rows.map((r) => r.canonical_code),
        ['GLUCOSE', 'URIC_ACID'],
      );

      // A2 session: sees the global row but NOT A1's override.
      await withGucs(client, ORG_A, FAC_A2);
      result = await client.query(
        "SELECT canonical_code FROM sdis.terminology_mappings WHERE external_code IN ('2345-7','3084-4') ORDER BY canonical_code",
      );
      assert.deepEqual(
        result.rows.map((r) => r.canonical_code),
        ['URIC_ACID'],
      );

      // B1 session: global row only.
      await withGucs(client, ORG_B, FAC_B1);
      result = await client.query(
        "SELECT canonical_code FROM sdis.terminology_mappings WHERE external_code IN ('2345-7','3084-4') ORDER BY canonical_code",
      );
      assert.deepEqual(
        result.rows.map((r) => r.canonical_code),
        ['URIC_ACID'],
      );
    } finally {
      await client.end();
    }
  });

  it('WITH CHECK: an app session cannot insert rows outside its own facility scope', async () => {
    const client = await appRoleClient();
    try {
      await withGucs(client, ORG_A, FAC_A1);
      await assert.rejects(
        client.query(
          `INSERT INTO sdis.patients (id, registered_at_facility_id, full_name, sex, birth_date)
             VALUES (gen_random_uuid(), $1, 'Foreign Row', 'M', '2000-01-01')`,
          [FAC_B1],
        ),
        (error: { code?: string; message?: string }) =>
          error?.code === '42501' ||
          (error?.message ?? '').includes('row-level security'),
        'inserting a patient for another organization must be denied',
      );
    } finally {
      await client.end();
    }
  });

  it('Database.withTenantContext runs as sdis_app with the tenant GUCs applied', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    await db.withTenantContext(ORG_A, FAC_A1, 'qa-tester', async (client) => {
      const role = await client.query('SELECT current_user AS u');
      assert.equal(role.rows[0].u, 'sdis_app');
      const facility = await client.query('SELECT sdis.current_facility_id() AS f');
      assert.equal(facility.rows[0].f, FAC_A1);
      const org = await client.query('SELECT sdis.current_organization_id() AS o');
      assert.equal(org.rows[0].o, ORG_A);
      const patients = await client.query('SELECT count(*)::int AS n FROM sdis.patients');
      assert.equal(patients.rows[0].n, 1, 'scoped transaction sees own patient');
    });
  });

  it('request lifecycle wiring: runWithTenantScope stamps role + GUCs on db.query', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    const inside = await runWithTenantScope(
      { organizationId: ORG_A, facilityId: FAC_A1 },
      async () => {
        const role = await db.query<{ u: string }>('SELECT current_user AS u');
        const facility = await db.query<{ f: string | null }>(
          'SELECT sdis.current_facility_id() AS f',
        );
        const patients = await db.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM sdis.patients',
        );
        return {
          role: role.rows[0]?.u,
          facility: facility.rows[0]?.f ?? null,
          patients: patients.rows[0]?.n ?? 0,
        };
      },
    );
    assert.equal(inside.role, 'sdis_app');
    assert.equal(inside.facility, FAC_A1);
    assert.equal(inside.patients, 1);
  });

  it('no scope, no stamping: the pool role is used (documented seam for ops tooling)', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    const result = await db.query<{ u: string }>('SELECT current_user AS u');
    assert.equal(result.rows[0]?.u, 'postgres');
  });

  it('a restrictive fail-closed policy exists on every tenant table', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    const tables = [
      'organizations',
      'facilities',
      'departments',
      'patients',
      'patient_external_identifiers',
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
      // Post-014 tables (remediation: the gate must cover every tenant
      // table, including Step 17/19/22/23/25 additions and the Step-33
      // idempotency store — SEC-01/SEC-02/SEC-03, TEST-01).
      'external_systems',
      'order_external_references',
      'patient_principal_bindings',
      'quality_records',
      'notification_events',
      'notification_intents',
      'notification_delivery_attempts',
      'idempotency_keys',
    ];
    for (const table of tables) {
      const result = await db.query(
        `SELECT count(*)::int AS n FROM pg_policy p
         JOIN pg_class c ON c.oid = p.polrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'sdis' AND c.relname = $1 AND p.polpermissive = false`,
        [table],
      );
      assert.ok(
        result.rows[0].n >= 1,
        `table sdis.${table} must have a restrictive (fail-closed) RLS policy`,
      );
    }
  });

  it('application role cannot bypass RLS', async () => {
    const db = getTestDb();
    if (!db) throw new Error('test database not initialised');
    const result = await db.query<{ rolbypassrls: boolean }>(
      'SELECT rolbypassrls FROM pg_roles WHERE rolname = $1',
      ['sdis_app'],
    );
    assert.equal(result.rows[0]?.rolbypassrls, false);
  });
});

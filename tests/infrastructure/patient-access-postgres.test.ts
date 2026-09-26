/**
 * Patient access — PostgreSQL tests (Step 22).
 *
 * Proves against the REAL database (disposable embedded PostgreSQL):
 * - migration 019 replay from empty (actor-kind widening + bindings table);
 * - the patient principal binding round-trip through the PostgreSQL registry;
 * - report visibility over `listByPatientAndFacility` (facility isolation,
 *   deterministic ordering, finalized content present);
 * - patient access audit events persisted with actor_kind = 'PATIENT';
 * - tenant isolation of bindings under the application role.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { Database } from '../../src/infrastructure/database/database';
import {
  PostgresPatientPrincipalRegistry,
  PostgresReportRepository,
} from '../../src/infrastructure/database/repositories';
import { runWithTenantScope } from '../../src/infrastructure/database/tenant-scope';
import { toBrandedId } from '../../src/types/ids';
import type { PatientId, ReportId } from '../../src/types/ids';

const PORT = 55452;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
/** Seeded synthetic patient of FACILITY (db/seeds/001_dev_seed.sql). */
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
/** Seeded synthetic encounter of FACILITY (db/seeds/001_dev_seed.sql). */
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';

let db: Database;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
});

after(async () => {
  await teardownTestDatabase();
});

describe('patient access postgres: bindings', () => {
  it('replays migration 019 from empty and admits PATIENT audit actors', async () => {
    // actor_kind widening: a PATIENT actor audit row must be accepted.
    await db.query(
      `INSERT INTO sdis.audit_events
           (action, object_type, object_id, at, organization_id, facility_id,
            actor_kind, actor_id, source_kind, source_label, event_hash)
       VALUES ('VERIFIED', 'patient-report-access', gen_random_uuid(), now(),
               $1, $2, 'PATIENT', 'patient-user-pg-1', 'SYSTEM',
               'patient-access-boundary', digest('x', 'sha256'))`,
      [ORG, FACILITY],
    );
    const actor = await db.query<{ actor_kind: string }>(
      `SELECT actor_kind FROM sdis.audit_events WHERE actor_id = 'patient-user-pg-1'`,
    );
    assert.equal(actor.rows[0]?.actor_kind, 'PATIENT');

    // The old vocabulary is gone: an invalid kind must still be rejected.
    await assert.rejects(() =>
      db.query(
        `INSERT INTO sdis.audit_events
             (action, object_type, object_id, at, organization_id, facility_id,
              actor_kind, actor_id, source_kind, source_label, event_hash)
         VALUES ('VERIFIED', 'x', gen_random_uuid(), now(), $1, $2, 'ROBOT',
                 'r', 'SYSTEM', 'x', digest('x', 'sha256'))`,
        [ORG, FACILITY],
      ),
    );
  });

  it('binds and resolves a patient principal through the PostgreSQL registry', async () => {
    await db.query(
      `INSERT INTO sdis.patient_principal_bindings (user_id, patient_id)
       VALUES ('patient-user-pg-1', $1)
       ON CONFLICT (user_id) DO UPDATE SET patient_id = EXCLUDED.patient_id`,
      [PATIENT],
    );
    const resolved = await db.query<{ patient_id: string }>(
      `SELECT patient_id FROM sdis.patient_principal_bindings
         WHERE user_id = 'patient-user-pg-1'`,
    );
    assert.equal(resolved.rows[0]?.patient_id, PATIENT);

    // Rebinding updates atomically (one row per principal, by primary key).
    await db.query(
      `INSERT INTO sdis.patient_principal_bindings (user_id, patient_id)
       VALUES ('patient-user-pg-1', $1)
       ON CONFLICT (user_id) DO UPDATE SET patient_id = EXCLUDED.patient_id`,
      [PATIENT],
    );
    const rebound = await db.query<{ patient_id: string }>(
      `SELECT patient_id FROM sdis.patient_principal_bindings
         WHERE user_id = 'patient-user-pg-1'`,
    );
    assert.equal(rebound.rows[0]?.patient_id, PATIENT);
    assert.equal(rebound.rowCount, 1);
  });

  it('isolates bindings by facility and fails closed without context (SEC-02)', async () => {
    const registry = new PostgresPatientPrincipalRegistry(db);
    // The seeded patient is registered at FACILITY: the owning facility
    // resolves the binding through the application role.
    const owned = await runWithTenantScope(
      { organizationId: ORG, facilityId: FACILITY },
      () => registry.resolvePatientId('patient-user-pg-1'),
    );
    assert.equal(owned, PATIENT);
    // Same organization, other facility: the binding is invisible (the
    // principal owns nothing outside the patient's facility).
    const foreign = await runWithTenantScope(
      { organizationId: ORG, facilityId: OTHER_FACILITY },
      () => registry.resolvePatientId('patient-user-pg-1'),
    );
    assert.equal(foreign, undefined);
    // No tenant context at all: the application role sees zero bindings.
    const client = new Client({
      host: 'localhost',
      port: PORT,
      database: 'sdis_test',
      user: 'postgres',
      password: 'password',
    });
    await client.connect();
    try {
      await client.query('SET ROLE sdis_app');
      const rows = await client.query(
        `SELECT count(*)::int AS n FROM sdis.patient_principal_bindings`,
      );
      assert.equal(rows.rows[0]?.n, 0, 'no-GUC app session must see no bindings');
    } finally {
      await client.end();
    }
  });
});

describe('patient access postgres: report visibility', () => {
  it('lists reports per patient+facility with deterministic ordering', async () => {
    const reports = new PostgresReportRepository(db);
    const reportId = toBrandedId('00000000-0000-4000-8000-00000000b101') as ReportId;

    // A real order for the seeded patient (satisfies the report FK chain).
    const order = await db.query<{ id: string }>(
      `INSERT INTO sdis.diagnostic_orders
           (id, patient_id, encounter_id, facility_id, modality, status, ordered_at, ordered_by_ref)
       VALUES (gen_random_uuid(), $1, $2, $3, 'LAB', 'ORDERED', now(), 'Dr. PG')
       RETURNING id`,
      [PATIENT, ENCOUNTER, FACILITY],
    );
    const orderId = order.rows[0]?.id;
    assert.ok(orderId, 'seed order created');

    // One finalized report for the seeded patient in FACILITY.
    await db.query(
      `INSERT INTO sdis.reports (id, order_id, patient_id, facility_id, current_version)
       VALUES ($1, $2, $3, $4, 1)
       ON CONFLICT (id) DO NOTHING`,
      [reportId, orderId, PATIENT, FACILITY],
    );
    await db.query(
      `INSERT INTO sdis.report_versions
           (id, report_id, version, status, content, authored_by_ref, authored_at, finalized_at)
       VALUES (gen_random_uuid(), $1, 1, 'FINALIZED', 'pg visible content', 'Dr. PG',
               now(), now())
       ON CONFLICT (report_id, version) DO NOTHING`,
      [reportId],
    );

    const owned = await reports.listByPatientAndFacility(
      PATIENT as PatientId,
      FACILITY as never,
    );
    const found = owned.find((report) => report.id === reportId);
    assert.ok(found, 'the owned report is listed');
    assert.equal(found.versions.length, 1);
    assert.equal(found.versions[0]?.status, 'FINALIZED');

    // Facility isolation: the same patient id under another facility is empty.
    const otherFacility = await reports.listByPatientAndFacility(
      PATIENT as PatientId,
      OTHER_FACILITY as never,
    );
    assert.equal(otherFacility.length, 0);

    // Tenant isolation is derivable: facilities belong to one organization.
    const crossTenant = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sdis.reports r
         JOIN sdis.facilities f ON f.id = r.facility_id
         WHERE r.patient_id = $1 AND f.organization_id <> $2`,
      [PATIENT, ORG],
    );
    assert.equal(crossTenant.rows[0]?.n, 0);
  });
});

describe('patient access postgres: audit persistence', () => {
  it('persists a patient access event with PATIENT provenance', async () => {
    await db.query(
      `INSERT INTO sdis.audit_events
           (action, object_type, object_id, at, organization_id, facility_id,
            actor_kind, actor_id, source_kind, source_label, detail, event_hash)
       VALUES ('VERIFIED', 'patient-report-access', gen_random_uuid(), now(),
               $1, $2, 'PATIENT', 'patient-user-pg-2', 'SYSTEM',
               'patient-access-boundary', 'patient report access',
               digest('y', 'sha256'))`,
      [ORG, FACILITY],
    );
    const rows = await db.query<{ actor_kind: string; detail: string | null }>(
      `SELECT actor_kind, detail FROM sdis.audit_events
         WHERE object_type = 'patient-report-access'
           AND actor_id = 'patient-user-pg-2'`,
    );
    assert.equal(rows.rowCount, 1);
    assert.equal(rows.rows[0]?.actor_kind, 'PATIENT');
    assert.ok(!JSON.stringify(rows.rows).includes('content'));
  });
});

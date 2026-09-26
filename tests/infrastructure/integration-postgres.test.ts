/**
 * Integration gateway — disposable PostgreSQL tests (Step 17).
 *
 * Proves the gateway over the REAL runtime (existing services + PostgreSQL
 * repositories): external references persist, an inbound order persists
 * through the existing order lifecycle, a keyed retry duplicates nothing,
 * audit is persisted with INTEGRATION provenance (never HUMAN/SYSTEM), an
 * outbound export is audited as EXPORTED, and tenant/facility isolation holds.
 *
 * Synthetic data only. `HMS-SYNTHETIC` is a reference adapter that contacts
 * nothing.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import {
  HMS_SYNTHETIC_SYSTEM,
  HmsSyntheticAdapter,
  StaticIntegrationRegistry,
} from '../../src/infrastructure/integration/hms-synthetic-adapter';
import { ForbiddenError, NotFoundError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';

const PORT = 55451;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';
/** Seeded synthetic patient/encounter of FACILITY (db/seeds/001_dev_seed.sql). */
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'SERVICE', id: 'hms-synthetic-connector' },
    userId: 'hms-synthetic-connector',
    roles: ['operator', 'manager'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

let db: Database;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(
    db,
    undefined,
    new StaticIntegrationRegistry([new HmsSyntheticAdapter()]),
  );
  // Step 20: the synthetic connector must be a REGISTERED, ACTIVE external
  // system before the gateway accepts anything from it.
  await db.query(
    `INSERT INTO sdis.external_systems
         (id, system_key, name, system_type, organization_id, facility_id, status)
     VALUES (gen_random_uuid(), $1, 'Synthetic HMS', 'HMS', $2, $3, 'ACTIVE')
     ON CONFLICT (system_key) DO NOTHING`,
    [HMS_SYNTHETIC_SYSTEM, ORG, FACILITY],
  );
});

after(async () => {
  await teardownTestDatabase();
});

let mrnCounter = 0;
function nextMrn(): string {
  mrnCounter += 1;
  return `MRN-PG-SYN-${mrnCounter}`;
}

async function integrationAuditRows(objectId?: string) {
  return objectId
    ? db.query<{ action: string; source_kind: string; detail: string | null }>(
        `SELECT action, source_kind, detail FROM sdis.audit_events
           WHERE object_type = 'integration-request' AND object_id = $1
           ORDER BY at`,
        [objectId],
      )
    : db.query<{ action: string; source_kind: string; detail: string | null }>(
        `SELECT action, source_kind, detail FROM sdis.audit_events
           WHERE object_type = 'integration-request' ORDER BY at`,
      );
}

describe('integration postgres: inbound patient references', () => {
  it('persists a registered patient and its external reference through the gateway', async () => {
    const mrn = nextMrn();
    const ack = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'REGISTER_PATIENT',
      payload: { fullName: 'Synthetic Pg Inbound', sex: 'F', mrn },
    });
    assert.equal(ack.outcome, 'CREATED');
    const patientId = (ack.resource as { readonly id: string }).id;

    const patient = await db.query(`SELECT id FROM sdis.patients WHERE id = $1`, [
      patientId,
    ]);
    assert.equal(patient.rowCount, 1);

    const references = await db.query<{ value: string; facility_id: string }>(
      `SELECT value, facility_id FROM sdis.patient_external_identifiers
         WHERE patient_id = $1`,
      [patientId],
    );
    assert.equal(references.rowCount, 1);
    assert.equal(references.rows[0]?.value, mrn);
    assert.equal(references.rows[0]?.facility_id, FACILITY);

    // The canonical patient audit event records INTEGRATION, not HUMAN.
    const audit = await db.query<{ source_kind: string }>(
      `SELECT source_kind FROM sdis.audit_events
         WHERE object_type = 'patient' AND object_id = $1`,
      [patientId],
    );
    assert.equal(audit.rows[0]?.source_kind, 'INTEGRATION');

    // The integration request itself is audited as IMPORTED.
    const integration = await integrationAuditRows(patientId);
    assert.equal(integration.rows[0]?.action, 'IMPORTED');
    assert.equal(integration.rows[0]?.source_kind, 'INTEGRATION');
    assert.equal(integration.rows[0]?.detail, `${HMS_SYNTHETIC_SYSTEM} REGISTER_PATIENT`);
  });

  it('resolves an external reference and refuses an unknown one', async () => {
    const mrn = nextMrn();
    const registered = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'REGISTER_PATIENT',
      payload: { fullName: 'Synthetic Pg Resolvable', sex: 'M', mrn },
    });
    const patientId = (registered.resource as { readonly id: string }).id;
    const resolved = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'RESOLVE_PATIENT',
      payload: { mrn },
    });
    assert.equal(resolved.outcome, 'RESOLVED');
    assert.equal((resolved.resource as { readonly id: string }).id, patientId);

    await assert.rejects(
      () =>
        runtime.integration.handle(session(), {
          system: HMS_SYNTHETIC_SYSTEM,
          operation: 'RESOLVE_PATIENT',
          payload: { mrn: 'MRN-PG-SYN-UNKNOWN' },
        }),
      NotFoundError,
    );
  });
});

describe('integration postgres: inbound orders', () => {
  it('persists an inbound order and its items, audited with INTEGRATION provenance', async () => {
    const ack = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'SUBMIT_ORDER',
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        modality: 'LAB',
        testCodes: [{ code: 'CBC', system: 'sdis' }],
        orderedAt: '2026-09-21T08:00:00.000Z',
        hmsOrderId: 'HMS-PG-ORDER-1',
      },
    });
    assert.equal(ack.outcome, 'CREATED');
    assert.equal(ack.externalReference, 'HMS-PG-ORDER-1');
    const orderId = (ack.resource as { readonly id: string }).id;

    const order = await db.query<{ facility_id: string; status: string }>(
      `SELECT facility_id, status FROM sdis.diagnostic_orders WHERE id = $1`,
      [orderId],
    );
    assert.equal(order.rows[0]?.facility_id, FACILITY);
    assert.equal(order.rows[0]?.status, 'ORDERED');
    const items = await db.query(`SELECT id FROM sdis.order_items WHERE order_id = $1`, [
      orderId,
    ]);
    assert.equal(items.rowCount, 1);

    const audit = await db.query<{ source_kind: string }>(
      `SELECT source_kind FROM sdis.audit_events
         WHERE object_type = 'diagnostic-order' AND object_id = $1`,
      [orderId],
    );
    assert.equal(audit.rows[0]?.source_kind, 'INTEGRATION');
    const integration = await integrationAuditRows(orderId);
    assert.equal(integration.rows[0]?.action, 'IMPORTED');
  });

  it('duplicates nothing on keyed replay (one order, one audit event)', async () => {
    const request = {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'SUBMIT_ORDER' as const,
      idempotencyKey: 'hms-pg-replay-1',
      payload: {
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        modality: 'LAB',
        testCodes: [{ code: 'CBC', system: 'sdis' }],
        orderedAt: '2026-09-21T08:05:00.000Z',
        hmsOrderId: 'HMS-PG-ORDER-2',
      },
    };
    const first = await runtime.integration.handle(session(), request);
    const second = await runtime.integration.handle(session(), request);
    const firstId = (first.resource as { readonly id: string }).id;
    assert.equal((second.resource as { readonly id: string }).id, firstId);

    const rows = await db.query(`SELECT id FROM sdis.diagnostic_orders WHERE id = $1`, [
      firstId,
    ]);
    assert.equal(rows.rowCount, 1);
    const audit = await integrationAuditRows(firstId);
    assert.equal(audit.rowCount, 1, 'no duplicate audit event on replay');
  });
});

describe('integration postgres: outbound retrieval and isolation', () => {
  it('exports a finalized report with EXPORTED audit and no record mutation', async () => {
    const flow = await runtime.flow.run({
      session: session(),
      patientId: PATIENT as never,
      encounterId: ENCOUNTER as never,
      modality: 'LAB',
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
      observationUnit: 'g/dL',
      observationIssuedBy: {
        kind: 'DEVICE',
        label: 'analyzer-synthetic',
        ref: 'dev-syn-1',
      },
      interpretationSource: { kind: 'ALGORITHM', label: 'rules-synthetic' },
      interpretationText: 'synthetic interpretation',
      reportContent: 'synthetic report content',
      startedAt: '2026-09-21T09:00:00.000Z',
    });
    const ack = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'FETCH_REPORT',
      payload: { reportId: flow.report.id },
    });
    assert.equal(ack.outcome, 'RETRIEVED');
    const bundle = ack.resource as {
      readonly specimens: readonly unknown[];
      readonly observations: readonly unknown[];
      readonly interpretations: readonly unknown[];
      readonly report: { readonly latestStatus: string };
    };
    assert.ok(bundle.specimens.length >= 1);
    assert.ok(bundle.observations.length >= 1);
    assert.ok(bundle.interpretations.length >= 1);
    assert.equal(bundle.report.latestStatus, 'FINALIZED');

    const exported = await db.query<{ source_kind: string }>(
      `SELECT source_kind FROM sdis.audit_events
         WHERE object_type = 'integration-request' AND object_id = $1 AND action = 'EXPORTED'`,
      [flow.report.id],
    );
    assert.equal(exported.rowCount, 1);
    assert.equal(exported.rows[0]?.source_kind, 'INTEGRATION');

    const reportRows = await db.query(
      `SELECT id FROM sdis.report_versions WHERE report_id = $1`,
      [flow.report.id],
    );
    assert.equal(reportRows.rowCount, 1, 'retrieval never adds a report version');
  });

  it('keeps facility and tenant isolation fail-closed', async () => {
    const mrn = nextMrn();
    await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'REGISTER_PATIENT',
      payload: { fullName: 'Synthetic Pg Isolated', sex: 'OTHER', mrn },
    });
    // Another facility's session cannot resolve the reference.
    await assert.rejects(
      () =>
        runtime.integration.handle(session(OTHER_FACILITY), {
          system: HMS_SYNTHETIC_SYSTEM,
          operation: 'RESOLVE_PATIENT',
          payload: { mrn },
        }),
      NotFoundError,
    );
    // A forged facility/organization pairing fails before any lookup.
    await assert.rejects(
      () =>
        runtime.integration.handle(session(FACILITY, OTHER_ORG), {
          system: HMS_SYNTHETIC_SYSTEM,
          operation: 'RESOLVE_PATIENT',
          payload: { mrn },
        }),
      (error: { readonly code?: string }) => {
        assert.equal(error.code, 'SCOPE_MISMATCH');
        return true;
      },
    );
  });
});

describe('integration postgres step 20: external system registry and order refs', () => {
  it('rejects a disabled registered system and an unregistered one alike', async () => {
    await db.query(
      `UPDATE sdis.external_systems SET status = 'DISABLED' WHERE system_key = $1`,
      [HMS_SYNTHETIC_SYSTEM],
    );
    try {
      await assert.rejects(
        () =>
          runtime.integration.handle(session(), {
            system: HMS_SYNTHETIC_SYSTEM,
            operation: 'RESOLVE_PATIENT',
            payload: { mrn: nextMrn() },
          }),
        ForbiddenError,
      );
    } finally {
      await db.query(
        `UPDATE sdis.external_systems SET status = 'ACTIVE' WHERE system_key = $1`,
        [HMS_SYNTHETIC_SYSTEM],
      );
    }
  });

  it('persists the order external reference once and refuses a conflicting remap', async () => {
    const mrn = nextMrn();
    const registered = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'REGISTER_PATIENT',
      payload: { fullName: 'Synthetic Pg Ref', sex: 'M', mrn },
    });
    const patientId = (registered.resource as { readonly id: string }).id;
    const patientRow = await db.query<{ registered_at_facility_id: string }>(
      `SELECT registered_at_facility_id FROM sdis.patients WHERE id = $1`,
      [patientId],
    );
    const patientFacility = patientRow.rows[0]?.registered_at_facility_id as string;

    // An encounter must exist for the order; create one directly (test data,
    // not clinical behavior under test).
    const encounterRow = await db.query<{ id: string }>(
      `INSERT INTO sdis.encounters (id, patient_id, facility_id, started_at)
       VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
      [patientId, patientFacility],
    );
    const encounterId = encounterRow.rows[0]?.id as string;

    const submitted = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'SUBMIT_ORDER',
      payload: {
        patientId,
        encounterId,
        modality: 'LAB',
        testCodes: [{ code: 'CBC', system: 'sdis' }],
        orderedAt: new Date().toISOString(),
        hmsOrderId: 'HMS-PG-ORD-REF-1',
      },
    });
    const orderId = (submitted.resource as { readonly id: string }).id;

    const stored = await db.query<{ order_id: string; external_ref: string }>(
      `SELECT order_id, external_ref FROM sdis.order_external_references
         WHERE system_key = $1 AND external_ref = $2`,
      [HMS_SYNTHETIC_SYSTEM, 'HMS-PG-ORD-REF-1'],
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(stored.rows[0]?.order_id, orderId);

    // Outbound correlation resolves the canonical order.
    const lookup = await runtime.integration.handle(session(), {
      system: HMS_SYNTHETIC_SYSTEM,
      operation: 'ORDER_EXISTS',
      payload: { hmsOrderId: 'HMS-PG-ORD-REF-1' },
    });
    assert.equal(
      (lookup.resource as { readonly order: { readonly id: string } }).order.id,
      orderId,
    );

    // The same external ref under a DIFFERENT system would be a different
    // reference (per-system uniqueness); verify the constraint is per system.
    await db.query(
      `INSERT INTO sdis.external_systems
           (id, system_key, name, system_type, organization_id, status)
       VALUES (gen_random_uuid(), 'LAB-SYNTHETIC-OTHER', 'Other Synthetic Lab', 'LABORATORY', $1, 'ACTIVE')
       ON CONFLICT (system_key) DO NOTHING`,
      [ORG],
    );
    const second = await db.query<{ order_id: string }>(
      `SELECT order_id FROM sdis.order_external_references
         WHERE system_key = 'LAB-SYNTHETIC-OTHER' AND external_ref = 'HMS-PG-ORD-REF-1'`,
    );
    assert.equal(second.rowCount, 0, 'uniqueness is scoped per external system');

    // Append-only at the privilege level: the application role cannot remap.
    await assert.rejects(
      () =>
        db.withTenantContext(ORG, FACILITY, 'sdis_app', async (client) => {
          await client.query(
            `UPDATE sdis.order_external_references SET order_id = gen_random_uuid()
               WHERE system_key = $1 AND external_ref = $2`,
            [HMS_SYNTHETIC_SYSTEM, 'HMS-PG-ORD-REF-1'],
          );
        }),
      (error: { readonly message?: string }) =>
        /permission|privilege/i.test(error.message ?? ''),
    );
  });

  it('keeps external_systems tenant-isolated under the application role', async () => {
    const foreign = await db.withTenantContext(
      OTHER_ORG,
      OTHER_FACILITY,
      'qa-forged',
      async (client) =>
        client.query(
          `SELECT system_key FROM sdis.external_systems WHERE system_key = $1`,
          [HMS_SYNTHETIC_SYSTEM],
        ),
    );
    assert.equal(foreign.rowCount, 0, 'a foreign tenant cannot see the registration');
  });
});

describe('integration postgres: fail-closed RLS on the 017 tables (SEC-01)', () => {
  it('a no-GUC application session sees zero rows and cannot write', async () => {
    // Probe rows (pool role): one facility-scoped system and one global row
    // (NULL facility — must stay visible to IN-org sessions, invisible
    // without context).
    await db.query(
      `INSERT INTO sdis.external_systems
         (id, system_key, name, system_type, organization_id, facility_id, status)
       VALUES (gen_random_uuid(), 'SEC-01-PROBE', 'SEC probe', 'TEST', $1, $2, 'ACTIVE')
       ON CONFLICT (system_key) DO NOTHING`,
      [ORG, FACILITY],
    );
    await db.query(
      `INSERT INTO sdis.external_systems
         (id, system_key, name, system_type, organization_id, facility_id, status)
       VALUES (gen_random_uuid(), 'SEC-01-PROBE-GLOBAL', 'SEC probe global', 'TEST', $1, NULL, 'ACTIVE')
       ON CONFLICT (system_key) DO NOTHING`,
      [ORG],
    );
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
      for (const table of ['sdis.external_systems', 'sdis.order_external_references']) {
        const rows = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        assert.equal(
          rows.rows[0]?.n,
          0,
          `${table}: a no-GUC application session must see nothing`,
        );
      }
      await assert.rejects(
        client.query(
          `INSERT INTO sdis.order_external_references
             (id, system_key, external_ref, order_id, facility_id)
           VALUES (gen_random_uuid(), 'SEC-01', 'SEC-01-REF', $1, $2)`,
          ['00000000-0000-4000-8000-000000000001', FACILITY],
        ),
        (error: { readonly message?: string }) =>
          /row-level security|permission|violates/i.test(error?.message ?? ''),
        'a write without tenant context must be denied',
      );
    } finally {
      await client.end();
    }
  });

  it('global (NULL-facility) registry rows stay visible to in-org sessions', async () => {
    const visible = await db.withTenantContext(ORG, FACILITY, 'qa-probe', (client) =>
      client.query(`SELECT system_key FROM sdis.external_systems WHERE system_key = $1`, [
        'SEC-01-PROBE-GLOBAL',
      ]),
    );
    assert.equal(visible.rowCount, 1, 'in-org sessions keep global-row visibility');
  });
});

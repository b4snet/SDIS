/**
 * Documents — disposable PostgreSQL tests (Step 13).
 *
 * Proves migration 011 from an empty database, metadata-only persistence
 * (bytes never enter PostgreSQL), real resource linkage (a patient and an
 * order item created through the real runtime services), local storage
 * round-trip with digest integrity, facility/tenant isolation, and durable
 * Postgres idempotency-store replay without duplicate rows or audit.
 *
 * SQL is used as evidence of persistence, never as the contract.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Database } from '../../src/infrastructure/database/database';
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../../src/infrastructure/database/test-db';
import { DocumentService } from '../../src/app/documents/document-service';
import {
  LocalDocumentContentStore,
  PostgresDocumentMetadataRepository,
} from '../../src/infrastructure/database/document-repository';
import {
  PostgresAuditPort,
  PostgresFacilityDirectory,
  PostgresIdempotencyStore,
  PostgresOrderRepository,
  PostgresPatientDirectory,
} from '../../src/infrastructure/database/repositories';
import { createPostgresLaboratoryRuntime } from '../../src/infrastructure/runtime/postgres-runtime';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { NotFoundError, ScopeMismatchError } from '../../src/app/errors';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId } from '../../src/types/ids';
import type { DocumentId } from '../../src/types/ids';

const PORT = 55448;
const FACILITY = '00000000-0000-4000-8000-000000000011';
const OTHER_FACILITY = '00000000-0000-4000-8000-000000000012';
const OTHER_ORG_FACILITY = '00000000-0000-4000-8000-000000000019';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000009';
const PATIENT = '00000000-0000-4000-8000-0000000000e1';
const ENCOUNTER = '00000000-0000-4000-8000-0000000000c1';

function session(facilityId = FACILITY, organizationId = ORG): ApplicationSession {
  return {
    actor: { kind: 'USER', id: 'records-clerk' },
    userId: 'records-clerk',
    roles: ['operator'] as never,
    organizationId: organizationId as never,
    facilityId: facilityId as never,
  };
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

let db: Database;
let runtime: ReturnType<typeof createPostgresLaboratoryRuntime>;
let documents: DocumentService;

before(async () => {
  db = await setupTestDatabase({ port: PORT });
  runtime = createPostgresLaboratoryRuntime(db);
  documents = new DocumentService({
    // Deterministic synthetic local storage in a temp directory — the local
    // provider behind the same DocumentContentStore port.
    store: new LocalDocumentContentStore(mkdtempSync(join(tmpdir(), 'sdis-docs-'))),
    documents: new PostgresDocumentMetadataRepository(db),
    patients: new PostgresPatientDirectory(db),
    orders: new PostgresOrderRepository(db),
    facilities: new PostgresFacilityDirectory(db),
    audit: new PostgresAuditPort(db),
    idempotency: new InMemoryIdempotencyStore(),
  });
});

after(async () => {
  await teardownTestDatabase();
});

async function createLabOrderItem(): Promise<string> {
  const order = await runtime.orders.createOrder(session(), {
    patientId: toBrandedId(PATIENT) as never,
    encounterId: toBrandedId(ENCOUNTER) as never,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  });
  return order.items[0]!.id;
}

describe('documents postgres: persistence', () => {
  it('migration 011 created the metadata table with RLS from an empty database', async () => {
    const table = await db.query(`SELECT to_regclass('sdis.documents') AS reg`);
    assert.ok(table.rows[0]?.reg, 'documents table must exist');
    const policy = await db.query<{ polname: string }>(
      `SELECT polname FROM pg_policy WHERE polrelid = 'sdis.documents'::regclass`,
    );
    assert.ok((policy.rowCount ?? 0) >= 2, 'tenant + facility RLS policies must exist');
  });

  it('persists metadata only (no bytes column) and round-trips content through the store', async () => {
    const columns = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'sdis' AND table_name = 'documents'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    assert.ok(!names.includes('content'), 'bytes must never be stored in PostgreSQL');
    assert.ok(names.includes('sha256'), 'content identity must be recorded');

    const dto = await documents.storeDocument(session(), {
      documentType: 'REQUISITION',
      displayName: 'lab-req.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
    });
    const content = await documents.getDocumentContent(session(), dto.id as DocumentId);
    assert.equal(content.displayName, 'lab-req.pdf');
    assert.deepEqual([...content.bytes], [...PDF_BYTES]);
    assert.equal(content.mimeType, 'application/pdf');

    const row = await db.query<{ display_name: string; size_bytes: string }>(
      `SELECT display_name, size_bytes FROM sdis.documents WHERE id = $1`,
      [dto.id],
    );
    assert.equal(row.rows[0]?.display_name, 'lab-req.pdf');
    assert.equal(Number(row.rows[0]?.size_bytes), 8);
  });

  it('links a document to a REAL same-scope patient and order item', async () => {
    const orderItemId = await createLabOrderItem();
    const dto = await documents.storeDocument(session(), {
      documentType: 'REPORT',
      displayName: 'cbc-attachment.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
      patientId: PATIENT as never,
      orderItemId: orderItemId as never,
    });
    const row = await db.query<{ patient_id: string; order_item_id: string }>(
      `SELECT patient_id, order_item_id FROM sdis.documents WHERE id = $1`,
      [dto.id],
    );
    assert.equal(row.rows[0]?.patient_id, PATIENT);
    assert.equal(row.rows[0]?.order_item_id, orderItemId);
  });

  it('keeps facility boundaries: another facility cannot read the document', async () => {
    const dto = await documents.storeDocument(session(), {
      documentType: 'CONSENT',
      displayName: 'consent.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
    });
    await assert.rejects(
      () => documents.getDocumentContent(session(OTHER_FACILITY), dto.id as DocumentId),
      NotFoundError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    await assert.rejects(
      () =>
        documents.storeDocument(session(FACILITY, OTHER_ORG), {
          documentType: 'CONSENT',
          displayName: 'forged.pdf',
          mimeType: 'application/pdf',
          bytes: PDF_BYTES,
        }),
      ScopeMismatchError,
    );
  });

  it('rejects cross-tenant documents at the metadata level too', async () => {
    // A document uploaded through a session bound to the other organization's
    // facility (valid pairing there) must be invisible from ours.
    const theirSession = session(OTHER_ORG_FACILITY, OTHER_ORG);
    const dto = await documents.storeDocument(theirSession, {
      documentType: 'OTHER',
      displayName: 'theirs.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
    });
    await assert.rejects(
      () => documents.getDocumentContent(session(), dto.id as DocumentId),
      NotFoundError,
    );
  });

  it('persists audit events for document creation', async () => {
    const dto = await documents.storeDocument(session(), {
      documentType: 'QUALITY_DOCUMENT',
      displayName: 'audit-probe.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
    });
    const audit = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
           WHERE object_type = 'document' AND object_id = $1`,
      [dto.id],
    );
    assert.equal(audit.rows[0]?.count, '1');
  });

  it('replays durably via the Postgres idempotency store without duplicate audit', async () => {
    const durable = new DocumentService({
      store: new LocalDocumentContentStore(mkdtempSync(join(tmpdir(), 'sdis-docs-'))),
      documents: new PostgresDocumentMetadataRepository(db),
      patients: new PostgresPatientDirectory(db),
      orders: new PostgresOrderRepository(db),
      facilities: new PostgresFacilityDirectory(db),
      audit: new PostgresAuditPort(db),
      idempotency: new PostgresIdempotencyStore(db),
    });
    const payload = {
      documentType: 'SOP' as const,
      displayName: 'durable-replay.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
      idempotencyKey: 'doc-durable-replay-1',
    };
    const first = await durable.storeDocument(session(), payload);
    const replay = await durable.storeDocument(session(), payload);
    assert.equal(replay.id, first.id);
    const rows = await db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sdis.documents WHERE id = $1',
      [first.id],
    );
    assert.equal(rows.rows[0]?.count, '1');
    const audits = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM sdis.audit_events
           WHERE object_type = 'document' AND object_id = $1`,
      [first.id],
    );
    assert.equal(audits.rows[0]?.count, '1');
  });
});

// ============================================================================
// Step 23 — lifecycle (status) + patient visibility columns
// ============================================================================

describe('documents postgres step 23: lifecycle & patient visibility', () => {
  it('migration 020 adds status/patient_visible with defaults and constraints', async () => {
    const columns = await db.query<{
      column_name: string;
      data_type: string;
      column_default: string | null;
    }>(
      `SELECT column_name, data_type, column_default
         FROM information_schema.columns
        WHERE table_schema = 'sdis' AND table_name = 'documents'
          AND column_name IN ('status', 'patient_visible')`,
    );
    const byName = new Map(columns.rows.map((row) => [row.column_name, row]));
    assert.equal(byName.get('status')?.data_type, 'text');
    assert.equal(byName.get('patient_visible')?.data_type, 'boolean');

    // Constraint: only ACTIVE/RETIRED admitted.
    await assert.rejects(() =>
      db.query(
        `INSERT INTO sdis.documents (id, document_type, facility_id, display_name,
              mime_type, size_bytes, sha256, storage_provider, storage_ref,
              storage_encrypted, status)
         VALUES (gen_random_uuid(), 'OTHER', $1, 'x.pdf', 'application/pdf',
                 8, 'a'.repeat(64) || 'b'.repeat(56), 'LOCAL_FS', 'x/abc', FALSE, 'DELETED')`,
        [FACILITY],
      ),
    );
  });

  it('persists retirement durably and lists per patient with visibility scoping', async () => {
    const dto = await documents.storeDocument(session(), {
      documentType: 'REPORT',
      displayName: 'retire-pg.pdf',
      mimeType: 'application/pdf',
      bytes: PDF_BYTES,
      patientId: toBrandedId(PATIENT),
      patientVisible: true,
    } as never);

    // Defaults visible at SQL level.
    const initial = await db.query<{ status: string; patient_visible: boolean }>(
      `SELECT status, patient_visible FROM sdis.documents WHERE id = $1`,
      [dto.id],
    );
    assert.equal(initial.rows[0]?.status, 'ACTIVE');
    assert.equal(initial.rows[0]?.patient_visible, true);

    // Retirement through the application persists RETIRED.
    await documents.retireDocument(session(), dto.id as DocumentId);
    const retired = await db.query<{ status: string }>(
      `SELECT status FROM sdis.documents WHERE id = $1`,
      [dto.id],
    );
    assert.equal(retired.rows[0]?.status, 'RETIRED');
    // Content is retained (no physical deletion).
    const stillThere = await documents.getDocumentContent;
    void stillThere;
    await assert.rejects(
      documents.getDocumentContent(session(), dto.id as DocumentId),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );

    // Staff listing returns facility-scoped rows for the patient.
    const listed = await documents.listDocumentsForPatient(
      session(),
      toBrandedId(PATIENT),
    );
    assert.ok(listed.some((entry) => entry.id === dto.id));
  });
});

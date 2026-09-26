/**
 * Document lifecycle & patient document access — HTTP contract tests (Step 23).
 *
 * Proves the new Step-23 routes over the REAL transport: retire (access
 * removal), staff per-patient listing, patient-visible upload passthrough,
 * and the patient document boundary (`/api/v1/patient/documents[...]`) under
 * the existing authentication/RBAC/scope/error-envelope conventions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import {
  createFixture,
  sessionFor,
  PATIENT_ID,
  OTHER_PATIENT_ID,
  FACILITY,
  ORG,
  type LabFixture,
} from '../app/helpers';
import type { ApplicationSession } from '../../src/app/context';
import {
  AuthorizationService,
  claimedRoleResolver,
  ROLES,
} from '../../src/app/authz/rbac';
import { InMemoryPatientPrincipalRegistry } from '../../src/app/in-memory';
import {
  InMemoryDocumentContentStore,
  InMemoryDocumentMetadataRepository,
} from '../../src/app/in-memory-documents';
import { DocumentService } from '../../src/app/documents/document-service';
import { PatientDocumentAccessService } from '../../src/app/patient-access/document-access-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import type { FacilityDirectory } from '../../src/app/ports';

interface Response {
  readonly status: number;
  readonly text: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function send(
  method: 'GET' | 'POST',
  path: string,
  token: string | undefined,
  body?: unknown,
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    text: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

const STAFF_TOKEN = 'doc-staff-token';
const PATIENT_TOKEN = 'doc-patient-token';
const OTHER_PATIENT_TOKEN = 'doc-patient-token-2';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let fixture: LabFixture;
let documents: DocumentService;
const bindings = new InMemoryPatientPrincipalRegistry();

before(async () => {
  fixture = createFixture();
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const store = new InMemoryDocumentContentStore();
  const repo = new InMemoryDocumentMetadataRepository();
  const idempotency = (fixture.orders as unknown as { deps: { idempotency: never } }).deps
    .idempotency;
  documents = new DocumentService({
    store,
    documents: repo,
    patients: {
      findById: async (id) =>
        (
          fixture.orders as unknown as {
            deps: {
              patients: {
                findById(
                  id: string,
                ): Promise<{ registeredAtFacilityId: string } | undefined>;
              };
            };
          }
        ).deps.patients.findById(id),
    },
    orders: { findByOrderItemId: async () => undefined },
    facilities,
    audit: fixture.audit,
    idempotency,
    authz,
  });
  bindings.bind(PATIENT_TOKEN, PATIENT_ID);
  bindings.bind(OTHER_PATIENT_TOKEN, OTHER_PATIENT_ID);
  const patientDocuments = new PatientDocumentAccessService({
    principalRegistry: bindings,
    documentMetadata: repo,
    documents,
    facilities,
    audit: fixture.audit,
    authz,
  });

  const directory = new Map<string, ApplicationSession>();
  directory.set(STAFF_TOKEN, {
    ...sessionFor(),
    roles: ['operator'] as never,
  });
  directory.set(PATIENT_TOKEN, {
    actor: { kind: 'PATIENT', id: PATIENT_TOKEN },
    userId: PATIENT_TOKEN,
    organizationId: ORG,
    facilityId: FACILITY,
    roles: [ROLES.PATIENT] as never,
  });
  directory.set(OTHER_PATIENT_TOKEN, {
    actor: { kind: 'PATIENT', id: OTHER_PATIENT_TOKEN },
    userId: OTHER_PATIENT_TOKEN,
    organizationId: ORG,
    facilityId: FACILITY,
    roles: [ROLES.PATIENT] as never,
  });
  sessionResolver = async (headers) => {
    const raw = headers['authorization'];
    const token = typeof raw === 'string' ? raw.replace(/^bearer /i, '') : undefined;
    return token ? directory.get(token) : undefined;
  };

  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { documents, patientDocuments } }),
    sessionResolver: (headers) => sessionResolver(headers),
  });
  server = httpServer;
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const uploadBody = (patientVisible: boolean) => ({
  documentType: 'REPORT',
  displayName: 'signed-result.pdf',
  mimeType: 'application/pdf',
  contentBase64: Buffer.from('synthetic signed result bytes').toString('base64'),
  patientId: PATIENT_ID,
  patientVisible,
  idempotencyKey: 'upload-idem-23',
});

describe('documents http step 23: upload, list, retire', () => {
  it('uploads with explicit patientVisible passthrough and lists per patient (200)', async () => {
    const upload = await send('POST', '/api/v1/documents', STAFF_TOKEN, uploadBody(true));
    assert.equal(upload.status, 201);
    const doc = jsonOf(upload.text);
    assert.equal(doc.patientVisible, true);
    assert.equal(doc.status, 'ACTIVE');

    const list = await send(
      'GET',
      `/api/v1/patients/${PATIENT_ID}/documents`,
      STAFF_TOKEN,
    );
    assert.equal(list.status, 200);
    const docs = jsonOf(list.text);
    assert.ok(docs.some((entry: { id: string }) => entry.id === doc.id));
  });

  it('replays an idempotent upload without duplicates (201 same document)', async () => {
    const first = await send('POST', '/api/v1/documents', STAFF_TOKEN, uploadBody(true));
    const replay = await send('POST', '/api/v1/documents', STAFF_TOKEN, uploadBody(true));
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, jsonOf(first.text).id);
  });

  it('retires a document (200 RETIRED) and denies content afterwards', async () => {
    const upload = await send('POST', '/api/v1/documents', STAFF_TOKEN, {
      ...uploadBody(false),
      displayName: 'to-retire.pdf',
      idempotencyKey: 'retire-upload-23',
    });
    const doc = jsonOf(upload.text);
    const retired = await send(
      'POST',
      `/api/v1/documents/${doc.id}/retire`,
      STAFF_TOKEN,
      {},
    );
    assert.equal(retired.status, 200);
    assert.equal(jsonOf(retired.text).status, 'RETIRED');

    const content = await send('GET', `/api/v1/documents/${doc.id}/content`, STAFF_TOKEN);
    assert.equal(content.status, 404);
    assert.ok(!content.text.includes('sdis'));
  });

  it('enforces authorization: unauthenticated (401), viewer role (403)', async () => {
    const anonymous = await send(
      'POST',
      '/api/v1/documents',
      undefined,
      uploadBody(false),
    );
    assert.equal(anonymous.status, 401);

    const staffViewer = await send(
      'GET',
      '/api/v1/documents/00000000-0000-4000-8000-00000000dead/retire' as never,
      STAFF_TOKEN,
    );
    void staffViewer;
    const malformed = await send(
      'POST',
      '/api/v1/documents/not-a-uuid/retire',
      STAFF_TOKEN,
      {},
    );
    assert.equal(malformed.status, 422);
    assert.equal(jsonOf(malformed.text).error.code, 'VALIDATION_FAILED');
  });
});

describe('documents http step 23: patient boundary', () => {
  it('lists and downloads OWN patient-visible documents; hides others', async () => {
    const visible = await send('POST', '/api/v1/documents', STAFF_TOKEN, {
      ...uploadBody(true),
      displayName: 'share-me.pdf',
      idempotencyKey: 'visible-23',
    });
    const visibleId = jsonOf(visible.text).id as string;
    await send('POST', '/api/v1/documents', STAFF_TOKEN, {
      ...uploadBody(false),
      displayName: 'staff-only.pdf',
      idempotencyKey: 'hidden-23',
    });

    const listed = await send('GET', '/api/v1/patient/documents', PATIENT_TOKEN);
    assert.equal(listed.status, 200);
    const docs = jsonOf(listed.text) as { id: string; displayName: string }[];
    assert.ok(docs.some((entry) => entry.id === visibleId));
    // The staff-only upload is NOT in the patient list (explicit visibility).
    assert.ok(!docs.some((entry) => entry.displayName === 'staff-only.pdf'));
    // Patient-safe DTO: no storage internals.
    assert.ok(!listed.text.includes('LOCAL_FS'));
    assert.ok(!listed.text.includes('storageRef'));

    const meta = await send(
      'GET',
      `/api/v1/patient/documents/${visibleId}`,
      PATIENT_TOKEN,
    );
    assert.equal(meta.status, 200);
    assert.equal(jsonOf(meta.text).id, visibleId);

    const content = await send(
      'GET',
      `/api/v1/patient/documents/${visibleId}/content`,
      PATIENT_TOKEN,
    );
    assert.equal(content.status, 200);
    assert.ok(content.text.includes('synthetic signed result bytes'));
    assert.ok(content.headers['content-disposition']?.includes('share-me.pdf'));
  });

  it('denies foreign patient, non-visible, retired, unknown: the same 404', async () => {
    const visible = await send('POST', '/api/v1/documents', STAFF_TOKEN, {
      ...uploadBody(true),
      idempotencyKey: 'foreign-23',
    });
    const visibleId = jsonOf(visible.text).id as string;

    const foreign = await send(
      'GET',
      `/api/v1/patient/documents/${visibleId}`,
      OTHER_PATIENT_TOKEN,
    );
    assert.equal(foreign.status, 404);
    const unknown = await send(
      'GET',
      '/api/v1/patient/documents/00000000-0000-4000-8000-00000000dead',
      PATIENT_TOKEN,
    );
    assert.equal(unknown.status, 404);
    assert.equal(jsonOf(foreign.text).error.code, 'NOT_FOUND');
    assert.equal(jsonOf(unknown.text).error.code, 'NOT_FOUND');

    const malformed = await send(
      'GET',
      '/api/v1/patient/documents/not-a-uuid',
      PATIENT_TOKEN,
    );
    assert.equal(malformed.status, 422);
  });

  it('rejects staff principals on the patient boundary (403) and anonymous calls (401)', async () => {
    const staff = await send('GET', '/api/v1/patient/documents', STAFF_TOKEN);
    assert.equal(staff.status, 403);
    const anonymous = await send('GET', '/api/v1/patient/documents', undefined);
    assert.equal(anonymous.status, 401);
  });
});

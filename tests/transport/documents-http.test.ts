/**
 * Document management HTTP contract tests (Step 13).
 *
 * Real `node:http` server over in-memory adapters: upload (JSON + base64
 * content), metadata read, dedicated binary content response — with the
 * mandated error envelope, fail-closed 401, validation 422, missing 404,
 * scope 403 via the forged session, and no storage/infrastructure leakage.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { DocumentService } from '../../src/app/documents/document-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer, CORRELATION_HEADER } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  InMemoryDocumentContentStore,
  InMemoryDocumentMetadataRepository,
} from '../../src/app/in-memory-documents';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { createFixture, sessionFor, OTHER_FACILITY, OTHER_ORG } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly buffer: Buffer;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      options.body !== undefined
        ? { 'content-type': 'application/json', ...options.headers }
        : options.headers,
    body: options.body,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string | string[] | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text: buffer.toString('utf8'), buffer };
}

const PDF_BASE64 = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]).toString(
  'base64',
);
const DOCUMENTS_PATH = '/api/v1/documents';

function uploadBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    documentType: 'REQUISITION',
    displayName: 'req-1.pdf',
    mimeType: 'application/pdf',
    contentBase64: PDF_BASE64,
    ...overrides,
  });
}

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let documents: DocumentService;

before(async () => {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  documents = new DocumentService({
    store: new InMemoryDocumentContentStore(),
    documents: new InMemoryDocumentMetadataRepository(),
    patients: { findById: async () => undefined },
    orders: { findByOrderItemId: async () => undefined },
    facilities,
    audit: fixture.audit,
    idempotency: new InMemoryIdempotencyStore(),
  });
  const active = sessionFor();
  sessionResolver = async () => active;
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { documents } }),
    sessionResolver: (headers: Record<string, string | string[] | undefined>) =>
      sessionResolver(headers),
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

describe('documents http: upload and retrieval', () => {
  it('uploads a document (201) returning a clean DTO', async () => {
    const res = await request('POST', DOCUMENTS_PATH, { body: uploadBody() });
    assert.equal(res.status, 201);
    const body = jsonOf(res.text);
    assert.ok(body.id);
    assert.equal(body.documentType, 'REQUISITION');
    assert.equal(body.mimeType, 'application/pdf');
    assert.equal(body.sizeBytes, 8);
    assert.ok(body.sha256.length === 64);
    assert.ok(!res.text.includes('location'));
    assert.ok(!res.text.includes('storage'));
  });

  it('reads metadata (200) and misses unknown ids (404, no existence leak)', async () => {
    const created = await request('POST', DOCUMENTS_PATH, { body: uploadBody() });
    const id = jsonOf(created.text).id;
    const read = await request('GET', `${DOCUMENTS_PATH}/${id}`);
    assert.equal(read.status, 200);
    assert.equal(jsonOf(read.text).id, id);
    const missing = await request(
      'GET',
      `${DOCUMENTS_PATH}/00000000-0000-4000-8000-0000000000d0`,
    );
    assert.equal(missing.status, 404);
    assert.equal(jsonOf(missing.text).error.code, 'NOT_FOUND');
  });

  it('serves content through the dedicated binary response, not JSON', async () => {
    const created = await request('POST', DOCUMENTS_PATH, { body: uploadBody() });
    const id = jsonOf(created.text).id;
    const res = await request('GET', `${DOCUMENTS_PATH}/${id}/content`);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/pdf');
    assert.ok(String(res.headers['content-disposition']).includes('req-1.pdf'));
    assert.deepEqual([...res.buffer], [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
    assert.equal(res.headers[CORRELATION_HEADER] !== undefined, true);
  });

  it('replays an idempotent upload without creating duplicates', async () => {
    const first = await request('POST', DOCUMENTS_PATH, {
      body: uploadBody({ idempotencyKey: 'http-doc-1' }),
    });
    const second = await request('POST', DOCUMENTS_PATH, {
      body: uploadBody({ idempotencyKey: 'http-doc-1' }),
    });
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
  });
});

describe('documents http: validation and security', () => {
  it('rejects invalid payloads with the existing 422 contract', async () => {
    const badMime = await request('POST', DOCUMENTS_PATH, {
      body: uploadBody({ mimeType: 'application/x-msdownload' }),
    });
    assert.equal(badMime.status, 422);
    const badName = await request('POST', DOCUMENTS_PATH, {
      body: uploadBody({ displayName: '../etc/passwd' }),
    });
    assert.equal(badName.status, 422);
    const badBase64 = await request('POST', DOCUMENTS_PATH, {
      body: uploadBody({ contentBase64: '!!!not-base64!!!' }),
    });
    assert.equal(badBase64.status, 422);
    assert.equal(jsonOf(badBase64.text).error.code, 'VALIDATION_FAILED');
  });

  it('stays fail-closed without a session (401)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    const res = await request('POST', DOCUMENTS_PATH, { body: uploadBody() });
    assert.equal(res.status, 401);
    assert.equal(jsonOf(res.text).error.code, 'UNAUTHENTICATED');
    sessionResolver = previous;
  });

  it('denies a forged cross-facility session (403 scope, no existence leak)', async () => {
    const previous = sessionResolver;
    // FORGED pairing: the facility exists but belongs to a different
    // organization than the session claims (scope comes from the credential
    // binding and is cross-checked against the facility directory — never
    // accepted from the request).
    sessionResolver = async () => sessionFor(OTHER_FACILITY, OTHER_ORG);
    const res = await request('POST', DOCUMENTS_PATH, { body: uploadBody() });
    assert.equal(res.status, 403);
    const body = jsonOf(res.text);
    assert.ok(['FORBIDDEN', 'SCOPE_MISMATCH'].includes(body.error.code));
    sessionResolver = previous;
  });

  it('leaks no storage paths, stacks, or infrastructure details on errors', async () => {
    const res = await request(
      'GET',
      `${DOCUMENTS_PATH}/00000000-0000-4000-8000-0000000000d1/content`,
    );
    assert.equal(res.status, 404);
    const lower = res.text.toLowerCase();
    for (const banned of ['stack', 'documents/', 'select ', 'password', 'bearer']) {
      assert.ok(!lower.includes(banned), `leaked: ${banned}`);
    }
  });
});

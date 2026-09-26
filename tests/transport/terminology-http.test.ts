/**
 * Terminology HTTP contract tests.
 *
 * Real `node:http` server over the application service (in-memory adapters):
 * creation, id-scoped retrieval, canonical resolution — with the mandated
 * error envelope, fail-closed 401, scope 403, validation 422, conflict 409,
 * and leakage assertions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { TerminologyPersistenceService } from '../../src/app/terminology/terminology-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { InMemoryTerminologyMappingRepository } from '../../src/app/in-memory-terminology';
import {
  AuditLogPort,
  InMemoryFacilityDirectory,
  InMemoryIdempotencyStore,
} from '../../src/app/in-memory';
import { InMemoryAuditStore } from '../../src/core/audit/audit';
import { FACILITY, OTHER_FACILITY, ORG, OTHER_ORG, sessionFor } from '../app/helpers';
import type { ApplicationSession } from '../../src/app/context';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;

const MAPPINGS_PATH = '/api/v1/terminology/mappings';
const CREATE = {
  canonicalCode: 'GLUCOSE',
  externalSystem: 'loinc',
  externalCode: '2345-7',
};

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string>; contentType?: string } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': options.contentType ?? 'application/json' }
        : {}),
      ...options.headers,
    },
    body: options.body,
  });
  const text = await response.text();
  const headers: Record<string, string | string[] | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text };
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return request('POST', path, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

let facilities: InMemoryFacilityDirectory;

before(async () => {
  facilities = new InMemoryFacilityDirectory();
  facilities.register({
    id: FACILITY,
    organizationId: ORG,
    name: 'Synthetic Lab Facility',
    code: 'SYN-LAB-1',
    timezone: 'UTC',
  });
  facilities.register({
    id: OTHER_FACILITY,
    organizationId: ORG,
    name: 'Other Facility',
    code: 'SYN-LAB-2',
    timezone: 'UTC',
  });
  const terminology = new TerminologyPersistenceService({
    mappings: new InMemoryTerminologyMappingRepository(),
    facilities,
    audit: new AuditLogPort(new InMemoryAuditStore()),
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const active = sessionFor();
  (active as { roles?: readonly string[] }).roles = ['manager'] as never;
  sessionResolver = async () => active;
  const router = createRouter({ runtime: { terminology } });
  const httpServer = createSdisHttpServer({
    router,
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

describe('terminology http: creation', () => {
  it('creates a mapping with 201 and the contracted DTO shape', async () => {
    const response = await post(MAPPINGS_PATH, CREATE);
    assert.equal(response.status, 201);
    const mapping = jsonOf(response.text);
    assert.deepEqual(Object.keys(mapping).sort(), [
      'canonical',
      'external',
      'facilityId',
      'id',
      'validated',
    ]);
    assert.deepEqual(mapping.canonical, { system: 'sdis', code: 'GLUCOSE' });
    assert.equal(mapping.facilityId, '00000000-0000-4000-8000-000000000011');
  });

  it('401s when no session resolves (fail closed)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post(MAPPINGS_PATH, CREATE);
      assert.equal(response.status, 401);
      assert.equal(jsonOf(response.text).error.code, 'UNAUTHENTICATED');
    } finally {
      sessionResolver = previous;
    }
  });

  it('403s a forged tenant (facility of another organization)', async () => {
    const previous = sessionResolver;
    // A properly-authorized session: the denial must come from the scope
    // check (SCOPE_MISMATCH), proving scope is enforced after authorization.
    const forged = sessionFor(FACILITY, OTHER_ORG) as unknown as ApplicationSession;
    (forged as { roles?: readonly string[] }).roles = ['manager'] as never;
    sessionResolver = async () => forged;
    try {
      const response = await post(MAPPINGS_PATH, CREATE);
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('403s mapping creation to the viewer tier (manager-only terminology.manage)', async () => {
    const previous = sessionResolver;
    const viewer = sessionFor() as unknown as ApplicationSession;
    (viewer as { roles?: readonly string[] }).roles = ['viewer'] as never;
    sessionResolver = async () => viewer;
    try {
      const response = await post(MAPPINGS_PATH, {
        ...CREATE,
        externalCode: 'viewer-denied-1',
      });
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'FORBIDDEN');
    } finally {
      sessionResolver = previous;
    }
  });

  it('409s a duplicate mapping', async () => {
    await post(MAPPINGS_PATH, CREATE);
    const response = await post(MAPPINGS_PATH, CREATE);
    assert.equal(response.status, 409);
    assert.equal(jsonOf(response.text).error.code, 'CONFLICT');
  });

  it('422s unknown external systems and missing fields', async () => {
    for (const bad of [
      { ...CREATE, externalSystem: 'made-up-system' },
      { ...CREATE, canonicalCode: '' },
      { externalSystem: 'loinc' },
    ]) {
      const response = await post(MAPPINGS_PATH, bad);
      assert.equal(response.status, 422);
      assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
    }
  });

  it('TERM-02 regression: a global:true flag from a facility session is rejected (422), not silently dropped', async () => {
    const response = await post(MAPPINGS_PATH, { ...CREATE, global: true });
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('TERM-03 regression: a malformed mapping id in the path is a 422, never an internal error', async () => {
    const response = await request('GET', `${MAPPINGS_PATH}/not-a-uuid`);
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('replays the same Idempotency-Key header to the same mapping', async () => {
    const payload = { ...CREATE, canonicalCode: 'HBA1C', externalCode: '4548-4' };
    const first = await post(MAPPINGS_PATH, payload, {
      'idempotency-key': 'term-http-1',
    });
    assert.equal(first.status, 201);
    const replay = await post(MAPPINGS_PATH, payload, {
      'idempotency-key': 'term-http-1',
    });
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, jsonOf(first.text).id);
  });
});

describe('terminology http: retrieval', () => {
  it('looks up a mapping within scope with 200', async () => {
    const created = await post(MAPPINGS_PATH, {
      ...CREATE,
      canonicalCode: 'CREAT',
      externalCode: '2160-0',
    });
    const id = jsonOf(created.text).id as string;
    const response = await request('GET', `${MAPPINGS_PATH}/${id}`);
    assert.equal(response.status, 200);
    assert.equal(jsonOf(response.text).id, id);
  });

  it('404s unknown mappings with the stable NOT_FOUND code', async () => {
    const response = await request(
      'GET',
      `${MAPPINGS_PATH}/00000000-0000-4000-8000-0000000001ff`,
    );
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });

  it('resolves canonical codes scoped to the session facility', async () => {
    const response = await request('GET', '/api/v1/terminology/resolve/GLUCOSE/loinc');
    assert.equal(response.status, 200);
    const mappings = jsonOf(response.text);
    assert.ok(Array.isArray(mappings));
    for (const mapping of mappings) {
      assert.ok(
        mapping.facilityId === undefined ||
          mapping.facilityId === '00000000-0000-4000-8000-000000000011',
      );
    }
  });

  it('resolves URL-encoded canonical codes (space and reserved char)', async () => {
    const created = await post(MAPPINGS_PATH, {
      canonicalCode: 'GLUCOSE F/B',
      externalSystem: 'local',
      externalCode: 'GB-1',
    });
    assert.equal(created.status, 201);

    const encoded = encodeURIComponent('GLUCOSE F/B');
    const response = await request('GET', `/api/v1/terminology/resolve/${encoded}/local`);
    assert.equal(response.status, 200);
    const mappings = jsonOf(response.text) as Array<{
      canonical: { code: string };
    }>;
    assert.ok(
      mappings.some((mapping) => mapping.canonical.code === 'GLUCOSE F/B'),
      'encoded canonical code resolved after decodeURIComponent',
    );
  });

  it('never leaks internals: no SQL, stacks, or audit fields in responses/errors', async () => {
    const created = await post(MAPPINGS_PATH, {
      ...CREATE,
      canonicalCode: 'URIC',
      externalCode: '3084-1',
    });
    const text = created.text.toLowerCase();
    assert.ok(!text.includes('select '));
    assert.ok(!text.includes('postgres'));
    const failure = await post(MAPPINGS_PATH, { canonicalCode: '' });
    assert.equal(failure.status, 422);
    assert.ok(!failure.text.toLowerCase().includes('stack'));
  });
});

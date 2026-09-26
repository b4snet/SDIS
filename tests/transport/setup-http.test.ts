/**
 * Master setup configuration HTTP contract tests (Step 15).
 *
 * Real `node:http` server over in-memory adapters: create, list, read by
 * family/key, and versioned update — with the mandated error envelope,
 * fail-closed 401, RBAC 403 (operator tier cannot change configuration),
 * forged-scope 403, validation 422, conflict 409, missing 404, and no
 * database/stack/secret leakage.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { SetupConfigService } from '../../src/app/setup/setup-config-service';
import { InMemorySetupConfigRepository } from '../../src/app/in-memory-setup';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import {
  createFixture,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  OTHER_ORG,
} from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';
import { toBrandedId, type DepartmentId } from '../../src/types/ids';

const DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-000000000021');
const OTHER_DEPT: DepartmentId = toBrandedId('00000000-0000-4000-8000-000000000022');

interface Response {
  readonly status: number;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: string,
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body,
  });
  return { status: response.status, text: await response.text() };
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

const CONFIG_PATH = '/api/v1/setup/config';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;

before(async () => {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const repo = new InMemorySetupConfigRepository();
  repo.registerDepartment(DEPT, FACILITY);
  repo.registerDepartment(OTHER_DEPT, FACILITY);
  const setup = new SetupConfigService({
    config: repo,
    facilities,
    audit: fixture.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const active = withRoles(sessionFor(), ['manager']);
  sessionResolver = async () => active;
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { setup } }),
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

function createBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    family: 'FACILITY',
    key: 'worklist.defaultPageSize',
    value: 25,
    effectiveFrom: '2026-09-21T00:00:00.000Z',
    ...overrides,
  });
}

describe('setup http: create, read, and versioned update', () => {
  it('creates a facility setting (201) and reads it back (200)', async () => {
    const created = await request('POST', CONFIG_PATH, createBody());
    assert.equal(created.status, 201);
    const dto = jsonOf(created.text);
    assert.ok(dto.id);
    assert.equal(dto.version, 1);
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.value, 25);
    assert.ok(!created.text.includes('select '));

    const read = await request(
      'GET',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent('worklist.defaultPageSize')}`,
    );
    assert.equal(read.status, 200);
    assert.equal(jsonOf(read.text).version, 1);

    const listed = await request('GET', CONFIG_PATH);
    assert.equal(listed.status, 200);
    assert.equal(jsonOf(listed.text).configs.length, 1);
  });

  it('appends a new version (201) without losing the previous one', async () => {
    const key = 'worklist.versionedPageSize';
    const created = await request('POST', CONFIG_PATH, createBody({ key }));
    assert.equal(created.status, 201);
    const first = jsonOf(created.text);
    const updated = await request(
      'POST',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent(key)}/versions`,
      JSON.stringify({
        value: 50,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        expectedVersion: 1,
      }),
    );
    assert.equal(updated.status, 201);
    const v2 = jsonOf(updated.text);
    assert.equal(v2.version, 2);
    assert.equal(v2.value, 50);

    const history = await request('GET', `${CONFIG_PATH}/versions/${first.id}`);
    assert.equal(history.status, 200);
    assert.equal(jsonOf(history.text).version, 1);
    assert.equal(jsonOf(history.text).value, 25);

    const stale = await request(
      'POST',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent(key)}/versions`,
      JSON.stringify({
        value: 99,
        effectiveFrom: '2026-10-02T00:00:00.000Z',
        expectedVersion: 1,
      }),
    );
    assert.equal(stale.status, 409);
  });

  it('scopes department settings and rejects foreign department references', async () => {
    const created = await request(
      'POST',
      CONFIG_PATH,
      createBody({
        family: 'DEPARTMENT',
        key: 'bench.label',
        value: 'Bench A',
        departmentId: DEPT,
      }),
    );
    assert.equal(created.status, 201);
    assert.equal(jsonOf(created.text).departmentId, DEPT);

    const missing = await request(
      'POST',
      CONFIG_PATH,
      createBody({
        family: 'DEPARTMENT',
        key: 'bench.label2',
        value: 'Bench B',
        departmentId: '00000000-0000-4000-8000-0000000000ff',
      }),
    );
    assert.equal(missing.status, 404);
  });
});

describe('setup http: validation and security', () => {
  it('rejects invalid payloads and unsupported families with 422', async () => {
    const clinicalFamily = await request(
      'POST',
      CONFIG_PATH,
      createBody({ family: 'REFERENCE_RANGE', key: 'clinical.range' }),
    );
    assert.equal(clinicalFamily.status, 422);
    const badKey = await request('POST', CONFIG_PATH, createBody({ key: 'db.password' }));
    assert.equal(badKey.status, 422);
    const badValue = await request('POST', CONFIG_PATH, createBody({ value: null }));
    assert.equal(badValue.status, 422);
    assert.equal(jsonOf(badValue.text).error.code, 'VALIDATION_FAILED');
    const badVersion = await request(
      'POST',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent('worklist.defaultPageSize')}/versions`,
      JSON.stringify({
        value: 1,
        effectiveFrom: '2026-10-01T00:00:00.000Z',
        expectedVersion: 'one',
      }),
    );
    assert.equal(badVersion.status, 422);
    const unsupportedPathFamily = await request('GET', `${CONFIG_PATH}/PRICING/x`);
    assert.equal(unsupportedPathFamily.status, 422);
  });

  it('conflicts (409) on a duplicate configuration', async () => {
    const res = await request('POST', CONFIG_PATH, createBody());
    assert.equal(res.status, 409);
    assert.equal(jsonOf(res.text).error.code, 'CONFLICT');
  });

  it('replays a keyed creation (201, same id)', async () => {
    const body = createBody({ key: 'print.labelFormat', idempotencyKey: 'http-setup-1' });
    const first = await request('POST', CONFIG_PATH, body);
    const second = await request('POST', CONFIG_PATH, body);
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
  });

  it('stays fail-closed without a session (401)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    const res = await request('POST', CONFIG_PATH, createBody({ key: 'a.b' }));
    assert.equal(res.status, 401);
    assert.equal(jsonOf(res.text).error.code, 'UNAUTHENTICATED');
    sessionResolver = previous;
  });

  it('denies the operator tier (403) while allowing reads', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => withRoles(sessionFor(), ['operator']);
    const write = await request('POST', CONFIG_PATH, createBody({ key: 'b.c' }));
    assert.equal(write.status, 403);
    assert.equal(jsonOf(write.text).error.code, 'FORBIDDEN');
    const read = await request('GET', CONFIG_PATH);
    assert.equal(read.status, 200);
    sessionResolver = previous;
  });

  it('denies a forged facility/organization pairing (403)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () =>
      withRoles(sessionFor(OTHER_FACILITY, OTHER_ORG), ['manager']);
    const res = await request('POST', CONFIG_PATH, createBody({ key: 'c.d' }));
    assert.equal(res.status, 403);
    const body = jsonOf(res.text);
    assert.ok(['FORBIDDEN', 'SCOPE_MISMATCH'].includes(body.error.code));
    sessionResolver = previous;
  });

  it('404s an unknown configuration without leaking internals', async () => {
    const res = await request(
      'GET',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent('no.such')}`,
    );
    assert.equal(res.status, 404);
    const lower = res.text.toLowerCase();
    for (const banned of ['stack', 'select ', 'setup_config', 'password', 'bearer']) {
      assert.ok(!lower.includes(banned), `leaked: ${banned}`);
    }
  });
});

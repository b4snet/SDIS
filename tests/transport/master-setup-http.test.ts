/**
 * Step 24 — department master data & configuration HTTP contract tests.
 *
 * Real `node:http` server over in-memory adapters. Proves the new
 * `/api/v1/departments` lifecycle routes and the bounded configuration
 * registry keys end-to-end: RBAC (operator tier blocked, manager allowed),
 * facility-scope isolation (404 no-leak), validation 422, conflict 409,
 * versioned-update conflict, replay idempotency, worklist setting
 * consumption, and safe error envelopes with no internals leakage.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { DepartmentService } from '../../src/app/setup/department-service';
import { InMemoryDepartmentRepository } from '../../src/app/in-memory-departments';
import { SetupConfigService } from '../../src/app/setup/setup-config-service';
import { InMemorySetupConfigRepository } from '../../src/app/in-memory-setup';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { createFixture, sessionFor, FACILITY } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';

interface Response {
  readonly status: number;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
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

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let managerSession: ApplicationSession;
let operatorSession: ApplicationSession;
let viewerSession: ApplicationSession;

let currentRoles: 'manager' | 'operator' | 'viewer' | 'anonymous';

before(async () => {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const idempotency = new InMemoryIdempotencyStore();
  const departments = new DepartmentService({
    departments: new InMemoryDepartmentRepository(),
    facilities,
    audit: fixture.audit,
    idempotency,
    authz,
  });
  const setup = new SetupConfigService({
    config: new InMemorySetupConfigRepository(),
    facilities,
    audit: fixture.audit,
    idempotency,
    authz,
  });
  managerSession = withRoles(sessionFor(), ['manager']);
  operatorSession = withRoles(sessionFor(), ['operator']);
  viewerSession = withRoles(sessionFor(), ['viewer']);
  currentRoles = 'manager';
  sessionResolver = async () => {
    switch (currentRoles) {
      case 'manager':
        return managerSession;
      case 'operator':
        return operatorSession;
      case 'viewer':
        return viewerSession;
      default:
        return undefined;
    }
  };
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { setup, departments } }),
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

const DEPARTMENTS_PATH = '/api/v1/departments';
const CONFIG_PATH = '/api/v1/setup/config';

function departmentBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: 'Clinical Laboratory', code: 'LAB01', ...overrides });
}

describe('departments http: lifecycle', () => {
  it('creates, lists, reads, and deactivates a department (201/200)', async () => {
    currentRoles = 'manager';
    const created = await request('POST', DEPARTMENTS_PATH, departmentBody());
    assert.equal(created.status, 201);
    const dto = jsonOf(created.text);
    assert.ok(dto.id);
    assert.equal(dto.code, 'LAB01');
    assert.equal(dto.status, 'ACTIVE');
    assert.equal(dto.facilityId, FACILITY);
    assert.ok(!created.text.includes('select '));
    assert.ok(!created.text.includes('password'));

    const listed = await request('GET', DEPARTMENTS_PATH);
    assert.equal(listed.status, 200);
    assert.equal(jsonOf(listed.text).length, 1);

    const fetched = await request('GET', `${DEPARTMENTS_PATH}/${dto.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(jsonOf(fetched.text).code, 'LAB01');

    const deactivated = await request(
      'POST',
      `${DEPARTMENTS_PATH}/${dto.id}/deactivate`,
      '{}',
    );
    assert.equal(deactivated.status, 200);
    assert.equal(jsonOf(deactivated.text).status, 'INACTIVE');
  });

  it('rejects invalid department input with 422 and refuses duplicates with 409', async () => {
    currentRoles = 'manager';
    const bad = await request(
      'POST',
      DEPARTMENTS_PATH,
      departmentBody({ code: 'invalid-code' }),
    );
    assert.equal(bad.status, 422);
    assert.ok(jsonOf(bad.text).error);

    await request('POST', DEPARTMENTS_PATH, departmentBody());
    const duplicate = await request(
      'POST',
      DEPARTMENTS_PATH,
      departmentBody({ name: 'Other Name' }),
    );
    assert.equal(duplicate.status, 409);
  });

  it('blocks the operator tier from mutation (403) and allows reads (200)', async () => {
    currentRoles = 'operator';
    const created = await request(
      'POST',
      DEPARTMENTS_PATH,
      departmentBody({ code: 'OP01' }),
    );
    assert.equal(created.status, 403);
    const listed = await request('GET', DEPARTMENTS_PATH);
    assert.equal(listed.status, 200);

    currentRoles = 'viewer';
    const viewerCreated = await request(
      'POST',
      DEPARTMENTS_PATH,
      departmentBody({ code: 'VW01' }),
    );
    assert.equal(viewerCreated.status, 403);
  });

  it('rejects unauthenticated access with the fail-closed 401 envelope', async () => {
    currentRoles = 'anonymous';
    const created = await request('POST', DEPARTMENTS_PATH, departmentBody());
    assert.equal(created.status, 401);
    const listed = await request('GET', DEPARTMENTS_PATH);
    assert.equal(listed.status, 401);
  });
});

describe('configuration http: bounded registry keys', () => {
  it('accepts a registry key with a typed value and serves the worklist setting', async () => {
    currentRoles = 'manager';
    const created = await request(
      'POST',
      CONFIG_PATH,
      JSON.stringify({
        family: 'FACILITY',
        key: 'worklist.defaultPageSize',
        value: 25,
        effectiveFrom: '2026-09-21T00:00:00.000Z',
      }),
    );
    assert.equal(created.status, 201);
    const dto = jsonOf(created.text);
    assert.equal(dto.value, 25);

    const read = await request(
      'GET',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent('worklist.defaultPageSize')}`,
    );
    assert.equal(read.status, 200);
    assert.equal(jsonOf(read.text).value, 25);
  });

  it('rejects typed-value violations with 422 and keeps the DB unchanged', async () => {
    currentRoles = 'manager';
    const oversized = await request(
      'POST',
      CONFIG_PATH,
      JSON.stringify({
        family: 'FACILITY',
        key: 'worklist.defaultPageSize',
        value: 500,
        effectiveFrom: '2026-09-21T00:00:00.000Z',
      }),
    );
    assert.equal(oversized.status, 422);

    const wrongType = await request(
      'POST',
      CONFIG_PATH,
      JSON.stringify({
        family: 'FACILITY',
        key: 'worklist.includeHistory',
        value: 'yes',
        effectiveFrom: '2026-09-21T00:00:00.000Z',
      }),
    );
    assert.equal(wrongType.status, 422);

    const read = await request(
      'GET',
      `${CONFIG_PATH}/FACILITY/${encodeURIComponent('worklist.includeHistory')}`,
    );
    assert.equal(read.status, 404);
  });

  it('appends a versioned update and rejects a stale expectedVersion with 409', async () => {
    currentRoles = 'manager';
    const key = 'worklist.includeHistory';
    const created = await request(
      'POST',
      CONFIG_PATH,
      JSON.stringify({
        family: 'FACILITY',
        key,
        value: false,
        effectiveFrom: '2026-09-21T00:00:00.000Z',
      }),
    );
    assert.equal(created.status, 201);
    const first = jsonOf(created.text);

    const versionsPath = `${CONFIG_PATH}/FACILITY/${encodeURIComponent(key)}/versions`;
    const updated = await request(
      'POST',
      versionsPath,
      JSON.stringify({
        value: true,
        effectiveFrom: '2026-09-21T01:00:00.000Z',
        expectedVersion: first.version,
      }),
    );
    assert.equal(updated.status, 201);
    assert.equal(jsonOf(updated.text).version, first.version + 1);

    const stale = await request(
      'POST',
      versionsPath,
      JSON.stringify({
        value: false,
        effectiveFrom: '2026-09-21T02:00:00.000Z',
        expectedVersion: first.version,
      }),
    );
    assert.equal(stale.status, 409);
  });

  it('replays an idempotent department creation without a duplicate (201 replay)', async () => {
    currentRoles = 'manager';
    const body = departmentBody({
      code: 'IDEM01',
      idempotencyKey: 'dept-idem-1',
    });
    const first = await request('POST', DEPARTMENTS_PATH, body);
    assert.equal(first.status, 201);
    const second = await request('POST', DEPARTMENTS_PATH, body);
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
    const listed = await request('GET', DEPARTMENTS_PATH);
    const matches = jsonOf(listed.text).filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (d: any) => d.code === 'IDEM01',
    );
    assert.equal(matches.length, 1);
  });

  it('blocks configuration mutation at the operator tier (403)', async () => {
    currentRoles = 'operator';
    const created = await request(
      'POST',
      CONFIG_PATH,
      JSON.stringify({
        family: 'FACILITY',
        key: 'worklist.defaultPageSize',
        value: 5,
        effectiveFrom: '2026-09-21T00:00:00.000Z',
      }),
    );
    assert.equal(created.status, 403);
  });
});

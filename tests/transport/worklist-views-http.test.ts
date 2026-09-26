/**
 * Step 29 — worklist views over the REAL HTTP transport.
 *
 * Proves the typed operational views at the boundary: 200 with stable
 * contract bodies for authorized roles, 403 for roles without the view's
 * work permission, 401 unauthenticated, 422 unknown view/limit, server-derived
 * facility scope, and query filters/cursor pass-through.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { ApplicationSession } from '../../src/app/context';
import type { SessionResolver } from '../../src/transport/session';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import { createFixture, sessionFor, T0 } from '../app/helpers';

const at = (n: number) =>
  new Date(Date.parse('2026-03-01T08:00:00Z') + n * 60_000).toISOString();

describe('worklist views over HTTP (Step 29)', () => {
  let fixture: ReturnType<typeof createFixture>;
  let server: Server;
  let baseUrl: string;
  let sessionResolver: SessionResolver;

  before(async () => {
    fixture = createFixture();
    const router = createRouter({ runtime: fixture as never });
    server = createSdisHttpServer({
      router,
      sessionResolver: (headers) => sessionResolver(headers),
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
      server.on('error', reject);
    });
    const operator = sessionFor();
    (operator as { roles?: readonly string[] }).roles = ['operator', 'viewer'] as never;
    sessionResolver = async () => operator;
  });

  after(async () => new Promise<void>((resolve) => server.close(() => resolve())));

  interface Response {
    readonly status: number;
    readonly text: string;
  }
  async function request(
    method: 'GET' | 'POST',
    path: string,
    body?: string,
    as?: ApplicationSession,
  ): Promise<Response> {
    const previous = sessionResolver;
    if (as) sessionResolver = async () => as;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body,
      });
      return { status: res.status, text: await res.text() };
    } finally {
      sessionResolver = previous;
    }
  }

  function operatorSession(): ApplicationSession {
    const operator = sessionFor();
    (operator as { roles?: readonly string[] }).roles = ['operator'] as never;
    return operator;
  }

  function managerSession(): ApplicationSession {
    const manager = sessionFor();
    (manager as { roles?: readonly string[] }).roles = ['manager'] as never;
    return manager;
  }

  /** Creates an order over HTTP at the given lifecycle stage. */
  async function orderOverHttp(
    to: 'ACQUIRED' | 'PROCESSING' | 'RESULT_ENTERED',
    as?: ApplicationSession,
  ): Promise<string> {
    const who = as ?? operatorSession();
    const created = await request(
      'POST',
      '/api/v1/diagnostic-orders',
      JSON.stringify({
        patientId: fixture.patientId,
        encounterId: fixture.encounterId,
        modality: 'LAB',
        items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
        orderedAt: T0,
      }),
      who,
    );
    assert.equal(created.status, 201, created.text);
    const orderId = (JSON.parse(created.text) as { id: string }).id;
    const stages = { ACQUIRED: 1, PROCESSING: 2, RESULT_ENTERED: 3 } as const;
    for (const stage of ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const) {
      if (stages[stage] > stages[to]) break;
      const step = await request(
        'POST',
        `/api/v1/diagnostic-orders/${orderId}/transitions`,
        JSON.stringify({ to: stage, at: at(stages[stage]) }),
        who,
      );
      assert.equal(step.status, 200, step.text);
    }
    return orderId;
  }

  it('serves the collection view with a stable contract body', async () => {
    await orderOverHttp('ACQUIRED', operatorSession());
    const res = await request('GET', '/api/v1/worklists/collection');
    assert.equal(res.status, 200);
    const body = JSON.parse(res.text) as {
      items: { id: string; status: string; priority: string }[];
      nextCursor: string | null;
    };
    assert.ok(Array.isArray(body.items));
    assert.ok(body.items.every((item) => item.status === 'ACQUIRED'));
    assert.equal(body.nextCursor, null);
  });

  it('rejects an unknown view with 422 and a bound-violating limit with 422', async () => {
    const bad = await request('GET', '/api/v1/worklists/nonexistent');
    assert.equal(bad.status, 422);
    const badLimit = await request('GET', '/api/v1/worklists/collection?limit=0');
    assert.equal(badLimit.status, 422);
  });

  it('denies the verification view to operator-tier staff (403) and serves it to managers', async () => {
    const orderId = await orderOverHttp('RESULT_ENTERED', operatorSession());
    const denied = await request('GET', '/api/v1/worklists/verification');
    assert.equal(denied.status, 403);
    const allowed = await request(
      'GET',
      '/api/v1/worklists/verification',
      undefined,
      managerSession(),
    );
    assert.equal(allowed.status, 200);
    const body = JSON.parse(allowed.text) as { items: { id: string }[] };
    assert.ok(body.items.some((item) => item.id === orderId));
  });

  it('requires authentication (401) and never leaks foreign-facility work', async () => {
    // Simulate an unresolved session: the resolver falls back to the default
    // operator, so clear it explicitly for this call via a never-resolving
    // principal (undefined session -> 401 by requireResolvedSession).
    const previous = sessionResolver;
    sessionResolver = async () => undefined as never;
    let unauthorized: Response;
    try {
      unauthorized = await fetch(`${baseUrl}/api/v1/worklists/collection`).then(
        async (res) => ({ status: res.status, text: await res.text() }) as Response,
      );
    } finally {
      sessionResolver = previous;
    }
    assert.equal(unauthorized.status, 401);
    // A foreign-organization session is rejected by scope (403) before any
    // work item can be observed.
    const foreign = sessionFor(
      '00000000-0000-4000-8000-000000000012' as never,
      '00000000-0000-4000-8000-000000000007' as never,
    );
    (foreign as { roles?: readonly string[] }).roles = ['operator'] as never;
    const foreignRes = await request(
      'GET',
      '/api/v1/worklists/collection',
      undefined,
      foreign,
    );
    assert.equal(foreignRes.status, 403);
  });

  it('passes cursor and priority filters through to the application read model', async () => {
    await orderOverHttp('ACQUIRED', operatorSession());
    const page = await request('GET', '/api/v1/worklists/collection?limit=1');
    assert.equal(page.status, 200);
    const body = JSON.parse(page.text) as { items: unknown[]; nextCursor: string | null };
    assert.equal(body.items.length, 1);
    const next = await request(
      'GET',
      `/api/v1/worklists/collection?limit=1&cursor=${encodeURIComponent(body.nextCursor ?? '')}`,
    );
    assert.equal(next.status, 200);
    const emergencies = await request(
      'GET',
      '/api/v1/worklists/collection?priority=EMERGENCY',
    );
    assert.equal(emergencies.status, 200);
    const filtered = JSON.parse(emergencies.text) as { items: { priority: string }[] };
    assert.ok(filtered.items.every((item) => item.priority === 'EMERGENCY'));
  });
});

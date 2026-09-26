/**
 * Observability HTTP contract tests (Step 12).
 *
 * Real `node:http` server with the logger/metrics/readiness options injected:
 * `/healthz` (process-local liveness), `/readyz` (dependency readiness),
 * access-log shape/redaction, metrics series, correlation-ID preservation,
 * and unchanged security semantics (401/403) on authenticated endpoints.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { PatientService } from '../../src/app/patients/patient-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer, CORRELATION_HEADER } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  InMemoryIdempotencyStore,
  InMemoryPatientRegistrationRepository,
} from '../../src/app/in-memory';
import { createFixture, sessionFor } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import { createLogger, type Logger } from '../../src/core/observability/logger';
import {
  createMetricsRegistry,
  type MetricsRegistry,
} from '../../src/core/observability/metrics';

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
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
  const text = await response.text();
  const headers: Record<string, string | string[] | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text };
}

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let lines: string[];
let logger: Logger;
let metrics: MetricsRegistry;
const readinessProbes: Record<string, () => Promise<boolean>> = {};
let patientService: PatientService;

before(async () => {
  const lab = createFixture();
  const repo = new InMemoryPatientRegistrationRepository();
  const facilities = (
    lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  patientService = new PatientService({
    patients: repo,
    facilities,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
  });
  const active = sessionFor();
  sessionResolver = async () => active;

  lines = [];
  logger = createLogger({ write: (l: string) => lines.push(l) });
  metrics = createMetricsRegistry();
  readinessProbes.postgres = async () => true;

  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { patients: patientService } }),
    sessionResolver: (headers: Record<string, string | string[] | undefined>) =>
      sessionResolver(headers),
    logger,
    metrics,
    readinessProbes,
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

describe('observability http: health endpoints', () => {
  it('GET /healthz proves process liveness without touching dependencies', async () => {
    readinessProbes.postgres = async () => {
      throw new Error('must not be called');
    };
    const res = await request('GET', '/healthz');
    assert.equal(res.status, 200);
    const body = jsonOf(res.text);
    assert.deepEqual(body, { status: 'ok' });
  });

  it('GET /readyz reports ok with all dependencies ready', async () => {
    readinessProbes.postgres = async () => true;
    const res = await request('GET', '/readyz');
    assert.equal(res.status, 200);
    assert.deepEqual(jsonOf(res.text), {
      status: 'ok',
      dependencies: { postgres: 'ok' },
    });
  });

  it('GET /readyz reports 503 with status only when a dependency is down', async () => {
    readinessProbes.postgres = async () => {
      throw new Error('ECONNREFUSED 10.0.0.5:5432 secret=swordfish');
    };
    const res = await request('GET', '/readyz');
    assert.equal(res.status, 503);
    const text = res.text;
    assert.ok(text.includes('"unavailable"'));
    assert.ok(!text.includes('ECONNREFUSED'));
    assert.ok(!text.includes('swordfish'));
    readinessProbes.postgres = async () => true;
  });

  it('health endpoints are outside /api/v1 and never hit the session resolver', async () => {
    sessionResolver = async () => {
      throw new Error('health endpoints must not require authentication');
    };
    const livenessRes = await request('GET', '/healthz');
    assert.equal(livenessRes.status, 200);
    const readyRes = await request('GET', '/readyz');
    assert.equal(readyRes.status, 200);
    sessionResolver = async () => activeSession();
  });
});

function activeSession(): ReturnType<typeof sessionFor> {
  return sessionFor();
}

describe('observability http: correlation and access logs', () => {
  it('a supplied correlation ID is preserved and echoed on responses', async () => {
    const res = await request(
      'GET',
      '/api/v1/patients/00000000-0000-4000-8000-0000000000ff',
      {
        headers: { [CORRELATION_HEADER]: 'corr-abc-123' },
      },
    );
    assert.equal(res.headers[CORRELATION_HEADER], 'corr-abc-123');
  });

  it('a missing correlation ID receives a minted one', async () => {
    const res = await request(
      'GET',
      '/api/v1/patients/00000000-0000-4000-8000-0000000000fe',
    );
    const minted = res.headers[CORRELATION_HEADER];
    assert.ok(typeof minted === 'string' && minted.length >= 32);
  });

  it('every request completion produces one structured access-log line', async () => {
    lines.length = 0;
    await request('POST', '/api/v1/patients', {
      body: JSON.stringify({ fullName: 'Access Log Patient', sex: 'F' }),
    });
    assert.ok(lines.length >= 1);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const access = parsed.find((p) => p.route === '/api/v1/patients');
    assert.ok(access);
    assert.equal(access.message, 'request completed');
    assert.equal(access.status, 201);
    assert.equal(typeof access.durationMs, 'number');
    assert.equal(typeof access.correlationId, 'string');
    assert.ok(!JSON.stringify(parsed).includes('Access Log Patient'));
  });

  it('error responses log the error code without stack traces or credentials', async () => {
    lines.length = 0;
    await request('GET', '/api/v1/patients/00000000-0000-4000-8000-0000000000fd');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const access = parsed.find((p) => p.route === '/api/v1/patients');
    assert.ok(access);
    assert.equal(access.status, 404);
    assert.ok(!JSON.stringify(parsed).includes('stack'));
    assert.ok(!JSON.stringify(parsed).includes('authorization'));
  });
});

describe('observability http: metrics series', () => {
  it('counts requests by method and status class', async () => {
    const before2xx = metrics.snapshot()['sdis_http_requests_total|POST|2xx'] ?? 0;
    await request('POST', '/api/v1/patients', {
      body: JSON.stringify({ fullName: 'Metrics Patient', sex: 'M' }),
    });
    const snap = metrics.snapshot();
    assert.equal(snap['sdis_http_requests_total|POST|2xx'], before2xx + 1);
  });

  it('buckets request durations', async () => {
    lines.length = 0;
    await request('GET', '/healthz');
    const snap = metrics.snapshot();
    const durationSeries = Object.keys(snap).filter((k) =>
      k.startsWith('sdis_http_request_duration_seconds_bucket|GET|'),
    );
    assert.ok(durationSeries.length >= 1);
  });
});

describe('observability http: security semantics unchanged', () => {
  it('authenticated endpoints keep their exact behavior (201 on register)', async () => {
    const res = await request('POST', '/api/v1/patients', {
      body: JSON.stringify({
        fullName: 'Still Works',
        sex: 'F',
        birthDate: '1991-02-02',
      }),
    });
    assert.equal(res.status, 201);
    const body = jsonOf(res.text);
    assert.ok(typeof body.id === 'string');
    assert.ok(!('organizationId' in body));
  });

  it('fail-closed session resolution still yields the existing 401 envelope', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    const res = await request('POST', '/api/v1/patients', {
      body: JSON.stringify({ fullName: 'No Session', sex: 'M' }),
    });
    assert.equal(res.status, 401);
    const body = jsonOf(res.text);
    assert.equal(body.error.code, 'UNAUTHENTICATED');
    sessionResolver = previous;
  });

  it('no SQL, stack, credential, or clinical content appears in health bodies', async () => {
    const res = await request('GET', '/readyz');
    const text = res.text.toLowerCase();
    for (const banned of ['select ', 'stack', 'password', 'bearer', 'token']) {
      assert.ok(!text.includes(banned), `leaked: ${banned}`);
    }
  });
});

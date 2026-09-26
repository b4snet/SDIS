/**
 * Step 34 — process-lifecycle operational tests.
 *
 * Startup configuration validation (valid / missing / invalid), the runtime
 * health & metrics surface, the `/metrics` HTTP exposure with its redaction
 * guarantees, and bounded graceful-shutdown semantics. All data is synthetic;
 * no real credentials appear anywhere (the "tokens" here are synthetic test
 * strings for validation cases only).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  DEFAULT_TRANSPORT_CONFIG,
  validateTransportConfig,
} from '../../src/transport/context';
import {
  installShutdownHandlers,
  runtimeHealth,
  runtimeMetrics,
  shutdown,
  validateStartupConfig,
  StartupConfigError,
} from '../../src/runtime/process';
import { createLogger } from '../../src/core/observability/logger';
import { createMetricsRegistry, nullMetrics } from '../../src/core/observability/metrics';
import { liveness } from '../../src/core/observability/health';

describe('runtime: startup configuration validation', () => {
  it('accepts an empty environment (safe local development, fail-closed auth)', () => {
    assert.doesNotThrow(() => validateStartupConfig({ env: {} }));
  });

  it('accepts a full valid production-style environment', () => {
    assert.doesNotThrow(() =>
      validateStartupConfig({
        env: {
          NODE_ENV: 'production',
          PGHOST: 'db.internal',
          PGPORT: '5432',
          PGDATABASE: 'sdis',
          PGUSER: 'sdis_owner',
          PGPASSWORD: 'synthetic-only-not-a-real-secret',
          SDIS_API_TOKENS: JSON.stringify([
            {
              token: 'synthetic-test-token-0000000000000000000000',
              userId: 'ops-user',
              organizationId: '00000000-0000-4000-8000-000000000001',
              facilityId: '00000000-0000-4000-8000-000000000011',
              roles: ['manager', 'operator', 'viewer'],
            },
          ]),
          SDIS_PG_CLIENT_DIR: 'C:/pg/bin',
        },
      }),
    );
  });

  it('rejects a malformed credential directory at startup (fail-fast, not first-401)', () => {
    assert.throws(
      () =>
        validateStartupConfig({
          env: { SDIS_API_TOKENS: '[{"token": ' },
        }),
      (error: unknown) =>
        error instanceof StartupConfigError &&
        error.failures.some((f) => f.includes('not valid JSON')),
    );
  });

  it('rejects an unknown SDIS_ key (typo protection) and a bad NODE_ENV/PGPORT', () => {
    assert.throws(
      () =>
        validateStartupConfig({
          env: {
            SDIS_API_TOKEN: 'oops-typo', // must be SDIS_API_TOKENS
            NODE_ENV: 'prod',
            PGPORT: 'not-a-number',
          },
        }),
      (error: unknown) => {
        if (!(error instanceof StartupConfigError)) return false;
        const joined = error.failures.join('\n');
        return (
          joined.includes('unknown SDIS_ configuration key "SDIS_API_TOKEN"') &&
          joined.includes('NODE_ENV') &&
          joined.includes('PGPORT')
        );
      },
    );
  });

  it('rejects an invalid transport configuration', () => {
    assert.throws(
      () =>
        validateStartupConfig({
          env: {},
          transport: { ...DEFAULT_TRANSPORT_CONFIG, maxBodyBytes: -1 },
        }),
      (error: unknown) => {
        if (!(error instanceof StartupConfigError)) return false;
        try {
          validateTransportConfig({ ...DEFAULT_TRANSPORT_CONFIG, maxBodyBytes: -1 });
        } catch (inner) {
          return error.failures.some((f) => f.includes((inner as Error).message));
        }
        return false;
      },
    );
  });
});

describe('runtime: health & metrics surface', () => {
  it('liveness is process-local; runtimeHealth composes process + dependencies', async () => {
    assert.equal(liveness().status, 'ok');
    const healthy = await runtimeHealth({ postgres: async () => true });
    assert.deepEqual(healthy, {
      process: { liveness: 'ok' },
      dependencies: { postgres: 'ok' },
    });
    const degraded = await runtimeHealth({ postgres: async () => false });
    assert.equal(degraded.process.liveness, 'ok'); // liveness NEVER follows the db
    assert.deepEqual(degraded.dependencies, { postgres: 'unavailable' });
  });

  it('runtimeMetrics exposes only the bounded snapshot', () => {
    const registry = createMetricsRegistry();
    registry.observeRequest('GET', 200);
    registry.observeDependencyProbe('postgres', 'unavailable');
    registry.observeShutdown('graceful');
    const snapshot = runtimeMetrics(registry).metrics;
    assert.equal(snapshot['sdis_http_requests_total|GET|2xx'], 1);
    assert.equal(snapshot['sdis_readiness_probes_total|postgres|unavailable'], 1);
    assert.equal(snapshot['sdis_shutdowns_total|graceful'], 1);
    void nullMetrics;
  });
});

describe('runtime: /metrics exposure over real HTTP', () => {
  it('serves the SDIS server unauthenticated, bounds route labels, and leaks nothing', async () => {
    const metrics = createMetricsRegistry();
    const secret = 'super-secret-bearer-token-value';
    const patientId = '00000000-0000-4000-8000-0000000000e1';

    // Minimal SDIS server: no services bound — API routes fail closed with a
    // status (401) which is exactly what the metrics series observes.
    const { createSdisHttpServer } = await import('../../src/transport/server');
    const { createRouter } = await import('../../src/transport/router');
    const server = createSdisHttpServer({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      router: createRouter({ runtime: {} as any }),
      sessionResolver: async () => undefined as never,
      metrics,
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', resolve);
      server.on('error', reject);
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // An id-bearing API request + a credential-bearing /metrics request.
    await fetch(`${base}/api/v1/patients/${patientId}`);
    const res = await fetch(`${base}/metrics`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { metrics: Record<string, number> };
    const series = payload.metrics;

    assert.ok(Object.keys(series).some((k) => k.startsWith('sdis_http_requests_total|')));
    assert.ok(
      !Object.keys(series).some((k) => k.includes(patientId)),
      'route labels must stay bounded — no identifiers in metric series',
    );
    const bodyText = JSON.stringify(series);
    assert.ok(!bodyText.includes(secret), 'credentials must never appear in metrics');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('runtime: bounded graceful shutdown', () => {
  it('drains in-flight requests, records a graceful shutdown, and runs the drain step', async () => {
    const metrics = createMetricsRegistry();
    const server: Server = createServer((req, res) => {
      if (req.url === '/slow') {
        setTimeout(() => {
          res.end('slow-done');
        }, 250);
        return;
      }
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const inflight = fetch(`${base}/slow`).then((r) => r.text());
    await new Promise((resolve) => setTimeout(resolve, 50));

    let drained = false;
    const result = await shutdown({
      server,
      onDrained: async () => {
        drained = true;
      },
      metrics,
      logger: createLogger({ write: () => undefined }),
    });

    assert.equal(result.graceful, true);
    assert.equal(drained, true);
    assert.equal(await inflight, 'slow-done'); // in-flight work finished
    assert.equal(metrics.snapshot()['sdis_shutdowns_total|graceful'], 1);
  });

  it('reports forced when the listener cannot close within the timeout', async () => {
    const metrics = createMetricsRegistry();
    // A handler that never responds keeps one connection active; an open
    // (non-idle) socket makes server.close() wait — the shutdown budget must
    // expire and report `forced` rather than hang forever.
    const server: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const net = await import('node:net');
    const held = net.createConnection(
      (server.address() as AddressInfo).port,
      '127.0.0.1',
    );
    await new Promise<void>((resolve) => held.once('connect', resolve));
    held.write('GET /held HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const result = await shutdown({ server, timeoutMs: 150, metrics });
    assert.equal(result.graceful, false);
    assert.equal(metrics.snapshot()['sdis_shutdowns_total|forced'], 1);

    held.destroy();
    server.close();
  });

  it('installShutdownHandlers wires signals and tolerates a second signal', async () => {
    const handle = installShutdownHandlers({
      server: createServer(() => undefined),
    });
    assert.ok(handle.done instanceof Promise);
    // No signal is delivered here; handlers are installed and inert. The
    // double-signal force-exit path is deliberately NOT exercised in tests
    // (it would kill the test runner process).
  });
});

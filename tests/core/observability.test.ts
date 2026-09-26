/**
 * Unit tests for the Step-12 observability core: structured logging (shape,
 * redaction, level filtering), metrics (bounded series, status classes,
 * duration buckets), and health probes (liveness, readiness failure modes).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, nullLogger, redact } from '../../src/core/observability/logger';
import {
  createMetricsRegistry,
  nullMetrics,
  statusClass,
} from '../../src/core/observability/metrics';
import { liveness, readiness } from '../../src/core/observability/health';

describe('observability: structured logging', () => {
  it('emits single-line JSON with timestamp, level, message, and safe fields', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l: string) => lines.push(l) });
    logger.info(
      { correlationId: 'c-1', route: '/api/v1/patients', method: 'POST', status: 201 },
      'request completed',
    );
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(parsed.level, 'info');
    assert.equal(parsed.message, 'request completed');
    assert.equal(typeof parsed.ts, 'string');
    assert.equal(parsed.correlationId, 'c-1');
    assert.equal(parsed.status, 201);
  });

  it('drops credential-bearing keys entirely', () => {
    const safe = redact({
      authorization: 'Bearer super-secret-token',
      token: 'abc',
      password: 'hunter2',
      correlationId: 'c-2',
    });
    assert.deepEqual(safe, { correlationId: 'c-2' });
    assert.ok(!JSON.stringify(safe).includes('super-secret-token'));
  });

  it('drops unknown and clinical-looking keys (allowlist, not denylist)', () => {
    const safe = redact({
      fullName: 'Jane Doe',
      observationValue: '7.2 mmol/L',
      reportText: 'impressive findings',
      birthDate: '1990-01-01',
      correlationId: 'c-3',
      resourceId: '00000000-0000-4000-8000-000000000001',
    });
    assert.deepEqual(safe, {
      correlationId: 'c-3',
      resourceId: '00000000-0000-4000-8000-000000000001',
    });
  });

  it('respects the minimum level (debug suppressed at info)', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l: string) => lines.push(l), level: 'info' });
    logger.debug({ correlationId: 'c-4' }, 'noisy detail');
    logger.error({ correlationId: 'c-5' }, 'real problem');
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes('"error"'));
  });

  it('nullLogger swallows everything', () => {
    assert.doesNotThrow(() => {
      nullLogger.debug({ correlationId: 'x' }, 'a');
      nullLogger.error({ correlationId: 'x' }, 'b');
    });
  });

  it('caps the free-text message at 200 characters (OBS-01)', () => {
    const lines: string[] = [];
    const logger = createLogger({ write: (l: string) => lines.push(l) });
    logger.error({ correlationId: 'c-6' }, `x`.repeat(500));
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal((parsed.message as string).length, 200);
  });
});

describe('observability: metrics', () => {
  it('classifies status codes into bounded classes', () => {
    assert.equal(statusClass(200), '2xx');
    assert.equal(statusClass(201), '2xx');
    assert.equal(statusClass(401), '4xx');
    assert.equal(statusClass(403), '4xx');
    assert.equal(statusClass(500), '5xx');
    assert.equal(statusClass(503), '5xx');
  });

  it('counts requests by method and status class', () => {
    const m = createMetricsRegistry();
    m.observeRequest('POST', 201);
    m.observeRequest('POST', 403);
    m.observeRequest('POST', 422);
    m.observeRequest('GET', 200);
    const snap = m.snapshot();
    assert.equal(snap['sdis_http_requests_total|POST|2xx'], 1);
    assert.equal(snap['sdis_http_requests_total|POST|4xx'], 2);
    assert.equal(snap['sdis_http_requests_total|GET|2xx'], 1);
  });

  it('buckets durations coarsely and counts the request', () => {
    const m = createMetricsRegistry();
    m.observeRequestDuration('POST', 201, 42);
    m.observeRequestDuration('POST', 201, 4200);
    const snap = m.snapshot();
    assert.equal(snap['sdis_http_request_duration_seconds_bucket|POST|<=50'], 1);
    assert.equal(snap['sdis_http_request_duration_seconds_bucket|POST|<=5000'], 1);
    assert.equal(snap['sdis_http_requests_total|POST|2xx'], 2);
  });

  it('accepts only known operations (bounded vocabulary)', () => {
    const m = createMetricsRegistry();
    m.observeOperation('order.create', 'success');
    m.observeOperation('made.up.thing', 'success'); // ignored
    const snap = m.snapshot();
    assert.equal(snap['sdis_operation_total|order.create|success'], 1);
    assert.equal(Object.keys(snap).length, 1);
  });

  it('counts dependency failures and nullMetrics stays silent but snapshot-able', () => {
    const m = createMetricsRegistry();
    m.observeDependencyFailure('postgres');
    m.observeDependencyFailure('postgres');
    assert.equal(m.snapshot()['sdis_dependency_failures_total|postgres'], 2);
    const n = nullMetrics();
    n.observeRequest('GET', 200);
    n.observeDependencyFailure('postgres');
    assert.deepEqual(n.snapshot(), {});
  });
});

describe('observability: health probes', () => {
  it('liveness is process-local and always ok', async () => {
    const result = liveness();
    assert.deepEqual(result, { status: 'ok' });
  });

  it('readiness reports ok when all dependencies pass', async () => {
    const result = await readiness({ postgres: async () => true });
    assert.deepEqual(result, { status: 'ok', dependencies: { postgres: 'ok' } });
  });

  it('readiness maps a failing dependency to unavailable without leaking errors', async () => {
    const result = await readiness({
      postgres: async () => {
        throw new Error('ECONNREFUSED 10.0.0.5:5432 with password hunter2');
      },
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.dependencies.postgres, 'unavailable');
    assert.ok(!JSON.stringify(result).includes('ECONNREFUSED'));
    assert.ok(!JSON.stringify(result).includes('hunter2'));
  });

  it('readiness maps a false probe to unavailable and times out hung probes', async () => {
    const falseResult = await readiness({ postgres: async () => false });
    assert.equal(falseResult.dependencies.postgres, 'unavailable');
    const hungResult = await readiness({
      postgres: () => new Promise<boolean>(() => undefined), // never settles
    });
    assert.equal(hungResult.status, 'unavailable');
  });

  it('readiness with no probes registered is trivially ready', async () => {
    const result = await readiness({});
    assert.equal(result.status, 'ok');
  });
});

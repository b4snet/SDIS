/**
 * SDIS HTTP transport — `node:http` server.
 *
 * Hosts the route table over the mandated transport behaviors
 * (docs/API_CONTRACTS.md §3/§4):
 *
 * - correlation IDs minted/reused at the edge, echoed on every response;
 * - strict JSON content-type handling (`application/json; charset=utf-8`);
 * - request-body size limits (413 above the configured maximum);
 * - malformed-JSON → 400, unsupported media type → 415;
 * - unknown/undhandled routes → 404 in the mandated error shape;
 * - error serialization exclusively through the public error mapping
 *   (`transport/errors.ts`) — no stack traces, SQL, paths, or credentials.
 *
 * The server never encodes domain semantics and never touches PostgreSQL.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import {
  DEFAULT_TRANSPORT_CONFIG,
  correlationIdFor,
  validateTransportConfig,
  type TransportConfig,
} from './context';
import { serializeError, TransportFailure } from './errors';
import type { Router } from './router';
import { sessionResolverForEnvironment } from './auth';
import type { SessionResolver } from './session';
import type { TenantScopeRunner } from './request-scope';
import type { Json } from './validate';
import type { Logger } from '../core/observability/logger';
import { nullLogger } from '../core/observability/logger';
import type { HttpMethod, MetricsRegistry } from '../core/observability/metrics';
import { nullMetrics } from '../core/observability/metrics';
import { liveness, readiness } from '../core/observability/health';
import type { DependencyProbe } from '../core/observability/health';

export const CORRELATION_HEADER = 'x-correlation-id';

export interface SdisHttpServerOptions {
  readonly router: Router;
  readonly sessionResolver?: SessionResolver;
  readonly config?: TransportConfig;
  /** Structured logger; defaults to a silent one (instrumentation is opt-in). */
  readonly logger?: Logger;
  /** Metrics registry; defaults to a silent one (instrumentation is opt-in). */
  readonly metrics?: MetricsRegistry;
  /** Dependency probes for readiness (e.g. `postgres`); injected at the edge. */
  readonly readinessProbes?: Record<string, DependencyProbe>;
  /**
   * Carries the resolved session's tenant/facility scope across the async
   * request boundary so infrastructure (e.g. PostgreSQL RLS) can stamp each
   * statement. Transport owns the SEAM, never the persistence mechanism:
   * the PostgreSQL implementation (`runWithTenantScope`) is injected at the
   * composition edge (`src/index.ts`). Default: pass-through (no scoping) —
   * used by in-memory test servers and by deployments without RLS.
   */
  readonly requestScopeRunner?: TenantScopeRunner;
}

export function createSdisHttpServer(options: SdisHttpServerOptions): Server {
  const config = options.config ?? DEFAULT_TRANSPORT_CONFIG;
  validateTransportConfig(config);
  // AUTH-02: when SDIS_API_TOKENS is set, the server authenticates bearer
  // credentials against it (startup-validated, fail-fast on malformed input).
  // Otherwise the shipped default stays fail-closed (always 401). An explicit
  // injected resolver (tests, future identity providers) always wins.
  const resolveSession =
    options.sessionResolver ?? sessionResolverForEnvironment(process.env);
  const route = options.router;
  const logger = options.logger ?? nullLogger;
  const metrics = options.metrics ?? nullMetrics();
  const readinessProbes = options.readinessProbes ?? {};
  const requestScopeRunner = options.requestScopeRunner ?? passThroughScope;

  return createServer((request, response) => {
    void handle(request, response, {
      route,
      resolveSession,
      config,
      logger,
      metrics,
      readinessProbes,
      requestScopeRunner,
    });
  });
}

interface HandleArgs {
  readonly route: Router;
  readonly resolveSession: SessionResolver;
  readonly config: TransportConfig;
  readonly logger: Logger;
  readonly metrics: MetricsRegistry;
  readonly readinessProbes: Record<string, DependencyProbe>;
  readonly requestScopeRunner: TenantScopeRunner;
}

/** Default request-scope behavior: run the route with no scope attached. */
const passThroughScope: TenantScopeRunner = async (_scope, fn) => fn();

async function handle(
  request: IncomingMessage,
  response: import('node:http').ServerResponse,
  args: HandleArgs,
): Promise<void> {
  const startedAt = Date.now();
  const correlationId = correlationIdFor(headerValue(request, 'x-correlation-id'));
  response.setHeader(CORRELATION_HEADER, correlationId);
  const url = request.url ?? '/';
  try {
    if (request.method !== 'GET' && request.method !== 'POST') {
      throw new TransportFailure(405, 'Method not allowed', [], 'VALIDATION_FAILED');
    }

    // ---- Operational health endpoints (Step 12; docs/DEPLOYMENT.md) -------
    // Root-scoped (outside /api/v1): they are infrastructure probes, not API
    // resources. Liveness never touches a dependency; readiness uses only the
    // injected probes. Both respond with the existing JSON envelope style and
    // echo the correlation ID. Readiness outcomes feed the bounded
    // `sdis_readiness_probes_total` series (Step 34) — the alertable
    // dependency-down signal that does not wait for a request to fail.
    if (url === '/healthz' || url === '/readyz') {
      if (url === '/healthz') {
        const body = liveness();
        respond(response, 200, body, correlationId);
        observeCompletion(args, request, response, url, correlationId, startedAt, 200);
        return;
      }
      const body = await readiness(args.readinessProbes);
      const status = body.status === 'ok' ? 200 : 503;
      for (const [dependency, outcome] of Object.entries(body.dependencies)) {
        if (dependency === 'postgres' || dependency === 'storage') {
          args.metrics.observeDependencyProbe(
            dependency as 'postgres' | 'storage',
            outcome,
          );
        }
      }
      respond(response, status, body, correlationId);
      observeCompletion(args, request, response, url, correlationId, startedAt, status);
      return;
    }

    // ---- Metrics snapshot (Step 34) ------------------------------------------
    // Unauthenticated BY DESIGN: it carries bounded counters only — no
    // patient data, no credentials, no free text. Series labels come from
    // bounded vocabularies (route skeletons, status classes, duration
    // buckets), so exposure leaks nothing sensitive. Gated by the transport
    // configuration (`exposeMetrics`, default on).
    if (url === '/metrics' && args.config.exposeMetrics !== false) {
      respond(response, 200, { metrics: args.metrics.snapshot() }, correlationId);
      observeCompletion(args, request, response, url, correlationId, startedAt, 200);
      return;
    }

    const body = await readBody(request, config_limit(args.config));

    const contentType = headerValue(request, 'content-type');
    if (body !== undefined && !isJsonContentType(contentType)) {
      throw new TransportFailure(
        415,
        'Content-Type must be application/json',
        [],
        'VALIDATION_FAILED',
      );
    }

    let parsed: Json | undefined;
    if (body !== undefined) {
      try {
        parsed = JSON.parse(body.toString('utf8')) as Json;
      } catch {
        throw new TransportFailure(
          400,
          'Request body is not valid JSON',
          [],
          'VALIDATION_FAILED',
        );
      }
    }

    const session = await args.resolveSession(request.headers);
    const route = () =>
      args.route(request.method === 'GET' ? 'GET' : 'POST', url, parsed, session, {
        headers: request.headers,
      });
    // RLS-01 wiring: every authenticated request executes its database work
    // under the application role with the session's tenant GUCs (fail-closed
    // migration 014). The transport supplies session context through the
    // INJECTED scope runner; the PostgreSQL mechanism lives at the edge.
    const handled = session
      ? await args.requestScopeRunner(
          {
            organizationId: session.organizationId,
            facilityId: session.facilityId,
            ...(session.userId ? { userId: session.userId } : {}),
          },
          route,
        )
      : await route();

    if (!handled) {
      throw new TransportFailure(404, 'Resource not found', [], 'NOT_FOUND');
    }
    if (handled.content) {
      // Raw content response (document bytes): served with its own MIME type,
      // never JSON-wrapped, never logged. Safe headers only.
      respondContent(response, handled.status, handled.content, correlationId);
    } else {
      respond(response, handled.status, handled.body, correlationId);
    }
    observeCompletion(
      args,
      request,
      response,
      url,
      correlationId,
      startedAt,
      handled.status,
    );
  } catch (error) {
    const { status, body, wwwAuthenticate } = serializeError(error, correlationId);
    respond(response, status, body, correlationId, wwwAuthenticate);
    observeCompletion(
      args,
      request,
      response,
      url,
      correlationId,
      startedAt,
      status,
      error,
    );
  }
}

/**
 * One access-log line + one metrics observation per request completion.
 * Carries only safe fields (route, method, status, duration, correlation id,
 * error code) — never bodies, credentials, or clinical content.
 */
function observeCompletion(
  args: HandleArgs,
  request: IncomingMessage,
  response: import('node:http').ServerResponse,
  url: string,
  correlationId: string,
  startedAt: number,
  status: number,
  error?: unknown,
): void {
  const durationMs = Date.now() - startedAt;
  const method = (request.method === 'GET' ? 'GET' : 'POST') as HttpMethod;
  args.metrics.observeRequestDuration(method, status, durationMs);
  const route = routeLabel(url);
  const errorCode =
    error !== null && typeof error === 'object' && 'code' in error
      ? String((error as { code: unknown }).code)
      : undefined;
  if (status >= 500) {
    args.logger.error(
      {
        correlationId,
        route,
        method,
        status,
        durationMs,
        outcome: 'error',
        ...(errorCode ? { errorCode } : {}),
      },
      'request completed',
    );
  } else {
    args.logger.info(
      {
        correlationId,
        route,
        method,
        status,
        durationMs,
        outcome: status < 400 ? 'success' : 'rejected',
      },
      'request completed',
    );
  }
}

/**
 * Bounded route label: the fixed path skeleton (resource head + sub-resource
 * action), never resource ids — e.g. `/api/v1/patients`,
 * `/api/v1/patients/external-identifiers`, `/healthz`. Metric/log series stay
 * low-cardinality and identifier-free.
 */
function routeLabel(url: string): string {
  const segments = url.split('?')[0]?.split('/').filter(Boolean) ?? [];
  if (segments[0] === 'healthz' || segments[0] === 'readyz' || segments[0] === 'metrics')
    return `/${segments[0]}`;
  if (segments[0] === 'api' && segments[1] === 'v1') {
    const head = segments[2] ?? '';
    const action = segments[4] ?? ''; // after a resource-id segment
    return '/api/v1/' + head + (action ? '/' + action : '');
  }
  return '/' + segments.slice(0, 2).join('/');
}

function config_limit(config: TransportConfig): number {
  return config.maxBodyBytes;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

function readBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;

    request.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        request.removeAllListeners('data');
        reject(
          new TransportFailure(
            413,
            'Request body exceeds the allowed size',
            [],
            'VALIDATION_FAILED',
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (done) return;
      done = true;
      resolve(chunks.length === 0 ? undefined : Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

/**
 * Raw content response (document bytes, Step 13): own MIME type, safe
 * attachment header with the validated display name, correlation ID echo,
 * and byte length. No storage refs, no infrastructure detail.
 */
function respondContent(
  response: import('node:http').ServerResponse,
  status: number,
  content: {
    readonly bytes: Uint8Array;
    readonly mimeType: string;
    readonly downloadName: string;
  },
  correlationId: string,
): void {
  response.statusCode = status;
  response.setHeader('content-type', content.mimeType);
  response.setHeader(
    'content-disposition',
    `attachment; filename="${content.downloadName.replace(/["\\\r\n]/g, '')}"`,
  );
  response.setHeader('content-length', String(content.bytes.byteLength));
  response.setHeader(CORRELATION_HEADER, correlationId);
  response.end(Buffer.from(content.bytes));
}

function respond(
  response: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  correlationId: string,
  wwwAuthenticate?: string,
): void {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  // SEC-HEADERS: response bodies are JSON (or declared document MIME types);
  // instruct clients never to sniff a different type.
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader(CORRELATION_HEADER, correlationId);
  if (wwwAuthenticate !== undefined) {
    // SEC-AUTH-04: RFC 6750 §3 challenge on bearer-authentication 401s —
    // the scheme only, no scope/realm detail.
    response.setHeader('www-authenticate', wwwAuthenticate);
  }
  response.end(payload);
}

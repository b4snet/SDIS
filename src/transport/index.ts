/**
 * SDIS HTTP transport boundary — public surface.
 *
 * The transport is an outer ring: HTTP → DTO mapping → application services →
 * domain → infrastructure. It exists to expose the repository-supported
 * laboratory operations over HTTP without duplicating any domain, scope,
 * idempotency, audit, or persistence logic (docs/API_CONTRACTS.md §8).
 * The barrel stays infrastructure-free: cross-layer composition helpers
 * (e.g. the PostgreSQL readiness probe, the RLS scope runner) are exported
 * from the composition edge (`src/index.ts`) instead.
 */

export {
  ApiErrorBody,
  SerializedApiError,
  TransportFailure,
  serializeError,
} from './errors';
export {
  DEFAULT_TRANSPORT_CONFIG,
  correlationIdFor,
  validateTransportConfig,
  type TransportConfig,
} from './context';
export {
  unauthenticatedSessionResolver,
  requireResolvedSession,
  type SessionResolver,
} from './session';
export { createRouter, type Router, type TransportRuntime } from './router';
export { createSdisHttpServer, CORRELATION_HEADER } from './server';
export type { TenantScopeRunner } from './request-scope';
export {
  createLogger,
  nullLogger,
  redact,
  type Logger,
  type LogFields,
  type LogLevel,
} from '../core/observability/logger';
export {
  createMetricsRegistry,
  nullMetrics,
  statusClass,
  type MetricsRegistry,
  type HttpMethod,
} from '../core/observability/metrics';
export {
  liveness,
  readiness,
  type DependencyProbe,
  type LivenessResult,
  type ReadinessResult,
} from '../core/observability/health';

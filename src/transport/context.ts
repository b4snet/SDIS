/**
 * SDIS HTTP transport — request context.
 *
 * Correlation IDs are generated at the edge (`docs/API_CONTRACTS.md` §4) and
 * propagated to every response header and every error body. An inbound
 * `X-Correlation-Id` is reused only when it is a safe token (bounded length,
 * printable, no control characters); it is never trusted as authorization.
 *
 * Transport configuration is explicit and validated at construction (fail-fast,
 * `docs/DEPLOYMENT.md` §3).
 */

import { randomUUID } from 'node:crypto';

const MAX_CORRELATION_ID_LENGTH = 128;
const SAFE_TOKEN = /^[\x21-\x7E]{1,128}$/;

/** Reuses a safe inbound correlation token; otherwise mints a fresh UUID. */
export function correlationIdFor(inbound: string | undefined): string {
  if (
    inbound &&
    SAFE_TOKEN.test(inbound) &&
    inbound.length <= MAX_CORRELATION_ID_LENGTH
  ) {
    return inbound;
  }
  return randomUUID();
}

export interface TransportConfig {
  /** Request-body size limit in bytes (413 above this). */
  readonly maxBodyBytes: number;
  /**
   * Whether the bounded `/metrics` snapshot endpoint is exposed (Step 34).
   * Default `true`: the endpoint carries bounded counters only (no
   * identifiers, credentials, or free text). Set `false` when a deployment
   * terminates metrics collection elsewhere.
   */
  readonly exposeMetrics?: boolean;
}

export const DEFAULT_TRANSPORT_CONFIG: TransportConfig = {
  maxBodyBytes: 64 * 1024,
  exposeMetrics: true,
};

function assertPositive(value: number, label: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Transport configuration error: ${label} must be a positive integer`);
  }
}

/** Fail-fast configuration validation (docs/DEPLOYMENT.md §3). */
export function validateTransportConfig(config: TransportConfig): void {
  assertPositive(config.maxBodyBytes, 'maxBodyBytes');
  if (config.exposeMetrics !== undefined && typeof config.exposeMetrics !== 'boolean') {
    throw new Error('Transport configuration error: exposeMetrics must be a boolean');
  }
}

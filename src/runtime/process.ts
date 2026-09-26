/**
 * SDIS process lifecycle (Step 34).
 *
 * Operational runtime concerns that the transport deliberately does not own:
 *
 * - **Startup validation** — the process refuses to serve traffic on
 *   misconfiguration. Validation is fail-fast and happens BEFORE the server
 *   binds: environment keys are checked against the known contract
 *   (typo-protection for the `SDIS_` namespace), the auth credential
 *   environment is parsed exactly as the server will parse it, and
 *   NODE_ENV is a known value. Safe local development is unchanged — an
 *   empty/default environment validates fine and the shipped defaults stay
 *   fail-closed (401) rather than insecurely permissive.
 * - **Runtime health/metrics surface** — one function per operational
 *   question, composed from the existing `core/observability` ports
 *   (liveness, readiness probes, the bounded metrics registry). No new
 *   monitoring system is introduced; the HTTP exposure of these snapshots is
 *   the existing server's `/healthz`, `/readyz`, `/metrics`.
 * - **Graceful shutdown** — SIGTERM/SIGINT stop the listener, let in-flight
 *   requests finish (idle keep-alive sockets are closed), and bound the wait:
 *   a wedged shutdown is reported as `forced` and the process exits non-zero
 *   instead of hanging forever. Closing the database pool is the caller's
 *   `onDrained` step, so this module stays infrastructure-free.
 *
 * The environment is always an INJECTED parameter — this module never reads
 * the ambient process environment, keeping the Step-26 environment-access
 * allowlist intact (no new reader of ambient configuration is introduced).
 */

import type { Server } from 'node:http';
import { validateTransportConfig, type TransportConfig } from '../transport/context';
import { parseApiTokensEnv } from '../transport/auth';
import { liveness, readiness } from '../core/observability/health';
import type { DependencyProbe } from '../core/observability/health';
import type { MetricsRegistry } from '../core/observability/metrics';
import type { Logger } from '../core/observability/logger';

// ---------------------------------------------------------------------------
// Startup configuration validation
// ---------------------------------------------------------------------------

/** Inputs for startup validation (environment is injected, never read here). */
export interface SdisProcessConfig {
  /** The process environment (test-injectable). */
  readonly env: NodeJS.ProcessEnv;
  /** Transport configuration to validate (defaults apply when absent). */
  readonly transport?: TransportConfig;
}

/** Raised when configuration is invalid — the process must not bind. */
export class StartupConfigError extends Error {
  constructor(readonly failures: readonly string[]) {
    super(`SDIS configuration is invalid: ${failures.join('; ')}`);
    this.name = 'StartupConfigError';
  }
}

/** The known `SDIS_`-namespace environment contract. Unknown `SDIS_*` keys are
 * a startup FAILURE — a typo like `SDIS_API_TOKEN` must never silently
 * disable authentication while the operator believes it is configured.
 */
const KNOWN_SDIS_KEYS: ReadonlySet<string> = new Set([
  'SDIS_API_TOKENS', // credential directory (AUTH-02) — optional; absent = fail-closed 401s
  'SDIS_PG_CLIENT_DIR', // pg client tools dir for backup/restore tooling
]);

/**
 * Validates the process configuration. Throws `StartupConfigError` listing
 * every failure (fail-fast, all at once). Absent optional configuration is
 * valid: local development keeps working, and an unconfigured credential
 * directory stays fail-closed (every request 401) rather than insecure.
 */
export function validateStartupConfig(config: SdisProcessConfig): void {
  const env = config.env;
  const failures: string[] = [];

  const nodeEnv = env['NODE_ENV'];
  if (
    nodeEnv !== undefined &&
    nodeEnv !== 'production' &&
    nodeEnv !== 'development' &&
    nodeEnv !== 'test'
  ) {
    failures.push(`NODE_ENV "${nodeEnv}" is not one of production|development|test`);
  }

  // The auth environment contract, parsed exactly as the server will parse
  // it — a malformed credential directory fails startup, not the first 401.
  const tokens = env['SDIS_API_TOKENS'];
  if (tokens !== undefined) {
    try {
      parseApiTokensEnv(tokens);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  const pgPort = env['PGPORT'];
  if (pgPort !== undefined && !/^\d+$/.test(pgPort)) {
    failures.push('PGPORT must be an integer');
  }

  const clientDir = env['SDIS_PG_CLIENT_DIR'];
  if (clientDir !== undefined && clientDir.trim() === '') {
    failures.push('SDIS_PG_CLIENT_DIR must not be empty');
  }

  for (const key of Object.keys(env)) {
    if (key.startsWith('SDIS_') && !KNOWN_SDIS_KEYS.has(key)) {
      failures.push(
        `unknown SDIS_ configuration key "${key}" (typo? known keys: ${[...KNOWN_SDIS_KEYS].join(', ')})`,
      );
    }
  }

  if (config.transport) {
    try {
      validateTransportConfig(config.transport);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (failures.length > 0) throw new StartupConfigError(failures);
}

// ---------------------------------------------------------------------------
// Runtime health / metrics surface
// ---------------------------------------------------------------------------

/** The process-level health answer (mirrors `/healthz`). */
export interface RuntimeHealthSnapshot {
  readonly process: { readonly liveness: 'ok' };
  /** Per-dependency readiness (mirrors `/readyz`, bounded names only). */
  readonly dependencies: Record<string, 'ok' | 'unavailable'>;
}

/** Liveness + dependency readiness in one diagnostic snapshot. */
export async function runtimeHealth(
  probes: Record<string, DependencyProbe>,
): Promise<RuntimeHealthSnapshot> {
  const dependencies = (await readiness(probes)).dependencies;
  return { process: { liveness: liveness().status }, dependencies };
}

/** The bounded metrics snapshot as exposed at `/metrics`. */
export function runtimeMetrics(registry: MetricsRegistry): {
  metrics: Record<string, number>;
} {
  return { metrics: registry.snapshot() };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export interface ShutdownOptions {
  /** The HTTP server to stop accepting new requests on. */
  readonly server: Server;
  /** How long in-flight work may take before the shutdown is judged wedged. */
  readonly timeoutMs?: number;
  /**
   * Drain step run after the listener closed (e.g. closing the database
   * pool). Awaited within the shutdown budget.
   */
  readonly onDrained?: () => Promise<void> | void;
  readonly logger?: Logger;
  readonly metrics?: MetricsRegistry;
}

export interface ShutdownResult {
  /** True when in-flight work finished within the timeout. */
  readonly graceful: boolean;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Bounded graceful shutdown: stop the listener, close idle keep-alive
 * sockets, let active requests finish, run the drain step, and observe the
 * outcome (`sdis_shutdowns_total|graceful|forced`). Never waits forever.
 */
export async function shutdown(options: ShutdownOptions): Promise<ShutdownResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const server = options.server;

  const graceful = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    server.closeIdleConnections?.();
    server.close((error) => {
      clearTimeout(timer);
      if (error !== undefined && error !== null) {
        options.logger?.warn(
          { reason: String(error.message ?? error) },
          'shutdown: listener close reported an error',
        );
      }
      resolve(true);
    });
  });

  if (!graceful) {
    options.metrics?.observeShutdown('forced');
    options.logger?.error(
      { reason: `in-flight work did not finish within ${timeoutMs}ms` },
      'shutdown: forced (timeout exceeded)',
    );
    return { graceful: false };
  }

  try {
    await options.onDrained?.();
  } catch (error) {
    options.logger?.error(
      { reason: String(error instanceof Error ? error.message : error) },
      'shutdown: drain step failed after listener closed',
    );
    options.metrics?.observeShutdown('forced');
    return { graceful: false };
  }

  options.metrics?.observeShutdown('graceful');
  options.logger?.info({}, 'shutdown: graceful');
  return { graceful: true };
}

export interface ShutdownHandlerHandle {
  /** Resolves when the first triggered shutdown completes. */
  done: Promise<ShutdownResult>;
}

/**
 * Wires SIGTERM/SIGINT to `shutdown`. A repeated signal force-exits (1) —
 * an operator must always be able to stop a wedged process. The forced
 * timeout path exits non-zero as well; neither path runs in tests (tests
 * call `shutdown` directly).
 */
export function installShutdownHandlers(options: ShutdownOptions): ShutdownHandlerHandle {
  const logger = options.logger;
  let triggered = false;
  const handle: ShutdownHandlerHandle = { done: Promise.resolve({ graceful: true }) };

  const initiate = (signal: 'SIGTERM' | 'SIGINT'): void => {
    if (triggered) {
      // Second signal: the operator wants OUT — never trap it.
      process.exit(1);
    }
    triggered = true;
    logger?.info({ reason: signal }, 'shutdown: signal received');
    handle.done = shutdown(options);
    void handle.done.then((result) => {
      if (!result.graceful) {
        // Wedged past the timeout: exit non-zero so the orchestrator sees it.
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => initiate('SIGTERM'));
  process.on('SIGINT', () => initiate('SIGINT'));
  return handle;
}

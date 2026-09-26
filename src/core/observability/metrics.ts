/**
 * SDIS runtime metrics.
 *
 * A provider-neutral, bounded, in-process counter registry measuring
 * OPERATIONAL behavior only: request counts by outcome class, request
 * durations (coarse buckets), and application/dependency failure counts.
 * Labels come from bounded vocabularies (method, status class, operation,
 * outcome, dependency) — never identifiers or free text — so both cardinality
 * and content are controlled. Clinical values and patient data have no
 * representation here at all.
 *
 * No exporter is implied: snapshots are plain objects any adapter can expose.
 * Unbounded label growth is prevented by validating against bounded
 * vocabularies before a series is created.
 */

/** HTTP method vocabulary (the transport serves GET/POST only). */
export type HttpMethod = 'GET' | 'POST';

/** Classifies a status code into a bounded series label. */
export function statusClass(status: number): '2xx' | '4xx' | '5xx' | 'other' {
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500 && status < 600) return '5xx';
  return 'other';
}

/** Coarse duration buckets (milliseconds) — cheap, enough for operations. */
export const DURATION_BUCKETS_MS: readonly number[] = [
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000,
];

/** Bounded outcome vocabulary for application operations. */
export type OperationOutcome = 'success' | 'failure';

/** Bounded dependency vocabulary for readiness/failure metrics. */
export type DependencyName = 'postgres' | 'storage';

export type ReadinessOutcome = 'ok' | 'unavailable';

export interface MetricsRegistry {
  /** Counts one HTTP request completion by method/status class. */
  observeRequest(method: HttpMethod, status: number): void;
  /** Records one HTTP request duration (and counts it) by method/class. */
  observeRequestDuration(method: HttpMethod, status: number, durationMs: number): void;
  /** Counts one application operation outcome. */
  observeOperation(operation: string, outcome: OperationOutcome): void;
  /** Counts one dependency failure (e.g. pool/connect errors). */
  observeDependencyFailure(dependency: DependencyName): void;
  /**
   * Counts one readiness-probe completion per dependency/outcome — the
   * alertable signal behind `/readyz` (Step 34): a sustained
   * `unavailable` series means the dependency is down without any request
   * having to fail first.
   */
  observeDependencyProbe(dependency: DependencyName, outcome: ReadinessOutcome): void;
  /** Counts one process-lifecycle event by outcome. */
  observeShutdown(outcome: 'graceful' | 'forced'): void;
  /** Plain-object snapshot (no exporter implied). */
  snapshot(): Record<string, number>;
}

const KNOWN_OPERATIONS = new Set([
  'http',
  'order.create',
  'specimen.create',
  'observation.create',
  'interpretation.create',
  'report.finalize',
  'patient.register',
  'patient.attach-identifier',
  'terminology.create-mapping',
  'billing.create-charge',
  'device.ingest',
]);

function key(parts: readonly (string | number)[]): string {
  return parts.join('|');
}

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, number>();

  const increment = (series: string, by = 1): void => {
    counters.set(series, (counters.get(series) ?? 0) + by);
  };

  const bucketFor = (durationMs: number): string => {
    for (const bound of DURATION_BUCKETS_MS) {
      if (durationMs <= bound) return `<=${bound}`;
    }
    return '+Inf';
  };

  return {
    observeRequest(method, status) {
      increment(key(['sdis_http_requests_total', method, statusClass(status)]));
    },

    observeRequestDuration(method, status, durationMs) {
      increment(key(['sdis_http_requests_total', method, statusClass(status)]));
      increment(
        key(['sdis_http_request_duration_seconds_bucket', method, bucketFor(durationMs)]),
      );
    },

    observeOperation(operation, outcome) {
      if (!KNOWN_OPERATIONS.has(operation)) return; // bounded vocabulary
      increment(key(['sdis_operation_total', operation, outcome]));
    },

    observeDependencyFailure(dependency) {
      increment(key(['sdis_dependency_failures_total', dependency]));
    },

    observeDependencyProbe(dependency, outcome) {
      increment(key(['sdis_readiness_probes_total', dependency, outcome]));
    },

    observeShutdown(outcome) {
      increment(key(['sdis_shutdowns_total', outcome]));
    },

    snapshot() {
      const out: Record<string, number> = {};
      for (const [series, value] of counters) out[series] = value;
      return out;
    },
  };
}

/** An empty registry (used where instrumentation is off). */
export function nullMetrics(): MetricsRegistry {
  const registry = createMetricsRegistry();
  return {
    observeRequest: () => undefined,
    observeRequestDuration: () => undefined,
    observeOperation: () => undefined,
    observeDependencyFailure: () => undefined,
    observeDependencyProbe: () => undefined,
    observeShutdown: () => undefined,
    snapshot: registry.snapshot,
  };
}

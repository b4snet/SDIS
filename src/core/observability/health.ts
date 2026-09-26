/**
 * SDIS health probes.
 *
 * Two distinct operational questions, kept separate:
 *
 * - **Liveness** — "is this process alive?" Answered from the process itself;
 *   NEVER queries a dependency (a hung database must not crash-loop a healthy
 *   process out of an orchestrator).
 * - **Readiness** — "can this process serve requests now?" Answers from an
 *   injected dependency probe (the existing `Database` abstraction). A probe
 *   failure is reported as `not ready` — never as a raw SQL error, and never
 *   with credentials or stack traces.
 *
 * The dependency probe is injected as a port (`DependencyProbe`), so this
 * module stays provider-neutral and the transport never imports
 * infrastructure directly.
 */

/** A dependency health check injected at the composition edge. */
export type DependencyProbe = () => Promise<boolean>;

/** Result of the liveness probe (process-local only). */
export interface LivenessResult {
  readonly status: 'ok';
}

/** Result of the readiness probe over injected dependencies. */
export interface ReadinessResult {
  readonly status: 'ok' | 'unavailable';
  /** Per-dependency status; only the bounded dependency names appear. */
  readonly dependencies: Record<string, 'ok' | 'unavailable'>;
}

/** How long a single dependency probe may run before being judged down. */
const PROBE_TIMEOUT_MS = 2000;

/**
 * Liveness: always `ok` when this code executes. No I/O, no arguments, no
 * dependency access — proving the event loop runs is the whole answer.
 */
export function liveness(): LivenessResult {
  return { status: 'ok' };
}

/**
 * Readiness: runs every registered dependency probe with a hard timeout and
 * maps any failure (false, throw, or timeout) to `unavailable` for that
 * dependency. Errors are swallowed into the status — never serialized.
 */
export async function readiness(
  probes: Record<string, DependencyProbe>,
): Promise<ReadinessResult> {
  const dependencies: Record<string, 'ok' | 'unavailable'> = {};
  for (const [name, probe] of Object.entries(probes)) {
    let ok = false;
    try {
      ok = await withTimeout(probe(), PROBE_TIMEOUT_MS);
    } catch {
      ok = false;
    }
    dependencies[name] = ok ? 'ok' : 'unavailable';
  }
  const status = Object.values(dependencies).every((v) => v === 'ok')
    ? 'ok'
    : 'unavailable';
  return { status, dependencies };
}

function withTimeout(promise: Promise<boolean>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value === true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

/** True when every named dependency reported ok (computed once, cached). */
export function isReady(result: ReadinessResult): boolean {
  return result.status === 'ok';
}

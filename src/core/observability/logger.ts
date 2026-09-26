/**
 * SDIS structured logging.
 *
 * A provider-neutral, dependency-free logger emitting single-line JSON
 * (ingestible by any collector). Operationally scoped: it carries
 * correlation/route/duration/outcome metadata and only ever SAFE identifiers
 * (uuid-shaped resource ids, session facility/organization scope). It never
 * carries clinical content or credentials — see `redact`.
 *
 * PHI/secret policy (`docs/SECURITY.md`, Step-12 boundary):
 * `redact` drops or masks anything that is not explicitly safe. Known
 * credential-bearing keys and free-text fields are removed; unknown keys are
 * dropped rather than trusted. Nothing in this module serializes raw request
 * or response bodies.
 *
 * Caller contract (OBS-01): the free-text `message` is emitted verbatim
 * (capped at 200 characters) and does NOT pass through `redact` — callers
 * must never place clinical content, credentials, or secrets in it. Pass
 * identifiers as safe fields instead.
 */

/** Severity levels in increasing order of seriousness. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/** Keys whose values are authentication material and must never be logged. */
const CREDENTIAL_KEYS = new Set([
  'authorization',
  'password',
  'token',
  'bearer',
  'credential',
  'credentials',
  'secret',
  'apiKey',
  'cookie',
  'set-cookie',
]);

/**
 * Keys that are explicitly safe to log. Anything else — including patient
 * names, contact details, observation values, or report text — is dropped.
 */
const SAFE_KEYS = new Set([
  'correlationId',
  'route',
  'method',
  'status',
  'outcome',
  'durationMs',
  'operation',
  'errorCode',
  'organizationId',
  'facilityId',
  'actorKind',
  'actorRef',
  'resourceKind',
  'resourceId',
  'dependency',
  'attempt',
  'reason',
]);

/** One structured log line's safe field set. */
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields, message?: string): void;
  info(fields: LogFields, message?: string): void;
  warn(fields: LogFields, message?: string): void;
  error(fields: LogFields, message?: string): void;
}

/** Redacts to the safe allowlist; masks free-text `reason`/`message`. */
export function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (CREDENTIAL_KEYS.has(key)) continue;
    if (!SAFE_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    safe[key] =
      key === 'reason' || key === 'message' ? String(value).slice(0, 200) : value;
  }
  return safe;
}

export interface LoggerOptions {
  /** Minimum severity to emit (default `info`). */
  readonly level?: LogLevel;
  /** Sink; defaults to `process.stdout` (one JSON object per line). */
  readonly write?: (line: string) => void;
  /** Fixed clock for deterministic tests. */
  readonly now?: () => number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const min = LEVEL_WEIGHT[options.level ?? 'info'];
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(line + '\n');
    });
  const now = options.now ?? (() => Date.now());

  const emit = (level: LogLevel, fields: LogFields, message?: string): void => {
    if (LEVEL_WEIGHT[level] < min) return;
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      level,
      message: (message ?? '').slice(0, 200),
      ...redact(fields),
    });
    write(line);
  };

  return {
    debug: (fields, message) => emit('debug', fields, message),
    info: (fields, message) => emit('info', fields, message),
    warn: (fields, message) => emit('warn', fields, message),
    error: (fields, message) => emit('error', fields, message),
  };
}

/** A logger that discards everything (used where instrumentation is off). */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

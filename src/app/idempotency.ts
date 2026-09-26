/**
 * SDIS idempotency plumbing for the application boundary.
 *
 * Semantics follow the established Step-1 charge-ledger contract
 * (`src/domain/billing/billing.ts`): replaying the same logical request returns
 * the SAME logical result and creates no duplicate state. The operation name is
 * part of the key so distinct operations never collide.
 *
 * Audit emission happens inside `create` — a replay therefore never re-emits
 * audit events. The async form guarantees audit writes complete before the
 * result is observable.
 */

import { createHash } from 'node:crypto';

import type { IdempotencyStore } from './ports';
import type { ApplicationSession } from './context';
import { AppError, ValidationError } from './errors';

export const IDEMPOTENCY_SCOPES = {
  ORDER_CREATE: 'order.create',
  /** Workflow-priority change (Step 21) — operational, not clinical. */
  ORDER_PRIORITY_CHANGE: 'order.priority.change',
  SPECIMEN_COLLECT: 'specimen.collect',
  OBSERVATION_CREATE: 'observation.create',
  INTERPRETATION_CREATE: 'interpretation.create',
  REPORT_CREATE: 'report.create',
  REPORT_FINALIZE: 'report.finalize',
  REPORT_AMEND: 'report.amend',
  PATIENT_CREATE: 'patient.create',
  PATIENT_IDENTIFIER_ATTACH: 'patient.identifier.attach',
  TERMINOLOGY_MAPPING_CREATE: 'terminology.mapping.create',
  CHARGE_CREATE: 'charge.create',
  DEVICE_INGEST: 'device.ingest',
  DOCUMENT_CREATE: 'document.create',
  /** Access-removal lifecycle transition (Step 23) — never physical deletion. */
  DOCUMENT_RETIRE: 'document.retire',
  INVENTORY_RECEIVE: 'inventory.receive',
  INVENTORY_ISSUE: 'inventory.issue',
  /** Step 31 — controlled lot lifecycle transitions (quarantine/release/retire). */
  INVENTORY_LOT_STATUS: 'inventory.lot.status',
  /** Step 31 — item active/inactive lifecycle. */
  INVENTORY_ITEM_STATUS: 'inventory.item.status',
  SETUP_CONFIG_CREATE: 'setup.config.create',
  /** Step 27 — quality records / hold release (laboratory QC boundary). */
  QUALITY_RECORD: 'quality.record',
  QUALITY_RELEASE: 'quality.release',
  SETUP_CONFIG_UPDATE: 'setup.config.update',
  INTEGRATION_REQUEST: 'integration.request',
} as const;

export type IdempotencyScope =
  (typeof IDEMPOTENCY_SCOPES)[keyof typeof IDEMPOTENCY_SCOPES];

export function idempotencyKey(scope: IdempotencyScope, key: string): string {
  return `${scope}:${key}`;
}

/**
 * INT-33 §10: same-key/different-payload protection.
 *
 * An idempotency key that arrives with a DIFFERENT logical payload than the
 * recorded one is rejected instead of being silently served the original
 * result. The detection is a deterministic fingerprint: a stable (key-order
 * independent) JSON serialization of the REQUEST SHAPE, hashed with SHA-256
 * — raw payloads are never stored. The error reuses the established
 * IDEMPOTENCY_CONFLICT code; the message distinguishes the case.
 */
export class RequestFingerprintMismatchError extends AppError {
  constructor() {
    super(
      'IDEMPOTENCY_CONFLICT',
      'Idempotency key was already used with a different request payload',
    );
    this.name = 'RequestFingerprintMismatchError';
  }
}

/** Key-order-independent, deterministic serialization (no undefined noise). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

/** SHA-256 commitment of the request shape — the payload itself is NOT stored. */
export function requestFingerprintOf(request: unknown): string {
  return createHash('sha256').update(stableStringify(request), 'utf8').digest('hex');
}

/** Fingerprint accompanies the record under a derived key (hex digest only, never the payload). */
function fingerprintRecordKey(fullKey: string): string {
  // Suffix namespace: a client key ending in ':fp' can alias another client's
  // fingerprint record only WITHIN its own scope+facility (same trust domain);
  // the worst case is a spurious conflict, never cross-scope read or plant.
  return `${fullKey}:fp`;
}

export interface RunIdempotentOptions {
  /**
   * Request shape (plain JSON-serializable input object). When provided with
   * a session, a same-key retry carrying a different payload is rejected
   * (IDEMPOTENCY_PAYLOAD_MISMATCH) instead of memoized as the original.
   */
  readonly requestFingerprint?: unknown;
}

/**
 * SEC-32: idempotency records are themselves securely scoped. The session's
 * facility is part of the record identity, so the same client key presented
 * under different facilities (or tenants) can never collide — one principal's
 * replay neither reads nor plants another principal's memoized result:
 *
 *   facility A + key X  ≠  facility B + key X
 *
 * The facility is a property of the SERVER-DERIVED session scope (never a
 * request field), so callers cannot choose it; the guard keeps scope-less
 * callers from weakening the namespace.
 */
export function scopedIdempotencyKey(
  scope: IdempotencyScope,
  session: ApplicationSession,
  key: string,
): string {
  const facilityId = session.facilityId;
  if (typeof facilityId !== 'string' || facilityId.length === 0) {
    throw new ValidationError('Idempotency requires a server-derived facility scope');
  }
  return `${scope}:${facilityId}:${key}`;
}

/**
 * Executes `create` at most once per (scope, key). Callers pass the same key on
 * retry; the stored result is returned and no side effect repeats.
 *
 * IDEM-01: when the store implements `withExclusive` (cross-process single
 * flight on PG, in-process chaining in-memory), the whole get→create→put unit
 * runs under the key's exclusive slot, so two racing callers across processes
 * both receive the same result and only one `create` executes.
 *
 * SEC-32: when a session is supplied, the key is composed with its
 * server-derived facility scope (`scopedIdempotencyKey`) — idempotent replay
 * is never shared across facilities/tenants. Callers inside a session MUST
 * pass it; keyless callers keep the legacy global namespace (documented
 * internal use, e.g. derived-step retries within one operation).
 */
export async function runIdempotent<T>(
  store: IdempotencyStore,
  scope: IdempotencyScope,
  key: string | undefined,
  create: () => Promise<T>,
  session?: ApplicationSession,
  options?: RunIdempotentOptions,
): Promise<T> {
  if (!key) return create();
  const fullKey =
    session !== undefined
      ? scopedIdempotencyKey(scope, session, key)
      : idempotencyKey(scope, key);
  // INT-33 §10: only fingerprint client-keyed operations with a session —
  // internal keys have no meaningful stable request shape.
  const fingerprint =
    options?.requestFingerprint !== undefined && session !== undefined
      ? requestFingerprintOf(options.requestFingerprint)
      : undefined;
  const fpKey = fingerprint !== undefined ? fingerprintRecordKey(fullKey) : undefined;
  const assertCompatible = async (): Promise<void> => {
    if (fpKey === undefined) return;
    const stored = await store.get<string>(fpKey);
    // Records without a fingerprint (Step-33 predecessors, internal keys)
    // keep the legacy replay semantics — only a KNOWN different payload
    // conflicts.
    if (stored !== undefined && stored !== fingerprint) {
      throw new RequestFingerprintMismatchError();
    }
  };
  const lookup = async (): Promise<T | undefined> => {
    const existing = await store.get<T>(fullKey);
    if (existing === undefined) return undefined;
    await assertCompatible();
    return existing;
  };
  const run = async (): Promise<T> => {
    const existing = await lookup();
    if (existing !== undefined) return existing;
    const value = await create();
    await store.put<T>(fullKey, value);
    if (fpKey !== undefined && fingerprint !== undefined) {
      await store.put<string>(fpKey, fingerprint);
    }
    return value;
  };
  if (store.withExclusive) {
    // Settled replays are fingerprint-checked by the pre-check below; the
    // POST-check covers the racing case: the store's single-flight may serve
    // this caller a result created by a DIFFERENT payload that won the slot
    // (the store's internal pre-get returns the hit without invoking the
    // callback). The winner's side effects stand; the loser receives the
    // conflict — exactly one authoritative operation commits (§11).
    if (fpKey !== undefined) await assertCompatible();
    const value = await store.withExclusive<T>(fullKey, run);
    if (fpKey !== undefined) await assertCompatible();
    return value;
  }
  return run();
}

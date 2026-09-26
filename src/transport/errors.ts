/**
 * SDIS HTTP transport — error mapping.
 *
 * Maps the PUBLIC application error taxonomy (`src/app/errors.ts`, aligned with
 * `docs/API_CONTRACTS.md` §3) onto HTTP responses. Every error response uses
 * the mandated shape:
 *
 *   { "error": { "code", "message", "correlationId", "details" } }
 *
 * Non-`AppError` failures collapse to 500 INTERNAL with a generic message:
 * stack traces, SQL, filesystem paths, connection details, and credentials are
 * never serialized. Transport-level rejections reuse the stable contract codes
 * with the precise HTTP status (400/413/415/404/401).
 */

import { AppError, type AppErrorCode } from '../app/errors';

/** HTTP status for each application error code (docs/API_CONTRACTS.md §3/§4). */
const HTTP_STATUS_BY_CODE: Readonly<Record<AppErrorCode, number>> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  SCOPE_MISMATCH: 403,
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  INVALID_STATE_TRANSITION: 409,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INTERNAL: 500,
};

/** The mandated wire shape of every error response. */
export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly details: readonly string[];
  };
}

export interface SerializedApiError {
  readonly status: number;
  readonly body: ApiErrorBody;
}

/**
 * Transport-level rejection with an explicit HTTP status and the contract's
 * stable error code. Used only for transport concerns (shape, encoding, size,
 * media type, unknown route, unauthenticated); domain and application
 * semantics remain exclusively below the transport layer.
 */
export class TransportFailure extends Error {
  readonly status: number;
  readonly details: readonly string[];
  readonly code: AppErrorCode;

  constructor(
    status: number,
    message: string,
    details: readonly string[] = [],
    code: AppErrorCode = 'VALIDATION_FAILED',
  ) {
    super(message);
    this.name = 'TransportFailure';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/**
 * Maps any thrown value to a safe (status, body) pair. Never leaks internals.
 *
 * SEC-AUTH-04: an unauthenticated (401) response also carries
 * `WWW-Authenticate: Bearer` — the single scheme this foundation actually
 * consumes — so clients can discover the challenge per RFC 6750 §3. No other
 * status carries the header, and the challenge claims no scope/Realm detail.
 */
export function serializeError(
  error: unknown,
  correlationId: string,
): SerializedApiError & { readonly wwwAuthenticate?: string } {
  if (error instanceof AppError) {
    const status = HTTP_STATUS_BY_CODE[error.code];
    return {
      status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          correlationId,
          details: [...error.details],
        },
      },
      ...(status === 401 ? { wwwAuthenticate: 'Bearer' } : {}),
    };
  }
  if (error instanceof TransportFailure) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          correlationId,
          details: [...error.details],
        },
      },
      ...(error.status === 401 ? { wwwAuthenticate: 'Bearer' } : {}),
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL',
        message: 'Internal application error',
        correlationId,
        details: [],
      },
    },
  };
}

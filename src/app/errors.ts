/**
 * SDIS application-layer error taxonomy.
 *
 * This is the PUBLIC error contract of the application boundary (aligned with
 * `docs/API_CONTRACTS.md` §3). Services raise typed, code-carrying errors and
 * never leak stack traces, SQL, secrets, filesystem paths, or raw PHI.
 */

export type AppErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'SCOPE_MISMATCH'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'INVALID_STATE_TRANSITION'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly details: readonly string[];

  constructor(code: AppErrorCode, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

/** No authenticated principal / no derivable scope. */
export class UnauthenticatedError extends AppError {
  constructor(
    message = 'An authenticated session with organization/facility scope is required',
  ) {
    super('UNAUTHENTICATED', message);
    this.name = 'UnauthenticatedError';
  }
}

/** The principal is recognized but not permitted for the operation. */
export class ForbiddenError extends AppError {
  constructor(message = 'The principal is not permitted to perform this operation') {
    super('FORBIDDEN', message);
    this.name = 'ForbiddenError';
  }
}

/** The resource is outside the caller's organization/facility scope. */
export class ScopeMismatchError extends AppError {
  constructor(message = 'Resource is outside the caller facility scope') {
    super('SCOPE_MISMATCH', message);
    this.name = 'ScopeMismatchError';
  }
}

/** Input failed structural validation (no clinical rules are evaluated). */
export class ValidationError extends AppError {
  constructor(message: string, details: readonly string[] = []) {
    super('VALIDATION_FAILED', message, details);
    this.name = 'ValidationError';
  }
}

/** The referenced resource does not exist (no existence leak). */
export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}

/** The state machine rejects the requested transition. */
export class InvalidStateTransitionError extends AppError {
  constructor(message: string) {
    super('INVALID_STATE_TRANSITION', message);
    this.name = 'InvalidStateTransitionError';
  }
}

/** The operation conflicts with an existing immutable/unique fact. */
export class ConflictError extends AppError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}

/** Replay semantics are violated (reserved; the established contract is replay-safe). */
export class IdempotencyConflictError extends AppError {
  constructor(message: string) {
    super('IDEMPOTENCY_CONFLICT', message);
    this.name = 'IdempotencyConflictError';
  }
}

/** Unexpected failure — internal-only message, no sensitive detail. */
export class InternalError extends AppError {
  constructor(message = 'Internal application error') {
    super('INTERNAL', message);
    this.name = 'InternalError';
  }
}

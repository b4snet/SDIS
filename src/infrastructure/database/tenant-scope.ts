/**
 * SDIS tenant-scope context for the PostgreSQL query lifecycle (RLS-01).
 *
 * The application role (`sdis_app`) row-level-security policies require the
 * tenant GUCs (`sdis.organization_id`, `sdis.facility_id`) to be set for every
 * query (migration 014 makes unset context fail CLOSED). This module carries
 * the resolved session's scope across the async request boundary so that
 * `Database.query` / `Database.transaction` can stamp each statement with the
 * application role + tenant context (see `database.ts`).
 *
 * Wiring point: the HTTP transport wraps route delegation in
 * `runWithTenantScope(session)` after session resolution. Code that never
 * passes through a request context (migrations, seeds, ops tooling, service-
 * level tests) keeps running as the pool role and is unaffected.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantScope {
  readonly organizationId: string;
  readonly facilityId: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<TenantScope>();

/** Runs `fn` with the tenant scope visible to every nested database call. */
export async function runWithTenantScope<T>(
  scope: TenantScope,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(scope, fn);
}

/**
 * Runs `fn` with NO tenant scope active, so its database statements take the
 * unscoped path (pool role). This is the deliberate scope-escape seam used by
 * session validation (RLS-01): the facility directory must be readable across
 * organizations so a forged session is reported as `SCOPE_MISMATCH` instead of
 * collapsing into `FORBIDDEN`. It exposes registry metadata only — never tenant
 * data — and is the documented "pool-role path" residual of the RLS design.
 */
export async function runWithoutTenantScope<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(undefined as unknown as TenantScope, fn);
}

/** The active tenant scope for the current async context, if any. */
export function currentTenantScope(): TenantScope | undefined {
  return storage.getStore();
}

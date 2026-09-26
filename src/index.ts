/**
 * SDIS composition edge (Step 26 hardening).
 *
 * This module is the ONLY place where the outer layers meet: it re-exports the
 * transport surface and the PostgreSQL infrastructure composition, and provides
 * one factory that assembles them with the request-scope runner injected.
 * Nothing below the composition edge may import across the
 * transport → infrastructure boundary (enforced by
 * `tests/architecture/dependency-direction.test.ts`).
 *
 * Dependency direction (docs/ARCHITECTURE.md §2):
 *
 *   Transport → Application → Domain/Ports ← Infrastructure
 *
 * `src/transport/server.ts` owns the request-scope SEAM
 * (`TenantScopeRunner`); this edge injects the PostgreSQL IMPLEMENTATION
 * (`runWithTenantScope`) when the server is assembled with the PostgreSQL
 * runtime. Servers assembled without it keep the fail-closed pass-through.
 */

import { runWithTenantScope } from './infrastructure/database/tenant-scope';
import type { TenantScopeRunner } from './transport/request-scope';
import type { SdisHttpServerOptions } from './transport/server';

export { runWithTenantScope } from './infrastructure/database/tenant-scope';
export type { TenantScopeRunner } from './transport/request-scope';

/** The PostgreSQL RLS scope runner, injectable into the HTTP server. */
export const postgresRequestScopeRunner: TenantScopeRunner = runWithTenantScope;

/**
 * Assembles server options for the PostgreSQL runtime: identical to plain
 * `SdisHttpServerOptions`, but the tenant-scope runner is bound to the
 * PostgreSQL implementation so every authenticated request executes under
 * `sdis_app` with the session's tenant GUCs (fail-closed migration 014).
 */
export function postgresServerOptions(
  options: Omit<SdisHttpServerOptions, 'requestScopeRunner'>,
): SdisHttpServerOptions {
  return { ...options, requestScopeRunner: postgresRequestScopeRunner };
}

/**
 * Transport-owned request-scope seam (Step 26 hardening).
 *
 * The transport resolves an authenticated session and must hand its
 * tenant/facility scope to the layers below WITHOUT importing any concrete
 * persistence mechanism. This module declares only the seam: a function that
 * runs route work with a tenant scope attached.
 *
 * Canonical implementations:
 * - `runWithTenantScope` (`src/infrastructure/database/tenant-scope.ts`) —
 *   PostgreSQL RLS (AsyncLocalStorage → per-statement GUCs under `sdis_app`).
 * - pass-through (the transport default) — no scope; used by in-memory
 *   deployments and tests without RLS.
 *
 * Dependency direction (docs/ARCHITECTURE.md §2, enforced by
 * `tests/architecture/dependency-direction.test.ts`): transport may NOT
 * import infrastructure. The concrete runner is injected at the composition
 * edge (`src/index.ts`) when the server is assembled with the PostgreSQL
 * runtime.
 */

/**
 * Runs `fn` with the tenant scope visible to nested infrastructure calls.
 * Transport never interprets the scope itself; it only carries session
 * identity (organization, facility, user) downward.
 */
export type TenantScopeRunner = <T>(
  scope: {
    readonly organizationId: string;
    readonly facilityId: string;
    readonly userId?: string;
  },
  fn: () => Promise<T>,
) => Promise<T>;

/**
 * SDIS tenancy / facility scope contracts.
 *
 * Tenant and facility scope is MANDATORY and server-derived. A scope value is never
 * accepted from client input as an authoritative boundary; the server attaches the
 * authenticated caller's scope. These contracts make that explicit at the type level.
 */

import type { DepartmentId, FacilityId, OrganizationId } from './ids';

export interface OrganizationScope {
  readonly organizationId: OrganizationId;
}

export interface FacilityContext extends OrganizationScope {
  readonly facilityId: FacilityId;
  readonly departmentId?: DepartmentId;
}

/** A scope that has been derived from an authenticated session, never from a client. */
export interface AuthenticatedContext extends FacilityContext {
  readonly userId: string;
}

/** Guards: a scoped operation must receive an explicit, non-empty context. */
export function assertContextProvided(ctx: OrganizationScope | undefined): asserts ctx {
  if (!ctx || !ctx.organizationId) {
    throw new Error(
      'Facility/organization context is required and cannot be forged from client input',
    );
  }
}

/** Data must never cross organization boundaries without authorized semantics. */
export function assertSameOrganization(a: OrganizationScope, b: OrganizationScope): void {
  if (a.organizationId !== b.organizationId) {
    throw new Error('Cross-organization access is not authorized');
  }
}

/** Facility-scoped data may not be accessed through another facility's context. */
export function assertFacilityScoped(a: FacilityContext, b: FacilityContext): void {
  assertSameOrganization(a, b);
  if (a.facilityId !== b.facilityId) {
    throw new Error('Cross-facility access is not authorized');
  }
}

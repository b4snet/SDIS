/**
 * SDIS application session — the authenticated principal plus the scope DERIVED
 * server-side from that session.
 *
 * Invariants (docs/MASTER_RULES.md, docs/TENANCY.md):
 * - tenant/organization scope is never supplied by the client;
 * - facility scope is never supplied by the client;
 * - tenant scope ≠ actor identity; facility scope ≠ actor identity.
 *
 * Step 2 has no real authentication service: the session is contract-tested at
 * the application boundary (authentication enforcement itself is deferred).
 */

import type { DepartmentId, FacilityId, OrganizationId } from '../types/ids';
import type { Actor, DataSource, Provenance } from '../types/provenance';
import { assertContextProvided, type FacilityContext } from '../types/tenant';
import { ForbiddenError, ScopeMismatchError, UnauthenticatedError } from './errors';
import type { FacilityDirectory } from './ports';

export interface ApplicationSession {
  /** The acting principal (provenance actor — never a tenant/facility id). */
  readonly actor: Actor;
  /** Internal user identifier of the principal. */
  readonly userId: string;
  /** Server-derived organization scope. */
  readonly organizationId: OrganizationId;
  /** Server-derived facility scope. */
  readonly facilityId: FacilityId;
  readonly departmentId?: DepartmentId;
  /**
   * Authorization role claims (Step 11) carried by the authenticated
   * principal. These are NOT scope: they grant capability, while the
   * org/facility fields above still limit where it applies.
   */
  readonly roles?: readonly import('./authz/rbac').Role[];
}

/** A session is mandatory; assertions surface UNAUTHENTICATED, never a guess. */
export function requireSession(
  session: ApplicationSession | undefined,
): asserts session is ApplicationSession {
  if (
    !session ||
    !session.actor ||
    !session.actor.id ||
    !session.organizationId ||
    !session.facilityId
  ) {
    throw new UnauthenticatedError();
  }
}

/**
 * Fail-closed session check shared by all services: the session facility must
 * be a registered facility owned by the session organization. A forged
 * organization on an otherwise valid facility is rejected here — before any
 * resource check.
 */
export async function assertSessionFacility(
  session: ApplicationSession,
  facilities: FacilityDirectory,
): Promise<void> {
  const facility = await facilities.findById(session.facilityId);
  if (!facility) {
    throw new ForbiddenError('Session facility is not registered');
  }
  if (facility.organizationId !== session.organizationId) {
    throw new ScopeMismatchError('Cross-organization access is not authorized');
  }
}

/** The facility/tenant context attached to operations and audit records. */
export function facilityContextOf(session: ApplicationSession): FacilityContext {
  return {
    organizationId: session.organizationId,
    facilityId: session.facilityId,
    ...(session.departmentId ? { departmentId: session.departmentId } : {}),
  };
}

/**
 * Builds complete provenance (actor + source + timestamp + context) for an
 * operation. The actor always comes from the session — never from client input.
 */
export function provenanceFor(
  session: ApplicationSession,
  at: string,
  source: DataSource,
): Provenance {
  requireSession(session);
  return {
    actor: session.actor,
    source,
    timestamp: at,
    context: facilityContextOf(session),
  };
}

/**
 * Scope guard for stored resources that carry a facility identity.
 * The session facility must match the resource facility; a facility belongs to
 * exactly one organization, so the resource is thereby within the tenant scope.
 */
export function assertResourceInFacilityScope(
  session: ApplicationSession,
  resource: { readonly facilityId: FacilityId },
): void {
  requireSession(session);
  if (session.facilityId !== resource.facilityId) {
    throw new ScopeMismatchError();
  }
}

/**
 * Scope guard using the Step-1 tenant/facility assertion contract directly;
 * allocates no authority to the caller. Its `organizationId` can be forged only
 * by the server session — never by client input — because it is derived here.
 */
export function assertSameScope(
  session: ApplicationSession,
  resourceOrg: OrganizationId,
  resourceFacility: FacilityId,
): void {
  const sessionCtx: FacilityContext = facilityContextOf(session);
  assertContextProvided(sessionCtx);
  if (sessionCtx.organizationId !== resourceOrg) {
    throw new ScopeMismatchError('Cross-organization access is not authorized');
  }
  if (sessionCtx.facilityId !== resourceFacility) {
    throw new ScopeMismatchError('Cross-facility access is not authorized');
  }
}

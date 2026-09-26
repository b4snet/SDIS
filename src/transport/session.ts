/**
 * SDIS HTTP transport — session resolution (authentication boundary).
 *
 * The session shape is the existing application contract
 * (`ApplicationSession`): server-derived organization/facility scope, never
 * client-supplied. Credential authentication ships in `auth.ts` and plugs in
 * here through the single `SessionResolver` seam. The shipped default is
 * fail-closed: without a configured credential source, every request resolves
 * to UNAUTHENTICATED → HTTP 401. When `SDIS_API_TOKENS` is configured, the
 * server authenticates bearer credentials against that external directory
 * (`auth.ts` → `sessionResolverForEnvironment`) — routes, services, scope
 * derivation, and provenance remain unchanged.
 */

import type { ApplicationSession } from '../app/context';
import { TransportFailure } from './errors';

export type SessionResolver = (
  headers: Record<string, string | string[] | undefined>,
) => Promise<ApplicationSession | undefined>;

/** The shipped resolver: authentication deferred → fail closed, always 401. */
export const unauthenticatedSessionResolver: SessionResolver = async () => undefined;

/** Shared guard for routes: no session ⇒ transport 401, pre-service. */
export function requireResolvedSession(
  session: ApplicationSession | undefined,
): asserts session is ApplicationSession {
  if (!session) {
    throw new TransportFailure(401, 'Authentication is required', [], 'UNAUTHENTICATED');
  }
}

/**
 * SDIS HTTP transport — credential authentication foundation (Step 10).
 *
 * Connects the documented `SessionResolver` seam to a real, minimal
 * authentication mechanism: bearer credential lookup over an injected
 * `CredentialDirectory` port. The design follows the repository's own
 * documents — NO protocol is invented:
 *
 * - `docs/SECURITY.md` §2 plans "token-based for APIs" — a presented opaque
 *   bearer token in `Authorization` is that plan's smallest concrete form;
 * - the credential → principal mapping is injected via a port, so no password,
 *   signing-key, refresh-token, OAuth/OIDC, SSO, or MFA machinery is created;
 * - configuration (token → principal bindings) is external (env/deployment),
 *   never committed (docs/DEPLOYMENT.md §3; secrets stay out of source);
 * - scope is NOT a credential property: the mapping supplies the principal's
 *   server-derived organization/facility scope, preserving
 *   authentication identity ≠ authorization scope (docs/MASTER_RULES.md);
 * - failures are fail-closed: absent, malformed, or unknown credentials all
 *   resolve to `undefined` ⇒ the existing 401 UNAUTHENTICATED envelope.
 *   No authentication detail is ever echoed back.
 *
 * This is an authentication FOUNDATION for local/testing deployments — not a
 * production identity provider, and no such claim is made (docs/API_CONTRACTS
 * §9 remains the honest status until OAuth2/OIDC/cookie sessions arrive).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { isUuidV4 } from '../types/ids';
import type { OrganizationId, FacilityId } from '../types/ids';
import type { ApplicationSession } from '../app/context';
import type { Actor } from '../types/provenance';
import { ROLES, type Role } from '../app/authz/rbac';
import { unauthenticatedSessionResolver, type SessionResolver } from './session';

/** One externally-configured API credential binding (no secrets in source). */
export interface ApiCredential {
  /** Opaque bearer token value. Compared in constant time. */
  readonly token: string;
  /** The principal this credential authenticates as. */
  readonly actor: Actor;
  /** Human-readable principal id (application `userId`). */
  readonly userId: string;
  /** Server-derived scope carried by the credential's principal binding. */
  readonly organizationId: OrganizationId;
  readonly facilityId: FacilityId;
  /** Role claims resolved by the ONE authorization engine (Step 11). */
  readonly roles?: readonly Role[];
}

/** Lookup port — production binds this to configuration; tests to fixtures. */
export type CredentialDirectory = (token: string) => Promise<ApiCredential | undefined>;

/** The exact `Authorization` header this foundation consumes. */
const BEARER_PREFIX = 'bearer ';

/** Extracts the bearer token, or undefined for absent/malformed headers. */
export function bearerTokenOf(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string' || value.length <= BEARER_PREFIX.length) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (!lower.startsWith(BEARER_PREFIX)) return undefined;
  const token = value.slice(BEARER_PREFIX.length).trim();
  // Reject malformed credential material (control chars, absurd length).
  if (token.length === 0 || token.length > 256 || !/^[\x21-\x7E]+$/.test(token)) {
    return undefined;
  }
  return token;
}

/**
 * Wraps a directory with timing-uniform matching (SEC-AUTH-03).
 *
 * The naive `find`-with-early-exit over raw tokens leaks each configured
 * token's LENGTH and the position of a length-matching entry through total
 * request time. Instead: every presented token is hashed to a fixed-length
 * digest, and the digest is compared against EVERY entry's stored digest with
 * no early exit. The work per lookup is therefore uniform in the number of
 * entries and independent of any configured token's length or position.
 * (The digest is itself a commitment — an attacker who learned it could not
 * reconstruct the token.)
 */
export function constantTimeDirectory(
  credentials: readonly ApiCredential[],
): CredentialDirectory {
  const entries = credentials.map((credential) => ({
    credential,
    digest: createHash('sha256').update(credential.token, 'utf8').digest(),
  }));
  return async (token) => {
    const digest = createHash('sha256').update(token, 'utf8').digest();
    let match: ApiCredential | undefined;
    for (const entry of entries) {
      // No early exit: compare against every digest, remember the hit.
      if (timingSafeEqual(digest, entry.digest)) {
        match = entry.credential;
      }
    }
    return match;
  };
}

/**
 * Builds a `SessionResolver` that authenticates the request and resolves the
 * existing `ApplicationSession` (actor + server-derived scope). Any failure —
 * absent header, malformed token, unknown/expired credential — resolves to
 * `undefined`, which the transport maps to the existing 401 envelope.
 */
export function credentialSessionResolver(
  directory: CredentialDirectory,
): SessionResolver {
  return async (headers) => {
    const token = bearerTokenOf(headers);
    if (token === undefined) return undefined;
    const credential = await directory(token);
    if (!credential) return undefined;
    const session: ApplicationSession = {
      actor: credential.actor,
      userId: credential.userId,
      organizationId: credential.organizationId,
      facilityId: credential.facilityId,
      // Role claims ride the session for the authorization engine; they are
      // NOT scope and grant nothing outside the bound org/facility.
      ...(credential.roles ? { roles: credential.roles } : {}),
    };
    return session;
  };
}

// ---------------------------------------------------------------------------
// SDIS_API_TOKENS — the OPERATIONAL credential directory (AUTH-02)
// ---------------------------------------------------------------------------
//
// `docs/DEPLOYMENT.md` §3 and `docs/SECURITY.md` §2 plan external credential
// configuration with startup validation (fail-fast). This is that mechanism:
// SDIS_API_TOKENS is a JSON array of credential bindings supplied at
// deployment time. Secrets never live in source; the file/server that sets
// the environment variable owns them.

/** Raised when `SDIS_API_TOKENS` is present but malformed — startup, fail-fast. */
export class InvalidApiTokensError extends Error {
  constructor(message: string) {
    super(`SDIS_API_TOKENS: ${message}`);
    this.name = 'InvalidApiTokensError';
  }
}

const ACTOR_KINDS: readonly Actor['kind'][] = [
  'USER',
  'PRACTITIONER',
  'SERVICE',
  'SYSTEM',
  'PATIENT',
];
const KNOWN_ROLES: readonly string[] = Object.values(ROLES);

const TOKEN_PATTERN = /^[\x21-\x7E]{1,256}$/;

/**
 * Parses + validates the `SDIS_API_TOKENS` environment contract. Returns an
 * empty array when the variable is unset/blank (fail-closed default, no
 * credentials configured). Throws `InvalidApiTokensError` on any malformed
 * entry so a misconfigured deployment fails fast at startup instead of
 * silently 401ing forever.
 */
export function parseApiTokensEnv(raw: string | undefined): ApiCredential[] {
  if (raw === undefined || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new InvalidApiTokensError(`not valid JSON (${(error as Error).message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new InvalidApiTokensError('must be a JSON array of credential objects');
  }

  const credentials: ApiCredential[] = [];
  const seenTokens = new Set<string>();
  parsed.forEach((entry, index) => {
    const at = `entry ${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new InvalidApiTokensError(`${at} must be an object`);
    }
    const obj = entry as Record<string, unknown>;

    const token = obj['token'];
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
      throw new InvalidApiTokensError(
        `${at}: "token" must be a 1–256 character printable ASCII string`,
      );
    }
    if (seenTokens.has(token)) {
      throw new InvalidApiTokensError(`${at}: duplicate token`);
    }
    seenTokens.add(token);

    const userId = obj['userId'];
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new InvalidApiTokensError(`${at}: "userId" is required`);
    }

    const organizationId = obj['organizationId'];
    if (typeof organizationId !== 'string' || !isUuidV4(organizationId)) {
      throw new InvalidApiTokensError(
        `${at}: "organizationId" must be a UUID v4 identifier`,
      );
    }
    const facilityId = obj['facilityId'];
    if (typeof facilityId !== 'string' || !isUuidV4(facilityId)) {
      throw new InvalidApiTokensError(`${at}: "facilityId" must be a UUID v4 identifier`);
    }

    const actorKindRaw = obj['actorKind'] ?? 'USER';
    if (!ACTOR_KINDS.includes(actorKindRaw as Actor['kind'])) {
      throw new InvalidApiTokensError(
        `${at}: "actorKind" must be one of ${ACTOR_KINDS.join(', ')}`,
      );
    }
    const actorIdRaw = obj['actorId'] ?? userId;
    if (typeof actorIdRaw !== 'string' || actorIdRaw.length === 0) {
      throw new InvalidApiTokensError(`${at}: "actorId" is required`);
    }

    let roles: readonly Role[] | undefined;
    if (obj['roles'] !== undefined) {
      if (
        !Array.isArray(obj['roles']) ||
        obj['roles'].length === 0 ||
        !obj['roles'].every(
          (role): role is Role => typeof role === 'string' && KNOWN_ROLES.includes(role),
        )
      ) {
        throw new InvalidApiTokensError(
          `${at}: "roles" must be a non-empty array of known roles (${KNOWN_ROLES.join(', ')})`,
        );
      }
      roles = obj['roles'];
    }

    credentials.push({
      token,
      userId,
      actor: { kind: actorKindRaw as Actor['kind'], id: actorIdRaw },
      organizationId: organizationId as OrganizationId,
      facilityId: facilityId as FacilityId,
      ...(roles ? { roles } : {}),
    });
  });

  return credentials;
}

/**
 * The production SessionResolver seam: when `SDIS_API_TOKENS` is configured,
 * authenticate bearer credentials against the parsed directory; otherwise keep
 * the fail-closed unauthenticated default. Env parsing/validation runs once at
 * construction (startup, fail-fast).
 */
export function sessionResolverForEnvironment(env: NodeJS.ProcessEnv): SessionResolver {
  const raw = env['SDIS_API_TOKENS'];
  if (raw === undefined || raw.trim() === '') {
    return unauthenticatedSessionResolver;
  }
  const credentials = parseApiTokensEnv(raw);
  return credentialSessionResolver(constantTimeDirectory(credentials));
}

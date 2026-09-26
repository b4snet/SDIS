/**
 * SDIS authorization engine — the ONE authoritative RBAC mechanism.
 *
 * Separates the four concerns (docs/MASTER_RULES.md, docs/SECURITY.md §2):
 *
 *   Authentication → who the actor is      (Step 10 credential resolver)
 *   Scope          → where they operate    (org/facility guards, context.ts)
 *   Role           → what category of access they hold
 *   Permission     → which operation they may perform
 *
 * Design:
 * - Stable permission identifiers over the repository's ACTUAL capability
 *   surface (`<area>.<operation>`, matching existing kebab-case route names);
 *   no permissions for functionality that does not exist.
 * - Minimal neutral roles (viewer / operator / manager). No hospital roles,
 *   no clinical privileges — those are a documented future capability.
 * - A role grants capability; the EXISTING scope guards still decide where.
 *   Enforced order: authenticated → permission allowed → scope allowed →
 *   resource allowed.
 * - Fail-closed: unknown role, unknown permission, or missing authorization
 *   context denies. Denials surface as the existing `FORBIDDEN` contract with
 *   a minimal message (no role/permission/policy internals leak).
 * - Principal → role resolution goes through an injected `RoleResolver` port;
 *   the Step-10 credential binding supplies the role claim. No second
 *   authorization engine; no per-endpoint role string checks.
 *
 * Composition contract (AUTH-02): service `authz` dependencies are optional
 * ONLY as a unit-test seam. Every served composition (notably
 * `createPostgresLaboratoryRuntime`) MUST wire the shared
 * `AuthorizationService` into every service — an unwired service silently
 * skips all permission checks. The integration gateway is the single
 * exception: it performs no direct permission decision and delegates every
 * mutation to permission-gated services.
 */

import { ForbiddenError } from '../errors';
import { requireSession, type ApplicationSession } from '../context';

/** Stable permission identifiers over the existing capability surface. */
export const PERMISSIONS = {
  PATIENT_READ: 'patient.read',
  PATIENT_CREATE: 'patient.create',
  ORDER_READ: 'order.read',
  ORDER_CREATE: 'order.create',
  /**
   * High-integrity verification of diagnostic content (Step 28; manager
   * tier). Verification is a reviewing signature on clinical content — the
   * operator tier may enter results but may not verify them. Never reuse a
   * configuration permission for this clinical act (AUD-02).
   */
  ORDER_VERIFY: 'order.verify',
  SPECIMEN_CREATE: 'specimen.create',
  OBSERVATION_READ: 'observation.read',
  OBSERVATION_CREATE: 'observation.create',
  REPORT_READ: 'report.read',
  REPORT_CREATE: 'report.create',
  /**
   * Amendment of a finalized report (Step 28; manager tier). A clinical
   * correction producing a new superseding version — never gated by a
   * configuration permission (AUD-02).
   */
  REPORT_AMEND: 'report.amend',
  BILLING_READ: 'billing.read',
  BILLING_CREATE: 'billing.create',
  DEVICE_INGEST: 'device.ingest',
  DOCUMENT_READ: 'document.read',
  DOCUMENT_CREATE: 'document.create',
  /**
   * Terminology mapping administration (Step 7; manager tier). Creating a
   * facility mapping changes code resolution facility-wide — an
   * administrative act, never an operator-tier write. Reads
   * (`getMapping`/`resolveMappings`) stay auth+scope gated by design: every
   * facility session must resolve codes to do its work.
   */
  TERMINOLOGY_MANAGE: 'terminology.manage',
  INVENTORY_READ: 'inventory.read',
  INVENTORY_MANAGE: 'inventory.manage',
  SETUP_READ: 'setup.read',
  SETUP_MANAGE: 'setup.manage',
  /** Delivery-receipt read model (Step 19). */
  NOTIFICATION_READ: 'notification.read',
  /** Notification delivery lifecycle administration (Step 19; manager tier). */
  NOTIFICATION_MANAGE: 'notification.manage',
  /**
   * External-system registration administration (Step 20, manager tier).
   *
   * AUTH-01 reservation note: currently reservation-only — external-system
   * registration has no HTTP route and registry writes are ops/seed-only, so
   * there is no enforcement point yet. When a registration admin endpoint is
   * introduced it MUST assert `INTEGRATION_MANAGE`; until then the permission
   * stays manager-assigned and ungated by design (no exposed path exists to
   * guard).
   */
  INTEGRATION_MANAGE: 'integration.manage',
  /**
   * Quality-record administration (Steps 25/27/30; manager tier): recording
   * QC results and releasing analytical holds. An operational laboratory
   * authority — never a configuration permission (AUD-02).
   */
  QUALITY_MANAGE: 'quality.manage',
  /**
   * Patient-facing access to OWN finalized reports (Step 22). Granted ONLY to
   * the patient role — staff roles never need it, and no staff role receives
   * it: patient access is ownership-scoped by the patient identity service.
   */
  PATIENT_REPORT_READ: 'patient.report.read',
  /**
   * Patient-facing access to OWN patient-visible documents (Step 23).
   * Granted ONLY to the patient role; staff document permissions are
   * separate (DOCUMENT_READ/DOCUMENT_CREATE) and never imply patient access.
   */
  PATIENT_DOCUMENT_READ: 'patient.document.read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/** Every defined permission (fail-closed vocabulary). */
export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS);

/** Minimal neutral roles — capability tiers, not hospital job titles. */
export const ROLES = {
  /** Read-only across the existing capability surface. */
  VIEWER: 'viewer',
  /** Front-line operation: intake, orders, specimens, results entry. */
  OPERATOR: 'operator',
  /** Operations plus reporting and billing. */
  MANAGER: 'manager',
  /**
   * The authenticated PATIENT (Step 22). Holds exactly one permission:
   * patient-facing access to their OWN finalized reports. Staff tiers never
   * receive patient permissions; the patient tier never receives staff ones.
   */
  PATIENT: 'patient',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

const VIEWER_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.PATIENT_READ,
  PERMISSIONS.ORDER_READ,
  PERMISSIONS.OBSERVATION_READ,
  PERMISSIONS.REPORT_READ,
  PERMISSIONS.BILLING_READ,
  PERMISSIONS.DOCUMENT_READ,
  PERMISSIONS.INVENTORY_READ,
  PERMISSIONS.SETUP_READ,
  PERMISSIONS.NOTIFICATION_READ,
];

const OPERATOR_PERMISSIONS: readonly Permission[] = [
  ...VIEWER_PERMISSIONS,
  PERMISSIONS.PATIENT_CREATE,
  PERMISSIONS.ORDER_CREATE,
  PERMISSIONS.SPECIMEN_CREATE,
  PERMISSIONS.OBSERVATION_CREATE,
  PERMISSIONS.REPORT_CREATE,
  PERMISSIONS.DEVICE_INGEST,
  PERMISSIONS.DOCUMENT_CREATE,
  PERMISSIONS.INVENTORY_MANAGE,
];

/** Role → permission assignments (the single authoritative mapping). */
export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  [ROLES.VIEWER]: VIEWER_PERMISSIONS,
  [ROLES.OPERATOR]: OPERATOR_PERMISSIONS,
  // Configuration changes are administrative: the manager tier only.
  [ROLES.MANAGER]: [
    ...OPERATOR_PERMISSIONS,
    PERMISSIONS.BILLING_CREATE,
    PERMISSIONS.SETUP_MANAGE,
    PERMISSIONS.INTEGRATION_MANAGE,
    PERMISSIONS.NOTIFICATION_MANAGE,
    PERMISSIONS.ORDER_VERIFY,
    PERMISSIONS.REPORT_AMEND,
    PERMISSIONS.QUALITY_MANAGE,
    PERMISSIONS.TERMINOLOGY_MANAGE,
  ],
  // Patient tier: ONLY patient-scoped capabilities — own finalized reports
  // (Step 22) and own patient-visible documents (Step 23). No staff
  // permission is ever included here.
  [ROLES.PATIENT]: [PERMISSIONS.PATIENT_REPORT_READ, PERMISSIONS.PATIENT_DOCUMENT_READ],
};

/** Resolves the roles held by the authenticated principal (injected port). */
export type RoleResolver = (session: ApplicationSession) => Promise<readonly Role[]>;

/** Default resolver: the principal's role claim from the credential binding. */
export function claimedRoleResolver(): RoleResolver {
  return async (session) => {
    const roles = (session as { roles?: readonly Role[] }).roles;
    return roles ?? [];
  };
}

/** Result of an authorization decision (never leaks which check failed). */
export interface AuthorizationDecision {
  readonly allowed: boolean;
}

export interface AuthorizationDependencies {
  readonly roleResolver: RoleResolver;
}

export class AuthorizationService {
  constructor(private readonly deps: AuthorizationDependencies) {}

  /**
   * Decides whether the session's principal holds the permission. Fail-closed:
   * missing session/roles, unknown role, or unknown permission → denied.
   */
  async decide(
    session: ApplicationSession | undefined,
    permission: Permission,
  ): Promise<AuthorizationDecision> {
    if (!session) return { allowed: false };
    if (!(Object.values(PERMISSIONS) as string[]).includes(permission)) {
      return { allowed: false };
    }
    const roles = await this.deps.roleResolver(session);
    if (!roles || roles.length === 0) return { allowed: false };
    for (const role of roles) {
      const granted = ROLE_PERMISSIONS[role];
      // Unknown role → that entry grants nothing (fail-closed).
      if (!granted) continue;
      if (granted.includes(permission)) return { allowed: true };
    }
    return { allowed: false };
  }

  /**
   * Enforces permission at the application boundary, BEFORE any scope or
   * resource check. Denial raises the existing `FORBIDDEN` contract with a
   * minimal, non-leaking message.
   */
  async assertPermission(
    session: ApplicationSession | undefined,
    permission: Permission,
  ): Promise<void> {
    requireSession(session);
    const decision = await this.decide(session, permission);
    if (!decision.allowed) {
      throw new ForbiddenError(
        'The principal is not permitted to perform this operation',
      );
    }
  }
}

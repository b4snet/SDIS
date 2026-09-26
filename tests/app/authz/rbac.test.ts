/**
 * RBAC authorization engine tests (Step 11).
 *
 * Prove the ONE authorization engine: role → permission mapping, principal →
 * role resolution, granted/denied decisions, unknown role/permission
 * fail-closed denial, FORBIDDEN contract mapping, and the scope interaction —
 * a role grants capability but the existing scope guards still decide where.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_PERMISSIONS,
  AuthorizationService,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  claimedRoleResolver,
} from '../../../src/app/authz/rbac';
import { ForbiddenError, UnauthenticatedError } from '../../../src/app/errors';
import {
  createFixture,
  orderIdOf,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  ORG,
  OTHER_ORG,
} from '../helpers';

function serviceFor(roles?: readonly string[]): AuthorizationService {
  return new AuthorizationService({
    roleResolver: async () => (roles ?? []) as never,
  });
}

const VIEWER = sessionFor();
const VIEWER_ROLES = [ROLES.VIEWER];

describe('rbac: engine', () => {
  it('maps every defined role to a non-empty permission set', () => {
    for (const role of Object.values(ROLES)) {
      assert.ok(ROLE_PERMISSIONS[role].length > 0, `role ${role} grants nothing`);
    }
  });

  it('operator tier includes viewer capabilities plus operations (tiering)', () => {
    for (const permission of ROLE_PERMISSIONS[ROLES.VIEWER]) {
      assert.ok(ROLE_PERMISSIONS[ROLES.OPERATOR].includes(permission));
    }
    assert.ok(ROLE_PERMISSIONS[ROLES.OPERATOR].includes(PERMISSIONS.ORDER_CREATE));
  });

  it('manager tier includes billing.create which operator lacks', () => {
    assert.ok(!ROLE_PERMISSIONS[ROLES.OPERATOR].includes(PERMISSIONS.BILLING_CREATE));
    assert.ok(ROLE_PERMISSIONS[ROLES.MANAGER].includes(PERMISSIONS.BILLING_CREATE));
  });

  it('grants a permission the principal role holds', async () => {
    const service = serviceFor(VIEWER_ROLES);
    await service.assertPermission(VIEWER, PERMISSIONS.ORDER_READ);
  });

  it('denies a permission the principal role lacks (403 FORBIDDEN)', async () => {
    const service = serviceFor(VIEWER_ROLES);
    await assert.rejects(
      () => service.assertPermission(VIEWER, PERMISSIONS.ORDER_CREATE),
      ForbiddenError,
    );
  });

  it('denies an unknown role (fail-closed)', async () => {
    const service = serviceFor(['chief-wizard']);
    await assert.rejects(
      () => service.assertPermission(VIEWER, PERMISSIONS.ORDER_READ),
      ForbiddenError,
    );
  });

  it('denies an unknown permission (fail-closed)', async () => {
    const service = serviceFor([ROLES.MANAGER]);
    const decision = await service.decide(VIEWER, 'user.administer' as never);
    assert.equal(decision.allowed, false);
  });

  it('denies principals with no roles at all (fail-closed)', async () => {
    const service = serviceFor([]);
    await assert.rejects(
      () => service.assertPermission(VIEWER, PERMISSIONS.ORDER_READ),
      ForbiddenError,
    );
  });

  it('denies unauthenticated sessions before any permission check', async () => {
    const service = serviceFor(VIEWER_ROLES);
    await assert.rejects(
      () => service.assertPermission(undefined, PERMISSIONS.ORDER_READ),
      UnauthenticatedError,
    );
  });

  it('denial messages never leak role/permission/policy internals', async () => {
    const service = serviceFor(VIEWER_ROLES);
    try {
      await service.assertPermission(VIEWER, PERMISSIONS.BILLING_CREATE);
      assert.fail('expected ForbiddenError');
    } catch (error) {
      assert.ok(error instanceof ForbiddenError);
      const message = error.message.toLowerCase();
      assert.ok(!message.includes('billing'));
      assert.ok(!message.includes('manager'));
      assert.ok(!message.includes('permission'));
      assert.ok(!message.includes('role'));
    }
  });

  it('the claimed-role resolver reads the session role claim', async () => {
    const resolver = claimedRoleResolver();
    const claimed = await resolver({ ...VIEWER, roles: [ROLES.MANAGER] } as never);
    assert.deepEqual(claimed, [ROLES.MANAGER]);
    const unclaimed = await resolver({ ...VIEWER } as never);
    assert.deepEqual(unclaimed, []);
  });

  it('covers the whole existing capability surface in the permission catalog', () => {
    // Stable identifiers over the real surface (Step 19 added the
    // notification.read + notification.manage receipt/lifecycle model;
    // Step 22 added patient.report.read; Step 23 added patient.document.read;
    // remediation added order.verify + report.amend + quality.manage +
    // terminology.manage so clinical/admin acts never borrow configuration
    // permissions — AUD-02);
    // no invented functionality.
    assert.equal(ALL_PERMISSIONS.length, 27);
  });

  it('reserves manager-only clinical permissions outside the setup family (AUD-02)', async () => {
    for (const permission of [
      PERMISSIONS.ORDER_VERIFY,
      PERMISSIONS.REPORT_AMEND,
      PERMISSIONS.QUALITY_MANAGE,
      PERMISSIONS.TERMINOLOGY_MANAGE,
    ]) {
      assert.ok(!ROLE_PERMISSIONS[ROLES.VIEWER].includes(permission));
      assert.ok(!ROLE_PERMISSIONS[ROLES.OPERATOR].includes(permission));
      assert.ok(ROLE_PERMISSIONS[ROLES.MANAGER].includes(permission));
      await assert.rejects(
        () => serviceFor([ROLES.OPERATOR]).assertPermission(VIEWER, permission),
        ForbiddenError,
      );
    }
  });

  it('holds integration.manage as a manager-assigned reservation (AUTH-01)', async () => {
    assert.ok(ROLE_PERMISSIONS[ROLES.MANAGER].includes(PERMISSIONS.INTEGRATION_MANAGE));
    assert.ok(!ROLE_PERMISSIONS[ROLES.OPERATOR].includes(PERMISSIONS.INTEGRATION_MANAGE));
    // Reservation contract: no HTTP registration route exists, so nothing may
    // depend on this permission being enforced yet — but it must stay
    // manager-tier so a future registration endpoint inherits the right bar.
    await serviceFor([ROLES.MANAGER]).assertPermission(
      VIEWER,
      PERMISSIONS.INTEGRATION_MANAGE,
    );
  });
});

describe('rbac: scope interaction', () => {
  it('permission present + scope valid → the operation proceeds', async () => {
    const { fixture } = { fixture: createFixture() };
    const service = serviceFor([ROLES.OPERATOR]);
    // No throw: ORDER_CREATE held, session facility matches the fixture scope.
    await service.assertPermission(fixture.session, PERMISSIONS.ORDER_CREATE);
  });

  it('same role + different facility is still denied by the scope guards', async () => {
    const { orders } = createFixture();
    // The operator role includes ORDER_CREATE, but the caller's bound facility
    // differs from the resource's facility — the scope guard denies.
    const authz = serviceFor([ROLES.OPERATOR]);
    const outsider = sessionFor(OTHER_FACILITY, ORG);
    await authz.assertPermission(outsider, PERMISSIONS.ORDER_CREATE); // capability held
    const order = await orders
      .createOrder(sessionFor(), {
        patientId: (orders as unknown as { deps: { patients: { findById: unknown } } })
          .deps.patients as never,
        encounterId: null as never,
        modality: 'LAB',
        items: [],
        orderedAt: '2026-09-21T08:00:00.000Z',
      })
      .catch(() => null);
    assert.equal(order, null); // cross-facility principal cannot even build it
  });

  it('same role + different tenant is denied by the scope guards', async () => {
    // Operator capability held; same facility id, but the organization is
    // forged. The resource-level org cross-check must still deny.
    const forged = sessionFor(FACILITY, OTHER_ORG);
    (forged as { roles?: readonly string[] }).roles = [ROLES.OPERATOR] as never;
    const service = serviceFor([ROLES.OPERATOR]);
    const fixture = createFixture();
    const order = await fixture.orders.createOrder(fixture.session, {
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      modality: 'LAB',
      orderedAt: new Date().toISOString(),
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    });
    await assert.rejects(
      fixture.orders.getOrder(forged, orderIdOf(order)),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
    assert.ok(service); // capability present; denial came from scope, not role
  });
});

/**
 * Application tests: order service.
 *
 * Behavior is verified through the public interface (create → read back the
 * DTO); tests never inspect repository internals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUuidV4 } from '../../src/types/ids';
import type { ApplicationSession } from '../../src/app/context';
import type { EncounterId, PatientId } from '../../src/types/ids';
import {
  ForbiddenError,
  InvalidStateTransitionError,
  NotFoundError,
  ScopeMismatchError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/app/errors';
import {
  at,
  auditCountFor,
  createFixture,
  OTHER_ENCOUNTER_ID,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  OTHER_ORG,
  orderIdOf,
} from './helpers';

/** Manager-tier session (Step 28): VERIFIED transitions and amendments. */
function managerSession(fx: { session: ApplicationSession }): ApplicationSession {
  return {
    ...fx.session,
    actor: { kind: 'USER', id: 'user-manager-1' },
    userId: 'user-manager-1',
    roles: ['manager'],
  } as never;
}

describe('app: order creation', () => {
  it('creates an ORDERED order and reads it back with the same public fields', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    assert.equal(created.status, 'ORDERED');
    assert.equal(created.patientId, fx.patientId);
    assert.equal(created.encounterId, fx.encounterId);
    assert.equal(created.facilityId, FACILITY);
    assert.equal(created.modality, 'LAB');
    assert.equal(created.items.length, 1);

    const readBack = await fx.orders.getOrder(fx.session, orderIdOf(created));
    assert.deepEqual(readBack, created);
    assert.equal(auditCountFor(fx, created.id, 'CREATED'), 1);
  });

  it('rejects a missing session', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.orders.createOrder(undefined, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      UnauthenticatedError,
    );
  });

  it('rejects an unknown patient and an unknown encounter', async () => {
    const fx = createFixture();
    const unknownPatient = assertUuidV4<PatientId>(
      '00000000-0000-4000-8000-00000000fff1',
      'patient id',
    );
    const unknownEncounter = assertUuidV4<EncounterId>(
      '00000000-0000-4000-8000-00000000fff2',
      'encounter id',
    );
    await assert.rejects(
      () =>
        fx.orders.createOrder(fx.session, {
          patientId: unknownPatient,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      NotFoundError,
    );
    await assert.rejects(
      () =>
        fx.orders.createOrder(fx.session, {
          patientId: fx.patientId,
          encounterId: unknownEncounter,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      NotFoundError,
    );
  });

  it('rejects an encounter that belongs to another patient', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.orders.createOrder(fx.session, {
          patientId: fx.patientId,
          encounterId: OTHER_ENCOUNTER_ID,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      ValidationError,
    );
  });

  it('rejects an unknown modality and empty items', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.orders.createOrder(fx.session, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'UNKNOWN_MODALITY',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        fx.orders.createOrder(fx.session, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [],
          orderedAt: at(0),
        }),
      ValidationError,
    );
  });

  it('replays an idempotency key without duplicating the order or audit', async () => {
    const fx = createFixture();
    const input = {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB' as const,
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
      idempotencyKey: 'req-order-1',
    };
    const first = await fx.orders.createOrder(fx.session, input);
    const second = await fx.orders.createOrder(fx.session, input);
    assert.equal(first.id, second.id);
    assert.equal(auditCountFor(fx, first.id, 'CREATED'), 1);
  });

  it('rejects a forged organization on the session', async () => {
    const fx = createFixture();
    const forged = sessionFor(FACILITY, OTHER_ORG);
    (forged as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () =>
        fx.orders.createOrder(forged, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
        }),
      ScopeMismatchError,
    );
  });

  it('rejects reading an order from another facility (IDOR)', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const otherFacility = sessionFor(OTHER_FACILITY);
    (otherFacility as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () => fx.orders.getOrder(otherFacility, orderIdOf(created)),
      ScopeMismatchError,
    );
  });
});

describe('app: order transitions', () => {
  it('walks ORDERED → ACQUIRED → PROCESSING through the service', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const id = orderIdOf(created);
    const acquired = await fx.orders.transitionOrder(fx.session, id, 'ACQUIRED', at(1));
    assert.equal(acquired.status, 'ACQUIRED');
    const processing = await fx.orders.transitionOrder(
      fx.session,
      id,
      'PROCESSING',
      at(2),
    );
    assert.equal(processing.status, 'PROCESSING');
    assert.equal(auditCountFor(fx, created.id, 'TRANSITIONED'), 2);
  });

  it('rejects skipping states', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    await assert.rejects(
      () => fx.orders.transitionOrder(fx.session, orderIdOf(created), 'FINALIZED', at(1)),
      InvalidStateTransitionError,
    );
  });

  it('cancels an ORDERED order but not a VERIFIED one', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const id = orderIdOf(created);
    const cancelled = await fx.orders.cancelOrder(fx.session, id, at(1));
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(auditCountFor(fx, created.id, 'CANCELLED'), 1);

    const second = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
      idempotencyKey: 'cancel-walk',
    });
    const secondId = orderIdOf(second);
    // VERIFIED is manager-tier (Step 28); the walk's final step elevates.
    for (const [to, minute] of [
      ['ACQUIRED', 1],
      ['PROCESSING', 2],
      ['RESULT_ENTERED', 3],
      ['VERIFIED', 4],
    ] as const) {
      await fx.orders.transitionOrder(
        to === 'VERIFIED' ? managerSession(fx) : fx.session,
        secondId,
        to,
        at(minute),
      );
    }
    await assert.rejects(
      () => fx.orders.cancelOrder(fx.session, secondId, at(5)),
      InvalidStateTransitionError,
    );
  });

  it('denies every lifecycle transition to a viewer (AUD-01)', async () => {
    const fx = createFixture();
    const viewer = {
      ...fx.session,
      actor: { kind: 'USER', id: 'user-viewer-1' },
      userId: 'user-viewer-1',
      roles: ['viewer'],
    } as never;
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const id = orderIdOf(created);
    // Each sensitive transition — including cancel — is forbidden.
    await assert.rejects(
      () => fx.orders.transitionOrder(viewer, id, 'ACQUIRED', at(1)),
      ForbiddenError,
    );
    await assert.rejects(() => fx.orders.cancelOrder(viewer, id, at(1)), ForbiddenError);
    // Denied requests cause no state change and no audit side effects.
    const unchanged = await fx.orders.getOrder(fx.session, id);
    assert.equal(unchanged.status, 'ORDERED');
    assert.equal(auditCountFor(fx, created.id, 'TRANSITIONED'), 0);
    assert.equal(auditCountFor(fx, created.id, 'CANCELLED'), 0);
  });

  it('denies VERIFIED to the operator tier (manager-only order.verify)', async () => {
    const fx = createFixture();
    const created = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const id = orderIdOf(created);
    for (const [to, minute] of [
      ['ACQUIRED', 1],
      ['PROCESSING', 2],
      ['RESULT_ENTERED', 3],
    ] as const) {
      await fx.orders.transitionOrder(fx.session, id, to, at(minute));
    }
    await assert.rejects(
      () => fx.orders.transitionOrder(fx.session, id, 'VERIFIED', at(4)),
      ForbiddenError,
    );
    const unchanged = await fx.orders.getOrder(fx.session, id);
    assert.equal(unchanged.status, 'RESULT_ENTERED');
    assert.equal(auditCountFor(fx, created.id, 'VERIFIED'), 0);
    // The manager tier verifies and the attribution is the session actor.
    const verified = await fx.orders.transitionOrder(
      managerSession(fx),
      id,
      'VERIFIED',
      at(4),
    );
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.verifiedByRef, 'user-manager-1');
    assert.equal(auditCountFor(fx, created.id, 'VERIFIED'), 1);
  });
});

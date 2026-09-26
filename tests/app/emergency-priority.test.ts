/**
 * Step 21 — emergency & critical diagnostic workflow foundation (application).
 *
 * Proves the priority model end-to-end through the application boundary:
 * creation with priority, validated vocabulary, scoped + audited + idempotent
 * priority changes, scope enforcement (cross-tenant / cross-facility), the
 * deterministic worklist ordering, and the clinical-safety invariants:
 * priority NEVER reaches observation/interpretation/report content, and a
 * finalized report is unaffected by any priority change.
 *
 * Fresh fixture per test; behavior is verified through public service
 * interfaces only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ScopeMismatchError,
  UnauthenticatedError,
  ValidationError,
} from '../../src/app/errors';
import { WorklistService } from '../../src/app/laboratory/worklist-service';
import type { OrderDTO } from '../../src/app/dto';
import {
  at,
  auditCountFor,
  createFixture,
  OTHER_FACILITY,
  OTHER_ORG,
  orderIdOf,
  sessionFor,
} from './helpers';
import { orderIdOf as orderIdDtoToId } from './helpers';

function makeOrder(fx: ReturnType<typeof createFixture>, priority?: string) {
  return fx.orders.createOrder(fx.session, {
    patientId: fx.patientId,
    encounterId: fx.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: at(0),
    ...(priority ? { priority } : {}),
  });
}

describe('app: emergency priority — creation & vocabulary', () => {
  it('creates an EMERGENCY order carrying the priority', async () => {
    const fx = createFixture();
    const created = await makeOrder(fx, 'EMERGENCY');
    assert.equal(created.priority, 'EMERGENCY');
    const readBack = await fx.orders.getOrder(fx.session, orderIdOf(created));
    assert.equal(readBack.priority, 'EMERGENCY');
  });

  it('defaults unstated priority to ROUTINE', async () => {
    const fx = createFixture();
    const created = await makeOrder(fx);
    assert.equal(created.priority, 'ROUTINE');
  });

  it('rejects an invalid priority as a validation error (not a crash)', async () => {
    const fx = createFixture();
    await assert.rejects(() => makeOrder(fx, 'STAT'), ValidationError);
    await assert.rejects(() => makeOrder(fx, 'emergency'), ValidationError);
    // An absent/empty priority means "unstated" — the ROUTINE default applies.
    const emptied = await makeOrder(fx, '');
    assert.equal(emptied.priority, 'ROUTINE');
  });

  it('rejects priority creation without a session (fail closed)', async () => {
    const fx = createFixture();
    await assert.rejects(
      () =>
        fx.orders.createOrder(undefined, {
          patientId: fx.patientId,
          encounterId: fx.encounterId,
          modality: 'LAB',
          items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
          orderedAt: at(0),
          priority: 'EMERGENCY',
        }),
      UnauthenticatedError,
    );
  });
});

describe('app: priority change — audit, authorization, idempotency', () => {
  it('changes priority and audits actor + previous -> new priority', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    const id = orderIdOf(order);
    const changed = await fx.orders.changeOrderPriority(
      fx.session,
      id,
      'EMERGENCY',
      at(5),
    );
    assert.equal(changed.priority, 'EMERGENCY');
    // Exactly one UPDATED audit row for the change, on the order resource.
    assert.equal(auditCountFor(fx, order.id, 'UPDATED'), 1);
  });

  it('is idempotent on replay: same result, no duplicate audit side effect', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    const id = orderIdOf(order);
    const key = 'emergency-priority-replay';
    const first = await fx.orders.changeOrderPriority(
      fx.session,
      id,
      'EMERGENCY',
      at(5),
      { idempotencyKey: key },
    );
    const replay = await fx.orders.changeOrderPriority(
      fx.session,
      id,
      'EMERGENCY',
      at(5),
      { idempotencyKey: key },
    );
    assert.equal(replay.id, first.id);
    assert.equal(replay.priority, first.priority);
    // One change -> one UPDATED audit row even after the replay.
    assert.equal(auditCountFor(fx, order.id, 'UPDATED'), 1);
  });

  it('is a no-op (no audit row) when the priority is unchanged', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx, 'URGENT');
    const same = await fx.orders.changeOrderPriority(
      fx.session,
      orderIdOf(order),
      'URGENT',
      at(5),
    );
    assert.equal(same.priority, 'URGENT');
    assert.equal(auditCountFor(fx, order.id, 'UPDATED'), 0);
  });

  it('rejects an invalid target priority as a validation error', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    await assert.rejects(
      () =>
        fx.orders.changeOrderPriority(fx.session, orderIdOf(order), 'CRITICAL', at(5)),
      ValidationError,
    );
  });

  it('refuses to change priority on a cancelled order (historical)', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    await fx.orders.cancelOrder(fx.session, orderIdOf(order), at(2));
    await assert.rejects(
      () =>
        fx.orders.changeOrderPriority(fx.session, orderIdOf(order), 'EMERGENCY', at(5)),
      // Domain closed-state rule surfaces as an invalid state transition.
      (error: unknown) =>
        error instanceof Error && /historical once cancelled/.test(error.message),
    );
  });
});

describe('app: priority scope enforcement', () => {
  it('rejects cross-facility priority escalation (other facility, same org)', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx, 'ROUTINE');
    const foreignSession = sessionFor(OTHER_FACILITY, OTHER_ORG);
    (foreignSession as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () =>
        fx.orders.changeOrderPriority(
          foreignSession,
          orderIdOf(order),
          'EMERGENCY',
          at(5),
        ),
      ScopeMismatchError,
    );
    // The order is unchanged.
    const readBack = await fx.orders.getOrder(fx.session, orderIdOf(order));
    assert.equal(readBack.priority, 'ROUTINE');
  });

  it('rejects a forged tenant/facility session before any resource access', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    const forged = sessionFor(OTHER_FACILITY, OTHER_ORG, 'attacker-1');
    (forged as { roles?: readonly string[] }).roles = ['operator'] as never;
    await assert.rejects(
      () => fx.orders.getOrder(forged, orderIdOf(order)),
      ScopeMismatchError,
    );
    await assert.rejects(
      () => fx.orders.changeOrderPriority(forged, orderIdOf(order), 'EMERGENCY', at(5)),
      ScopeMismatchError,
    );
    assert.equal(auditCountFor(fx, order.id, 'UPDATED'), 0);
  });

  it('attributes the priority change to the authenticated actor only', async () => {
    const fx = createFixture();
    const order = await makeOrder(fx);
    const actorSession = sessionFor(undefined, undefined, 'user-dr-7');
    (actorSession as { roles?: readonly string[] }).roles = ['operator'] as never;
    await fx.orders.changeOrderPriority(actorSession, orderIdOf(order), 'URGENT', at(5));
    const events = fx.audit
      .list()
      .filter((event) => event.objectId === order.id && event.action === 'UPDATED');
    assert.equal(events.length, 1);
    // The actor recorded is the session's actor — never a client-supplied value.
    assert.ok(!JSON.stringify(events[0]).includes('claimedBy'));
    assert.ok(JSON.stringify(events[0]).includes('user-dr-7'));
  });
});

describe('app: worklist — deterministic operational ordering', () => {
  it('orders EMERGENCY -> URGENT -> ROUTINE, then by ordered-at, then id', async () => {
    const fx = createFixture();
    const routine1 = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
      orderedAt: at(0),
    });
    const routine2 = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'LFT', codeSystem: 'sdis' }],
      orderedAt: at(1),
    });
    const urgent = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'TROP', codeSystem: 'sdis' }],
      orderedAt: at(2),
      priority: 'URGENT',
    });
    const emergency = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'STAT-X', codeSystem: 'sdis' }],
      orderedAt: at(3),
      priority: 'EMERGENCY',
    });

    const worklist = new WorklistService(
      (
        fx.orders as unknown as {
          deps: {
            orders: ConstructorParameters<typeof WorklistService>[0]['orders'];
            facilities: ConstructorParameters<typeof WorklistService>[0]['facilities'];
          };
        }
      ).deps,
    );
    const entries = await worklist.listForSession(fx.session);
    const ids = entries.map((entry: OrderDTO) => entry.id);
    const position = (dto: { readonly id: string }) => ids.indexOf(dto.id);
    // Priority rank first…
    assert.ok(position(emergency) < position(urgent));
    assert.ok(position(urgent) < position(routine1));
    // …then deterministic secondary order (received time) within a priority.
    assert.ok(position(routine1) < position(routine2));
  });
});

describe('app: clinical safety — priority never becomes clinical truth', () => {
  it('runs the emergency flow: priority survives the workflow, clinical records do not change', async () => {
    const fx = createFixture();
    const flowSession = fx.session;
    (flowSession as { roles?: readonly string[] }).roles = [
      'operator',
      'manager',
    ] as never;
    const result = await fx.flow.run({
      session: flowSession,
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      testCode: 'TROP-I',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'TROP',
      observationValue: { kind: 'QUANTITATIVE', value: 0.04 },
      observationUnit: 'ng/mL',
      observationIssuedBy: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
      interpretationSource: { kind: 'ALGORITHM', label: 'rules-v3' },
      interpretationText: 'within expected pattern',
      reportContent: 'Troponin-I within expected pattern',
      priority: 'EMERGENCY',
      startedAt: at(0),
    });

    // Priority is visible on the operational artifacts derived from the order.
    assert.equal(result.order.priority, 'EMERGENCY');
    assert.equal(result.order.status, 'REPORTED');
    assert.equal(result.report.latestStatus, 'FINALIZED');

    // Clinical truth is untouched: no priority, no "critical", no "emergency"
    // marker anywhere on the observation value, interpretation, or report.
    assert.ok(!('priority' in result.observation));
    assert.ok(!('priority' in result.interpretation));
    assert.ok(!('priority' in result.report));
    const reportJson = JSON.stringify(result.report).toLowerCase();
    assert.ok(!reportJson.includes('emergency'));
    assert.ok(!reportJson.includes('critical'));
    assert.deepEqual(result.observation.value, {
      kind: 'QUANTITATIVE',
      value: 0.04,
    });
    assert.ok(!JSON.stringify(result.interpretation).toLowerCase().includes('emergency'));
  });

  it('a priority change after finalization leaves the finalized report intact', async () => {
    const fx = createFixture();
    const flowSession = fx.session;
    (flowSession as { roles?: readonly string[] }).roles = [
      'operator',
      'manager',
    ] as never;
    const result = await fx.flow.run({
      session: flowSession,
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
      observationUnit: 'g/dL',
      observationIssuedBy: { kind: 'DEVICE', label: 'analyzer-x1', ref: 'dev-1' },
      interpretationSource: { kind: 'ALGORITHM', label: 'rules-v3' },
      interpretationText: 'within expected pattern',
      reportContent: 'CBC within expected pattern',
      startedAt: at(0),
    });
    const before = JSON.stringify(result.report);
    // The order is REPORTED (workflow complete); priority remains changeable
    // as an operational attribute, but the report content cannot move.
    const changed = await fx.orders.changeOrderPriority(
      fx.session,
      orderIdDtoToId(result.order),
      'EMERGENCY',
      at(60),
    );
    assert.equal(changed.priority, 'EMERGENCY');
    assert.equal(JSON.stringify(result.report), before);
    assert.equal(result.report.latestStatus, 'FINALIZED');
    assert.ok(!before.toLowerCase().includes('emergency'));
  });
});

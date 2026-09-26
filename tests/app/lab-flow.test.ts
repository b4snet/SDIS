/**
 * Application test: the complete deterministic laboratory flow.
 *
 *   Order → Order Item → Specimen → Observation → Interpretation → Report
 *
 * Verified through public DTOs and the audit chain — never through
 * repository internals.
 */

/** Flow session: the flow executes the manager-tier VERIFIED step (Step 28). */
function flowSession(fx: { session: ApplicationSession }): ApplicationSession {
  (fx.session as { roles?: readonly string[] }).roles = ['operator', 'manager'] as never;
  return fx.session;
}

import { describe, it } from 'node:test';
import type { ApplicationSession } from '../../src/app/context';
import assert from 'node:assert/strict';
import { createFixture, T0 } from './helpers';

describe('app: complete laboratory flow', () => {
  it('runs order → specimen → observation → interpretation → report', async () => {
    const fx = createFixture();
    const result = await fx.flow.run({
      session: flowSession(fx),
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
      startedAt: T0,
    });

    assert.equal(result.order.status, 'REPORTED');
    assert.equal(result.specimen.status, 'PROCESSED');
    assert.equal(result.report.latestStatus, 'FINALIZED');
    assert.deepEqual(result.invariants, {
      patientIdentityStable: true,
      clinicalContextStable: true,
      facilityScopeStable: true,
      provenanceDistinctionsPreserved: true,
      reportImmutableAfterFinalization: true,
      causalOrderPreserved: true,
      terminalStateReached: true,
    });

    assert.equal(result.order.patientId, fx.patientId);
    assert.equal(result.specimen.patientId, fx.patientId);
    assert.equal(result.observation.patientId, fx.patientId);
    assert.equal(result.report.patientId, fx.patientId);
    assert.equal(result.observation.issuedByKind, 'DEVICE');
    assert.equal(result.interpretation.sourceKind, 'ALGORITHM');

    const itemId = result.order.items[0]?.id;
    assert.ok(itemId);
    assert.equal(result.specimen.orderItemId, itemId);
    assert.equal(result.observation.orderItemId, itemId);
    assert.equal(result.interpretation.orderItemId, itemId);
  });

  it('emits a complete audit chain for the flow', async () => {
    const fx = createFixture();
    const result = await fx.flow.run({
      session: flowSession(fx),
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD',
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
      observationIssuedBy: { kind: 'DEVICE', label: 'analyzer-x1' },
      interpretationSource: { kind: 'HUMAN', label: 'pathologist review' },
      interpretationText: 'consistent with history',
      reportContent: 'CBC report',
      startedAt: T0,
    });

    const events = fx.audit.list();
    const byObject = (id: string): string[] =>
      events.filter((event) => event.objectId === id).map((event) => event.action);

    assert.ok(byObject(result.order.id).includes('CREATED'));
    assert.ok(byObject(result.specimen.id).includes('CREATED'));
    assert.ok(byObject(result.observation.id).includes('CREATED'));
    assert.ok(byObject(result.interpretation.id).includes('CREATED'));
    assert.ok(byObject(result.report.id).includes('CREATED'));
    assert.ok(byObject(result.report.id).includes('FINALIZED'));

    for (const event of events) {
      assert.ok(event.provenance.actor.id.length > 0);
      assert.equal(event.provenance.timestamp, event.at);
      assert.ok(event.context.organizationId.length > 0);
    }
  });

  it('is deterministic across runs', async () => {
    const scenario = {
      modality: 'LAB' as const,
      testCode: 'CBC',
      codeSystem: 'sdis',
      specimenKind: 'BLOOD' as const,
      observationCode: 'HB',
      observationValue: { kind: 'QUANTITATIVE', value: 13.2 } as const,
      observationIssuedBy: { kind: 'DEVICE' as const, label: 'analyzer-x1' },
      interpretationSource: { kind: 'ALGORITHM' as const, label: 'rules-v3' },
      interpretationText: 'within expected pattern',
      reportContent: 'CBC within expected pattern',
      startedAt: T0,
    };
    const runOnce = async () => {
      const fx = createFixture();
      return fx.flow.run({
        ...scenario,
        session: flowSession(fx),
        patientId: fx.patientId,
        encounterId: fx.encounterId,
      });
    };
    const first = await runOnce();
    const second = await runOnce();

    assert.equal(first.order.status, second.order.status);
    assert.equal(first.order.orderedAt, second.order.orderedAt);
    assert.equal(first.specimen.status, second.specimen.status);
    assert.equal(first.specimen.collectedAt, second.specimen.collectedAt);
    assert.equal(first.observation.at, second.observation.at);
    assert.deepEqual(first.observation.value, second.observation.value);
    assert.equal(first.interpretation.at, second.interpretation.at);
    assert.equal(first.report.latestStatus, second.report.latestStatus);
    assert.deepEqual(first.invariants, second.invariants);
  });
});

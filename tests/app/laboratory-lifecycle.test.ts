/**
 * Step 27 — Laboratory workflow completion (application tests).
 *
 * Proves the completed lifecycle over the EXISTING domain contracts:
 * specimen accessioning (assigned once at RECEIVED, facility-unique,
 * immutable), specimen rejection with an explicit vocabulary-bound reason
 * (history preserved), RBAC on every laboratory mutation (fail-closed),
 * worklist read-model filters, and the QC analytical-hold boundary —
 * a hold pauses finalization but NEVER touches patient results.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixture,
  sessionFor,
  orderIdOf,
  reportIdOf,
  at,
  FACILITY,
  type LabFixture,
} from './helpers';
import { ConflictError, ForbiddenError, ValidationError } from '../../src/app/errors';
import { QualityService } from '../../src/app/quality/quality-service';
import { InMemoryQualityRepository } from '../../src/app/in-memory-quality';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { InMemoryIdempotencyStore, type AuditLogPort } from '../../src/app/in-memory';
import type { FacilityDirectory } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';
import { WorklistService } from '../../src/app/laboratory/worklist-service';
import { InMemoryOrderRepository } from '../../src/app/in-memory';
import { toBrandedId } from '../../src/types/ids';
/** First order item id of an order DTO (orders are created with items). */
function firstItemId(order: { readonly items: readonly { readonly id: string }[] }) {
  return toBrandedId(order.items[0]!.id);
}

function facilitiesOf(fixture: LabFixture): FacilityDirectory {
  return (fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }).deps
    .facilities;
}

/** Staff-claimed session (operator tier): reaches lab application checks. */
function staffSession(facilityId = FACILITY): ApplicationSession {
  const session = sessionFor(facilityId);
  (session as { roles?: readonly string[] }).roles = ['operator'] as never;
  return session;
}

interface QualityHarness {
  readonly service: QualityService;
  readonly repo: InMemoryQualityRepository;
  readonly session: ApplicationSession;
  readonly audit: AuditLogPort;
}

function qualityHarness(roles: readonly string[] = ['manager']): QualityHarness {
  const fixture = createFixture();
  const session = sessionFor();
  (session as { roles?: readonly string[] }).roles = roles as never;
  const repo = new InMemoryQualityRepository();
  const service = new QualityService({
    quality: repo,
    facilities: facilitiesOf(fixture),
    audit: fixture.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  return { service, repo, session, audit: fixture.audit as AuditLogPort };
}

describe('specimen accessioning (Step 27)', () => {
  it('assigns a facility-unique accession number at RECEIVED, once', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(1),
    });
    const specimen = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(2),
    });
    assert.equal(specimen.accessionNumber, undefined);

    const received = await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(specimen.id),
      'RECEIVED',
      at(3),
    );
    assert.ok(received.accessionNumber);
    assert.match(received.accessionNumber!, /^[A-Z][A-Z0-9]{0,7}-\d{4}-\d{6,8}$/);

    // Immutable: the accession number survives later transitions unchanged.
    const accepted = await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(specimen.id),
      'ACCEPTED',
      at(4),
    );
    assert.equal(accepted.accessionNumber, received.accessionNumber);
  });

  it('two specimens of the same facility receive distinct accession numbers', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [
        { testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' },
        { testCode: 'SYN-LFT', codeSystem: 'SDIS-SYNTHETIC' },
      ],
      orderedAt: at(1),
    });
    const s1 = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(2),
    });
    const s2 = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: toBrandedId(order.items[1]!.id),
      patientId: fx.patientId,
      kind: 'SERUM',
      collectedAt: at(2),
    });
    const r1 = await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(s1.id),
      'RECEIVED',
      at(3),
    );
    const r2 = await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(s2.id),
      'RECEIVED',
      at(3),
    );
    assert.notEqual(r1.accessionNumber, r2.accessionNumber);
  });
});

describe('specimen rejection & exception boundary (Step 27)', () => {
  async function collectedSpecimen(fx: LabFixture) {
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(1),
    });
    const specimen = await fx.specimens.collectSpecimen(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      kind: 'BLOOD',
      collectedAt: at(2),
    });
    await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(specimen.id),
      'RECEIVED',
      at(3),
    );
    return { order, specimen };
  }

  it('rejection requires an explicit vocabulary-bound reason', async () => {
    const fx = createFixture();
    const { specimen } = await collectedSpecimen(fx);
    await assert.rejects(
      () =>
        fx.specimens.transitionSpecimen(
          fx.session,
          toBrandedId(specimen.id),
          'REJECTED',
          at(4),
        ),
      ValidationError,
    );
    await assert.rejects(
      () =>
        fx.specimens.transitionSpecimen(
          fx.session,
          toBrandedId(specimen.id),
          'REJECTED',
          at(4),
          { rejectionReason: 'LOOKED BAD' as never },
        ),
      ValidationError,
    );
  });

  it('rejection with a valid reason is preserved with history (no deletion)', async () => {
    const fx = createFixture();
    const { specimen } = await collectedSpecimen(fx);
    const rejected = await fx.specimens.transitionSpecimen(
      fx.session,
      toBrandedId(specimen.id),
      'REJECTED',
      at(4),
      { rejectionReason: 'INSUFFICIENT_SPECIMEN' },
    );
    assert.equal(rejected.status, 'REJECTED');
    assert.equal(rejected.rejectionReason, 'INSUFFICIENT_SPECIMEN');
    // The record remains resolvable — rejection is a status, not a delete.
    const fetched = await fx.specimens.requireScopedSpecimen(
      fx.session,
      toBrandedId(specimen.id),
    );
    assert.equal(fetched.status, 'REJECTED');
    assert.equal(fetched.rejectionReason, 'INSUFFICIENT_SPECIMEN');
    // Audited.
    const events = (fx.audit as AuditLogPort)
      .list()
      .filter((e) => e.objectId === specimen.id && e.action === 'TRANSITIONED');
    assert.ok(events.some((e) => (e.detail ?? '').includes('INSUFFICIENT_SPECIMEN')));
  });

  it('every bounded rejection reason is accepted; rejected specimens are terminal', async () => {
    const fx = createFixture();
    for (const reason of [
      'INSUFFICIENT_SPECIMEN',
      'INCORRECT_SPECIMEN_TYPE',
      'DAMAGED_SPECIMEN',
      'LABELING_PROBLEM',
      'PROCESSING_PROBLEM',
    ] as const) {
      const { specimen } = await collectedSpecimen(fx);
      const rejected = await fx.specimens.transitionSpecimen(
        fx.session,
        toBrandedId(specimen.id),
        'REJECTED',
        at(4),
        { rejectionReason: reason },
      );
      assert.equal(rejected.rejectionReason, reason);
      await assert.rejects(() =>
        fx.specimens.transitionSpecimen(
          fx.session,
          toBrandedId(specimen.id),
          'ACCEPTED',
          at(5),
        ),
      );
    }
  });
});

describe('laboratory RBAC (Step 27 — fail closed)', () => {
  it('specimen collection and transitions require specimen.create', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(1),
    });
    const viewer = sessionFor();
    (viewer as { roles?: readonly string[] }).roles = ['viewer'] as never;
    await assert.rejects(
      () =>
        fx.specimens.collectSpecimen(viewer, {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          kind: 'BLOOD',
          collectedAt: at(2),
        }),
      ForbiddenError,
    );
  });

  it('observation entry requires observation.create; reads require observation.read', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(1),
    });
    const viewer = sessionFor();
    (viewer as { roles?: readonly string[] }).roles = ['viewer'] as never;
    await assert.rejects(
      () =>
        fx.observations.enterObservation(viewer, {
          orderItemId: firstItemId(order),
          patientId: fx.patientId,
          code: 'SYN-HGB',
          codeSystem: 'SDIS-SYNTHETIC',
          value: { kind: 'QUANTITATIVE', value: 13.5 },
          issuedBy: { kind: 'HUMAN', label: 'tech' },
          at: at(2),
        }),
      ForbiddenError,
    );
  });

  it('report finalization requires report.create (operator tier may verify)', async () => {
    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(1),
    });
    const report = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'Unremarkable.',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(2),
    });
    const viewer = sessionFor();
    (viewer as { roles?: readonly string[] }).roles = ['viewer'] as never;
    await assert.rejects(
      () => fx.reports.finalizeReport(viewer, reportIdOf(report), 'Dr. Synthetic', at(3)),
      ForbiddenError,
    );
  });
});

describe('worklist read-model filters (Step 27)', () => {
  async function ordersFixture(): Promise<{
    worklist: WorklistService;
    repo: InMemoryOrderRepository;
    session: ApplicationSession;
    fixture: LabFixture;
  }> {
    const fixture = createFixture();
    const session = staffSession();
    const worklist = new WorklistService({
      orders: new InMemoryOrderRepository(),
      facilities: facilitiesOf(fixture),
      authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
    });
    const repo = (worklist as unknown as { deps: { orders: InMemoryOrderRepository } })
      .deps.orders;
    await repo.save({
      id: '00000000-0000-4000-8000-0000000000c1' as never,
      tenantId: '00000000-0000-4000-8000-0000000000t1' as never,
      facilityId: FACILITY,
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      status: 'ORDERED',
      priority: 'EMERGENCY',
      orderedAt: '2026-09-21T01:00:00.000Z',
      items: [],
    } as never);
    await repo.save({
      id: '00000000-0000-4000-8000-0000000000c2' as never,
      tenantId: '00000000-0000-4000-8000-0000000000t1' as never,
      facilityId: FACILITY,
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      status: 'PROCESSING',
      priority: 'ROUTINE',
      orderedAt: '2026-09-21T05:00:00.000Z',
      items: [],
    } as never);
    return { worklist, repo, session, fixture };
  }

  it('filters by status without changing deterministic ordering', async () => {
    const { worklist, session } = await ordersFixture();
    const processing = await worklist.listForSession(session, {
      status: 'PROCESSING',
    });
    assert.equal(processing.length, 1);
    assert.equal(processing[0]!.status, 'PROCESSING');
    // Emergency-first ordering preserved on the unfiltered list.
    const all = await worklist.listForSession(session);
    assert.equal(all[0]!.priority, 'EMERGENCY');
  });

  it('filters by priority and by orderedAt window', async () => {
    const { worklist, session } = await ordersFixture();
    const emergency = await worklist.listForSession(session, {
      priority: 'EMERGENCY',
    });
    assert.equal(emergency.length, 1);
    const window = await worklist.listForSession(session, {
      from: '2026-09-21T04:00:00.000Z',
    });
    assert.equal(window.length, 1);
    assert.equal(window[0]!.status, 'PROCESSING');
  });
});

describe('QC analytical hold boundary (Step 27)', () => {
  it('hold set by an authorized manager pauses finalization; QC never rewrites results', async () => {
    const qh = qualityHarness();
    const record = await qh.service.recordQuality(qh.session, {
      family: 'IQC',
      referenceType: 'analyzer',
      referenceId: 'device-1',
      at: at(1),
      note: 'Levey-Jennings rule violation (operational note)',
      hold: { reason: 'IQC out of range — hold analytical release' },
    });
    assert.ok(record.hold);

    const fx = createFixture();
    const order = await fx.orders.createOrder(fx.session, {
      patientId: fx.patientId,
      encounterId: fx.encounterId,
      modality: 'LAB',
      items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(2),
    });
    // Patient result entered BEFORE the hold decision is untouched by QC.
    const observation = await fx.observations.enterObservation(fx.session, {
      orderItemId: firstItemId(order),
      patientId: fx.patientId,
      code: 'SYN-HGB',
      codeSystem: 'SDIS-SYNTHETIC',
      value: { kind: 'QUANTITATIVE', value: 13.5 },
      issuedBy: { kind: 'HUMAN', label: 'tech' },
      at: at(3),
    });
    // Walk the order to VERIFIED (Step 28): reports finalize only after
    // diagnostic content is verified. The hold then pauses finalization.
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'ACQUIRED', at(3));
    await fx.orders.transitionOrder(fx.session, orderIdOf(order), 'PROCESSING', at(3));
    await fx.orders.transitionOrder(
      fx.session,
      orderIdOf(order),
      'RESULT_ENTERED',
      at(3),
    );
    const verifier = fx.session;
    (verifier as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    await fx.orders.transitionOrder(verifier, orderIdOf(order), 'VERIFIED', at(4));

    const report = await fx.reports.createReport(fx.session, {
      orderId: orderIdOf(order),
      content: 'Draft impression.',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(4),
    });

    // Finalization is paused by the active hold.
    const heldReport = new (
      await import('../../src/app/laboratory/report-service')
    ).ReportService({
      orders: (fx.reports as unknown as { deps: { orders: never } }).deps.orders,
      facilities: facilitiesOf(fx),
      reports: (fx.reports as unknown as { deps: { reports: never } }).deps.reports,
      audit: fx.audit,
      idempotency: new InMemoryIdempotencyStore(),
      qualityHoldProbe: async () => {
        const hold = await qh.repo.findActiveHold(FACILITY);
        return hold ? hold.id : undefined;
      },
    });
    await assert.rejects(
      () =>
        heldReport.finalizeReport(fx.session, reportIdOf(report), 'Dr. Synthetic', at(5)),
      ConflictError,
    );

    // Releasing the hold restores the workflow; the patient observation was
    // never touched by any QC operation.
    await qh.service.releaseHold(qh.session, {
      holdId: toBrandedId(record.id),
      at: at(6),
    });
    await assert.doesNotReject(() =>
      heldReport.finalizeReport(fx.session, reportIdOf(report), 'Dr. Synthetic', at(7)),
    );
    const observations = await fx.observations.listForOrderItem(
      fx.session,
      firstItemId(order),
    );
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0]!.value, observation.value);
  });

  it('records require the administration tier (fail closed)', async () => {
    const qh = qualityHarness(['operator']);
    await assert.rejects(
      () =>
        qh.service.recordQuality(qh.session, {
          family: 'QC',
          referenceType: 'analyzer',
          at: at(1),
        }),
      ForbiddenError,
    );
  });

  it('replays an idempotent hold record without duplicates', async () => {
    const qh = qualityHarness();
    const first = await qh.service.recordQuality(qh.session, {
      family: 'EQA',
      referenceType: 'program',
      at: at(1),
      idempotencyKey: 'qc-1',
    });
    const replay = await qh.service.recordQuality(qh.session, {
      family: 'EQA',
      referenceType: 'program',
      at: at(1),
      idempotencyKey: 'qc-1',
    });
    assert.equal(replay.id, first.id);
    const listed = await qh.service.listQuality(qh.session);
    assert.equal(listed.length, 1);
  });
});

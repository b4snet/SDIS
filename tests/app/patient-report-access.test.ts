/**
 * Patient report access — application/security tests (Step 22).
 *
 * Proves the ownership boundary end-to-end over the EXISTING canonical
 * report lifecycle: ownership binding, finalization visibility (draft
 * invisible, final visible, amendment chain correct), the patient-safe DTO
 * shape, the full IDOR/security matrix (cross-patient, cross-facility,
 * cross-tenant, forged ids, unauthenticated, staff principal), audit of
 * access events, and clinical-safety invariants (patient access mutates
 * nothing and changes no provenance).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixture,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  ORG,
  OTHER_ORG,
  PATIENT_ID,
  OTHER_PATIENT_ID,
  ENCOUNTER_ID,
  orderIdOf,
  reportIdOf,
  at,
  type LabFixture,
} from './helpers';
import type { ApplicationSession } from '../../src/app/context';
import {
  AuthorizationService,
  claimedRoleResolver,
  ROLES,
} from '../../src/app/authz/rbac';
import { InMemoryPatientPrincipalRegistry } from '../../src/app/in-memory';
import {
  PatientReportAccessService,
  isPatientSession,
} from '../../src/app/patient-access/report-access-service';
import type { FacilityDirectory } from '../../src/app/ports';

/** A patient session for the given canonical patient (binding applied). */
function patientSession(
  userId: string,
  organizationId = ORG,
  facilityId = FACILITY,
): ApplicationSession {
  return {
    actor: { kind: 'PATIENT', id: userId },
    userId,
    organizationId,
    facilityId,
    roles: [ROLES.PATIENT],
  };
}

/** Fully wired access service over a fresh lab fixture + patient bindings. */
interface AccessFixture {
  readonly service: PatientReportAccessService;
  readonly lab: LabFixture;
  readonly bindings: InMemoryPatientPrincipalRegistry;
  readonly facilities: FacilityDirectory;
  readonly session: ApplicationSession;
  /** Staff session driving the lab stack (RBAC-authorized, Step 27). */
  readonly staff: ApplicationSession;
}

function createAccessFixture(): AccessFixture {
  const session = patientSession('patient-user-1');
  // The lab stack enforces staff RBAC (Step 27); the fixture's operator
  // claims would be wrong for a PATIENT session, so the patient session is
  // used only for patient-facing calls and a staff session drives the lab
  // side (order/report creation through the canonical services).
  const staff = sessionFor();
  // Manager tier (Step 28): the amendment test drives the manager-gated
  // amendment boundary; result entry stays within the operator tier.
  (staff as { roles?: readonly string[] }).roles = [
    'manager',
    'operator',
    'viewer',
  ] as never;
  const lab = createFixture(staff);
  const facilities = (
    lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const bindings = new InMemoryPatientPrincipalRegistry();
  bindings.bind('patient-user-1', PATIENT_ID);
  const service = new PatientReportAccessService({
    principalRegistry: bindings,
    reports: (lab.reports as unknown as { deps: { reports: never } }).deps.reports,
    facilities,
    audit: lab.audit,
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  return { service, lab, bindings, facilities, session, staff };
}

/** Drives the canonical flow to a FINALIZED report for the fixture patient. */
async function finalizedReport(
  fixture: AccessFixture,
  options: { readonly priority?: string } = {},
): Promise<{ reportId: string; orderId: string }> {
  const order = await fixture.lab.orders.createOrder(fixture.staff, {
    patientId: PATIENT_ID,
    encounterId: ENCOUNTER_ID,
    modality: 'LAB',
    items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
    orderedAt: at(10),
  });
  void options;
  // Step-28 governance: the order content is VERIFIED (manager tier) before
  // the report may finalize.
  for (const [i, to] of (
    ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const
  ).entries()) {
    await fixture.lab.orders.transitionOrder(
      fixture.staff,
      orderIdOf(order),
      to,
      at(11 + i),
    );
  }
  await fixture.lab.orders.transitionOrder(
    fixture.staff,
    orderIdOf(order),
    'VERIFIED',
    at(15),
  );
  const report = await fixture.lab.reports.createReport(fixture.staff, {
    orderId: orderIdOf(order),
    content: 'Synthetic final report content',
    authoredByRef: 'Dr. Synthetic',
    authoredAt: at(20),
  });
  await fixture.lab.reports.finalizeReport(
    fixture.staff,
    reportIdOf(report),
    'Dr. Synthetic',
    at(30),
  );
  return { reportId: report.id, orderId: order.id };
}

describe('patient access: principal & ownership', () => {
  it('resolves ownership only through the server-side binding (never client ids)', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);

    const view = await fixture.service.getMyReport(fixture.session, reportId as never);
    assert.equal(view.reportId, reportId);

    // A principal with NO binding owns nothing even for a valid report id.
    fixture.bindings.bind('patient-user-2', OTHER_PATIENT_ID);
    const stranger = patientSession('patient-user-2');
    await assert.rejects(
      fixture.service.getMyReport(stranger, reportId as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });

  it('rejects non-patient principals (staff USER actor) before any resource check', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    const staff = sessionFor(); // USER actor, staff roles
    await assert.rejects(
      fixture.service.getMyReport(staff, reportId as never),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
    await assert.rejects(
      fixture.service.listMyReports(staff),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });

  it('rejects a PATIENT actor without the patient role claim (fail closed)', async () => {
    const fixture = createAccessFixture();
    const noRole: ApplicationSession = {
      ...patientSession('patient-user-1'),
      roles: [],
    };
    await assert.rejects(
      fixture.service.listMyReports(noRole),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });

  it('rejects unauthenticated and unbound sessions', async () => {
    const fixture = createAccessFixture();
    await assert.rejects(
      fixture.service.listMyReports(undefined),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
    // PATIENT actor with a session but no binding → NOT_FOUND (owns nothing).
    const unbound = patientSession('patient-user-nobody');
    await assert.rejects(
      fixture.service.listMyReports(unbound),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });

  it('isPatientSession distinguishes actor kinds (no staff/session bleed)', () => {
    assert.ok(isPatientSession(patientSession('p1')));
    assert.ok(!isPatientSession(sessionFor()));
    assert.ok(!isPatientSession(undefined));
  });
});

describe('patient access: visibility & lifecycle', () => {
  it('shows a FINAL report and hides DRAFT reports entirely', async () => {
    const fixture = createAccessFixture();
    await finalizedReport(fixture);

    // A second, still-draft report for the same patient must be invisible.
    const order = await fixture.lab.orders.createOrder(fixture.staff, {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-DRAFT', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(11),
    });
    await fixture.lab.reports.createReport(fixture.staff, {
      orderId: orderIdOf(order),
      content: 'Draft content never shown to patients',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(21),
    });

    const views = await fixture.service.listMyReports(fixture.session);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.current.status, 'FINALIZED');
    assert.equal(views[0]?.versions.length, 1);
    assert.ok(!JSON.stringify(views).includes('never shown to patients'));
  });

  it('exposes only FINALIZED versions of an amended report (no draft head)', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    // Amendment v2 exists as a DRAFT head — must NOT appear.
    await fixture.lab.reports.amendReport(fixture.staff, {
      reportId: reportId as never,
      content: 'Amended draft content (not yet finalized)',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(40),
      amendmentReason: 'REPORT_CORRECTION',
    });

    const view = await fixture.service.getMyReport(fixture.session, reportId as never);
    assert.equal(view.versions.length, 1);
    assert.equal(view.latestVisibleVersion, 1);
    assert.ok(!JSON.stringify(view).includes('not yet finalized'));

    // Finalizing the amendment makes v2 visible with the supersession chain.
    await fixture.lab.reports.finalizeReport(
      fixture.staff,
      reportId as never,
      'Dr. Synthetic',
      at(50),
    );
    const amended = await fixture.service.getMyReport(fixture.session, reportId as never);
    assert.equal(amended.versions.length, 2);
    assert.equal(amended.current.version, 2);
    assert.equal(amended.current.supersedesVersion, 1);
    assert.equal(amended.current.status, 'FINALIZED');
  });

  it('returns the patient-safe DTO shape only (no internal/staff fields)', async () => {
    const fixture = createAccessFixture();
    const { reportId, orderId } = await finalizedReport(fixture);
    const view = await fixture.service.getMyReport(fixture.session, reportId as never);

    assert.deepEqual(Object.keys(view).sort(), [
      'current',
      'facilityId',
      'latestVisibleVersion',
      'orderId',
      'reportId',
      'versions',
    ]);
    assert.equal(view.reportId, reportId);
    assert.equal(view.orderId, orderId);
    const version = view.current;
    assert.deepEqual(Object.keys(version).sort(), [
      'content',
      'finalizedAt',
      'status',
      'version',
    ]);
    assert.equal(version.content, 'Synthetic final report content');
    // No provenance/author/staff leakage anywhere in the serialized view.
    const serialized = JSON.stringify(view);
    assert.ok(!serialized.includes('authoredByRef'));
    assert.ok(!serialized.includes('Dr. Synthetic'));
    assert.ok(!serialized.includes('provenance'));
  });
});

describe('patient access: security matrix', () => {
  it('denies another patient in the SAME facility (IDOR via report id)', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    fixture.bindings.bind('patient-user-2', OTHER_PATIENT_ID);
    const intruder = patientSession('patient-user-2');
    await assert.rejects(
      fixture.service.getMyReport(intruder, reportId as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
    // And the intruder's list is empty, not an error (their own scope).
    assert.deepEqual(await fixture.service.listMyReports(intruder), []);
  });

  it('denies the SAME patient identity from another facility', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    const otherFacilitySession = patientSession('patient-user-1', ORG, OTHER_FACILITY);
    await assert.rejects(
      fixture.service.getMyReport(otherFacilitySession, reportId as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });

  it('denies a forged tenant even for the owning patient', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    const forgedTenant = patientSession('patient-user-1', OTHER_ORG, FACILITY);
    await assert.rejects(
      fixture.service.getMyReport(forgedTenant, reportId as never),
      (error: { code?: string }) => error.code === 'SCOPE_MISMATCH',
    );
  });

  it('treats unknown report ids, foreign ids, and draft ids identically (404)', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);

    // Draft report id → same contract as foreign/unknown (no existence leak).
    const draftOrder = await fixture.lab.orders.createOrder(fixture.staff, {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-HIDDEN', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(12),
    });
    const draftReport = await fixture.lab.reports.createReport(fixture.staff, {
      orderId: orderIdOf(draftOrder),
      content: 'unfinalized',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(22),
    });
    const codes = new Set<string>();
    for (const candidate of [
      reportId, // owned + finalized (control)
      draftReport.id, // owned + draft
      '00000000-0000-4000-8000-00000000dead', // unknown
    ]) {
      try {
        const result = await fixture.service.getMyReport(
          fixture.session,
          candidate as never,
        );
        codes.add(result ? 'OK' : 'EMPTY');
      } catch (error) {
        codes.add((error as { code?: string }).code ?? 'UNKNOWN');
      }
    }
    assert.deepEqual([...codes].sort(), ['NOT_FOUND', 'OK']);
  });
});

describe('patient access: audit & clinical safety', () => {
  it('audits access events without logging report content', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    const before = fixture.lab.audit.list().length;
    await fixture.service.getMyReport(fixture.session, reportId as never);
    const events = fixture.lab.audit.list().slice(before);
    assert.equal(events.length, 1);
    const access = events[0];
    assert.ok(access, 'exactly one access audit event expected');
    assert.equal(access.action, 'VERIFIED');
    assert.equal(access.objectType, 'patient-report-access');
    assert.equal(access.provenance.actor.kind, 'PATIENT');
    assert.ok(!JSON.stringify(events).includes('Synthetic final report content'));
  });

  it('read-only: access does not mutate reports, versions, or provenance', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    const canonicalBefore = JSON.stringify(
      fixture.lab.audit
        .list()
        .filter((event) => event.objectType === 'diagnostic-report'),
    );
    await fixture.service.getMyReport(fixture.session, reportId as never);
    await fixture.service.listMyReports(fixture.session);

    // The report content itself is unchanged (read through the canonical store).
    const view = await fixture.service.getMyReport(fixture.session, reportId as never, {
      auditAccess: false,
    });
    assert.equal(view.current.content, 'Synthetic final report content');
    // No clinical-provenance mutation: only the access event was appended.
    const reportEvents = fixture.lab.audit
      .list()
      .filter(
        (event: { readonly objectType?: string }) =>
          event.objectType === 'diagnostic-report',
      );
    assert.equal(JSON.stringify(reportEvents), canonicalBefore);
  });

  it('denied access attempts are not silent and mutate nothing', async () => {
    const fixture = createAccessFixture();
    const { reportId } = await finalizedReport(fixture);
    fixture.bindings.bind('patient-user-2', OTHER_PATIENT_ID);
    const before = fixture.lab.audit.list().length;
    await assert.rejects(
      fixture.service.getMyReport(patientSession('patient-user-2'), reportId as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
    assert.equal(fixture.lab.audit.list().length, before);
  });
});

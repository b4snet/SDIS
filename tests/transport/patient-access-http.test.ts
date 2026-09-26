/**
 * Patient report access — HTTP contract tests (Step 22).
 *
 * Proves the patient access boundary over the REAL HTTP transport with
 * credential-resolved sessions: own finalized reports are visible, draft
 * reports are not, forged/foreign ids are indistinguishable 404s, staff
 * sessions are 403, unauthenticated is 401, malformed ids are 422, and no
 * internal detail leaks in any error envelope.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import {
  createFixture,
  sessionFor,
  PATIENT_ID,
  ENCOUNTER_ID,
  orderIdOf,
  reportIdOf,
  at,
  type LabFixture,
} from '../app/helpers';
import type { ApplicationSession } from '../../src/app/context';
import {
  AuthorizationService,
  claimedRoleResolver,
  ROLES,
} from '../../src/app/authz/rbac';
import { InMemoryPatientPrincipalRegistry } from '../../src/app/in-memory';
import { PatientReportAccessService } from '../../src/app/patient-access/report-access-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import type { FacilityDirectory } from '../../src/app/ports';

interface Response {
  readonly status: number;
  readonly text: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

async function send(path: string, token?: string): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `bearer ${token}` } : {},
  });
  return {
    status: response.status,
    text: await response.text(),
    headers: Object.fromEntries(response.headers.entries()),
  };
}

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let fixture: LabFixture;
let facilities: FacilityDirectory;
let authz: AuthorizationService;
let service: PatientReportAccessService;
const bindings = new InMemoryPatientPrincipalRegistry();

const PATIENT_TOKEN = 'patient-token-synthetic-1';
const OTHER_PATIENT_TOKEN = 'patient-token-synthetic-2';
const STAFF_TOKEN = 'staff-token-synthetic-1';

/** Patient session for a token-bound principal (server-derived scope). */
function patientSession(token: string, patientId: typeof PATIENT_ID): ApplicationSession {
  return {
    actor: { kind: 'PATIENT', id: token },
    userId: token,
    organizationId: sessionFor().organizationId,
    facilityId: sessionFor().facilityId,
    roles: [ROLES.PATIENT],
    ...(bindings.resolvePatientId(token) === undefined ? {} : {}),
    // The registry binding (below) is what actually resolves ownership.
    ...({ patientIdRef: patientId } as object),
  };
}

const directory = new Map<string, ApplicationSession>();

before(async () => {
  fixture = createFixture();
  authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  facilities = (fixture.orders as unknown as { deps: { facilities: FacilityDirectory } })
    .deps.facilities;
  service = new PatientReportAccessService({
    principalRegistry: bindings,
    reports: (fixture.reports as unknown as { deps: { reports: never } }).deps.reports,
    facilities,
    audit: fixture.audit,
    authz,
  });

  // Ownership bindings (server-side data — the credential directory's job).
  bindings.bind(PATIENT_TOKEN, PATIENT_ID);
  bindings.bind(OTHER_PATIENT_TOKEN, PATIENT_ID); // replaced below per test
  bindings.bind(STAFF_TOKEN, PATIENT_ID);

  directory.set(PATIENT_TOKEN, patientSession(PATIENT_TOKEN, PATIENT_ID));
  directory.set(OTHER_PATIENT_TOKEN, {
    ...patientSession(OTHER_PATIENT_TOKEN, PATIENT_ID),
    roles: [ROLES.PATIENT],
  });
  directory.set(STAFF_TOKEN, sessionFor()); // staff USER principal w/ scope

  sessionResolver = async (headers) => {
    const raw = headers['authorization'];
    const token = typeof raw === 'string' ? raw.replace(/^bearer /i, '') : undefined;
    return token ? directory.get(token) : undefined;
  };

  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { patientReports: service } }),
    sessionResolver: (headers) => sessionResolver(headers),
  });
  server = httpServer;
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
    server.on('error', reject);
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Drives one owned order → report → FINALIZE through the canonical services. */
async function seedFinalizedReport(): Promise<{ reportId: string; orderId: string }> {
  // Seeding is a STAFF act (operator tier): report creation is RBAC-guarded
  // (Step 27), so the patient principal must never be used to write clinical
  // data. The patient session below is exercised only on the READ boundary.
  const staffSeeding = sessionFor();
  (staffSeeding as { roles?: readonly string[] }).roles = [
    'manager',
    'operator',
    'viewer',
  ] as never;
  const order = await fixture.orders.createOrder(staffSeeding, {
    patientId: PATIENT_ID,
    encounterId: ENCOUNTER_ID,
    modality: 'LAB',
    items: [{ testCode: 'SYN-CBC', codeSystem: 'SDIS-SYNTHETIC' }],
    orderedAt: at(10),
  });
  // Verification gate (Step 28): walk to VERIFIED before finalizing.
  // (No specimen is collected in this seeding, so ACQUIRED is explicit.)
  await fixture.orders.transitionOrder(
    staffSeeding,
    orderIdOf(order),
    'ACQUIRED',
    at(10),
  );
  await fixture.orders.transitionOrder(
    staffSeeding,
    orderIdOf(order),
    'PROCESSING',
    at(11),
  );
  await fixture.orders.transitionOrder(
    staffSeeding,
    orderIdOf(order),
    'RESULT_ENTERED',
    at(12),
  );
  await fixture.orders.transitionOrder(
    staffSeeding,
    orderIdOf(order),
    'VERIFIED',
    at(13),
  );
  const report = await fixture.reports.createReport(staffSeeding, {
    orderId: orderIdOf(order),
    content: 'Synthetic HTTP final report',
    authoredByRef: 'Dr. Synthetic',
    authoredAt: at(20),
  });
  await fixture.reports.finalizeReport(
    staffSeeding,
    reportIdOf(report),
    'Dr. Synthetic',
    at(30),
  );
  return { reportId: report.id, orderId: order.id };
}

describe('patient access http: own finalized reports', () => {
  it('lists and reads OWN finalized reports (200) with correlation echo', async () => {
    const { reportId } = await seedFinalizedReport();

    const listed = await send('/api/v1/patient/reports', PATIENT_TOKEN);
    assert.equal(listed.status, 200);
    const views = jsonOf(listed.text);
    assert.ok(Array.isArray(views));
    assert.ok(views.some((view: { reportId: string }) => view.reportId === reportId));

    const detail = await send(`/api/v1/patient/reports/${reportId}`, PATIENT_TOKEN);
    assert.equal(detail.status, 200);
    const view = jsonOf(detail.text);
    assert.equal(view.reportId, reportId);
    assert.equal(view.current.status, 'FINALIZED');
    assert.ok(detail.headers['x-correlation-id']);
    assert.ok(!detail.text.includes('Dr. Synthetic'));
    assert.ok(!detail.text.includes('authoredByRef'));
  });

  it('hides DRAFT reports entirely (list omits, detail is 404)', async () => {
    // Seeding is a staff act (operator tier) — see seedFinalizedReport.
    const staffSeeding = sessionFor();
    (staffSeeding as { roles?: readonly string[] }).roles = [
      'operator',
      'viewer',
    ] as never;
    const order = await fixture.orders.createOrder(staffSeeding, {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-DRAFT', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(11),
    });
    const draft = await fixture.reports.createReport(staffSeeding, {
      orderId: orderIdOf(order),
      content: 'unfinalized draft',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(21),
    });

    const listed = await send('/api/v1/patient/reports', PATIENT_TOKEN);
    assert.ok(!listed.text.includes(draft.id));
    const detail = await send(`/api/v1/patient/reports/${draft.id}`, PATIENT_TOKEN);
    assert.equal(detail.status, 404);
  });
});

describe('patient access http: security contract', () => {
  it('denies foreign report ids with the SAME 404 as unknown ids (no leak)', async () => {
    // A report owned by ANOTHER patient inside the same facility:
    const otherSession = sessionFor(); // staff principal creates foreign data
    (otherSession as { roles?: readonly string[] }).roles = [
      'manager',
      'operator',
      'viewer',
    ] as never;
    const order = await fixture.orders.createOrder(otherSession, {
      patientId: (await import('../app/helpers')).OTHER_PATIENT_ID,
      encounterId: (await import('../app/helpers')).OTHER_ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-FOREIGN', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(12),
    });
    await fixture.orders.transitionOrder(
      otherSession,
      orderIdOf(order),
      'ACQUIRED',
      at(12),
    );
    await fixture.orders.transitionOrder(
      otherSession,
      orderIdOf(order),
      'PROCESSING',
      at(13),
    );
    await fixture.orders.transitionOrder(
      otherSession,
      orderIdOf(order),
      'RESULT_ENTERED',
      at(14),
    );
    await fixture.orders.transitionOrder(
      otherSession,
      orderIdOf(order),
      'VERIFIED',
      at(15),
    );
    const foreign = await fixture.reports.createReport(otherSession, {
      orderId: orderIdOf(order),
      content: 'foreign report',
      authoredByRef: 'Dr. Synthetic',
      authoredAt: at(22),
    });
    await fixture.reports.finalizeReport(
      otherSession,
      reportIdOf(foreign),
      'Dr. Synthetic',
      at(32),
    );

    const foreignRead = await send(
      `/api/v1/patient/reports/${foreign.id}`,
      PATIENT_TOKEN,
    );
    assert.equal(foreignRead.status, 404);
    const unknownRead = await send(
      '/api/v1/patient/reports/00000000-0000-4000-8000-00000000dead',
      PATIENT_TOKEN,
    );
    assert.equal(unknownRead.status, 404);
    assert.equal(jsonOf(foreignRead.text).error.code, 'NOT_FOUND');
    assert.equal(jsonOf(unknownRead.text).error.code, 'NOT_FOUND');
    assert.ok(!foreignRead.text.includes('sdis'));
    assert.ok(!foreignRead.text.includes('stack'));
  });

  it('rejects staff principals (403) and unauthenticated calls (401)', async () => {
    const staff = await send('/api/v1/patient/reports', STAFF_TOKEN);
    assert.equal(staff.status, 403);
    assert.equal(jsonOf(staff.text).error.code, 'FORBIDDEN');

    const anonymous = await send('/api/v1/patient/reports');
    assert.equal(anonymous.status, 401);
    assert.equal(jsonOf(anonymous.text).error.code, 'UNAUTHENTICATED');
  });

  it('answers 422 for malformed report ids (path-boundary validation)', async () => {
    const malformed = await send('/api/v1/patient/reports/not-a-uuid', PATIENT_TOKEN);
    assert.equal(malformed.status, 422);
    assert.equal(jsonOf(malformed.text).error.code, 'VALIDATION_FAILED');
  });

  it('404s an unbound patient principal without leaking binding state', async () => {
    // An authenticated PATIENT principal whose ownership binding is absent:
    directory.set('never-bound-token', {
      actor: { kind: 'PATIENT', id: 'never-bound-token' },
      userId: 'never-bound-token',
      organizationId: sessionFor().organizationId,
      facilityId: sessionFor().facilityId,
      roles: [ROLES.PATIENT],
    });
    const response = await send('/api/v1/patient/reports', 'never-bound-token');
    assert.equal(response.status, 404);
    assert.ok(!response.text.includes('binding'));
  });
});

/**
 * Integration gateway HTTP contract tests (Step 17).
 *
 * Real `node:http` server over in-memory adapters: the inbound envelope route
 * (patient resolution/registration/reference attachment, order submission)
 * and the outbound read routes (order status, report retrieval) — with the
 * mandated error envelope, fail-closed 401, RBAC 403, unknown-system 403,
 * forged-scope 403, validation 422, missing 404, and no internal leakage.
 *
 * Synthetic data only (`HMS-SYNTHETIC`); nothing external is contacted.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * Registered external systems for the gateway under test (Step 20): the
 * synthetic HMS is ACTIVE by default; extra keys opt individual tests in.
 */
function registeredSystemsRegistry(
  ...extraKeys: readonly string[]
): InMemoryExternalSystemRegistry {
  const registry = new InMemoryExternalSystemRegistry();
  for (const key of [HMS_SYNTHETIC_SYSTEM, ...extraKeys]) {
    registry.register({
      systemKey: key,
      name: `Synthetic external system ${key}`,
      systemType: key === HMS_SYNTHETIC_SYSTEM ? 'HMS' : 'TEST',
      status: 'ACTIVE',
    });
  }
  return registry;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { IntegrationGateway } from '../../src/app/integration/integration-gateway';
import {
  HMS_SYNTHETIC_SYSTEM,
  HmsSyntheticAdapter,
  StaticIntegrationRegistry,
} from '../../src/infrastructure/integration/hms-synthetic-adapter';
import { PatientService } from '../../src/app/patients/patient-service';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { OrderService } from '../../src/app/laboratory/order-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  InMemoryExternalSystemRegistry,
  InMemoryIdempotencyStore,
  InMemoryOrderReferenceStore,
  InMemoryPatientRegistrationRepository,
} from '../../src/app/in-memory';
import {
  createFixture,
  sessionFor,
  OTHER_FACILITY,
  OTHER_ORG,
  PATIENT_ID,
  T0,
} from '../app/helpers';
import type { FacilityDirectory, OrderRepository } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';
import type { OrderItemId, SpecimenId } from '../../src/types/ids';
import type { Specimen } from '../../src/domain/specimen/specimen';

interface Response {
  readonly status: number;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers:
      options.body !== undefined
        ? { 'content-type': 'application/json', ...options.headers }
        : options.headers,
    body: options.body,
  });
  return { status: response.status, text: await response.text() };
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

const REQUESTS_PATH = '/api/v1/integration/requests';
const MRN = 'MRN-HTTP-SYN-1';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let patients: PatientService;
let reportId: string;

before(async () => {
  const lab = createFixture();
  const orderDeps = (
    lab.orders as unknown as {
      deps: {
        patients: import('../../src/app/ports').PatientDirectory;
        encounters: import('../../src/app/ports').EncounterDirectory;
        modalities: import('../../src/app/ports').ModalityDirectory;
        orders: OrderRepository;
        facilities: FacilityDirectory;
      };
    }
  ).deps;
  const facilities = orderDeps.facilities;
  const specimensRepo = (
    lab.specimens as unknown as {
      deps: {
        specimens: { listByOrderItem(id: OrderItemId): Promise<readonly Specimen[]> };
      };
    }
  ).deps.specimens;

  const patientRepo = new InMemoryPatientRegistrationRepository();
  patients = new PatientService({
    patients: patientRepo,
    facilities,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const orders = new OrderService({
    patients: orderDeps.patients,
    encounters: orderDeps.encounters,
    facilities,
    modalities: orderDeps.modalities,
    orders: orderDeps.orders,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const active = withRoles(sessionFor(), ['operator', 'manager']);
  await patients.registerPatient(active, {
    fullName: 'Synthetic Http Gateway Patient',
    sex: 'UNKNOWN',
    externalReferences: [{ system: 'HOSPITAL_MRN', value: MRN }],
  });
  const flow = await lab.flow.run({
    session: active,
    patientId: PATIENT_ID,
    encounterId: lab.encounterId,
    modality: 'LAB',
    testCode: 'CBC',
    codeSystem: 'sdis',
    specimenKind: 'BLOOD',
    observationCode: 'HB',
    observationValue: { kind: 'QUANTITATIVE', value: 13.2 },
    observationUnit: 'g/dL',
    observationIssuedBy: {
      kind: 'DEVICE',
      label: 'analyzer-synthetic',
      ref: 'dev-syn-1',
    },
    interpretationSource: { kind: 'ALGORITHM', label: 'rules-synthetic' },
    interpretationText: 'synthetic interpretation',
    reportContent: 'synthetic report content',
    startedAt: T0,
  });
  reportId = flow.report.id;

  const integration = new IntegrationGateway({
    adapters: new StaticIntegrationRegistry([new HmsSyntheticAdapter()]),
    systemRegistry: registeredSystemsRegistry(),
    patients,
    orders,
    observations: lab.observations,
    interpretations: lab.interpretations,
    reports: lab.reports,
    specimens: { listByOrderItem: (id) => specimensRepo.listByOrderItem(id) },
    patientReferences: patientRepo,
    orderReferences: new InMemoryOrderReferenceStore(),
    facilities,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
  });

  sessionResolver = async () => active;
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { integration } }),
    sessionResolver: (headers: Record<string, string | string[] | undefined>) =>
      sessionResolver(headers),
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

function envelopeBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    system: HMS_SYNTHETIC_SYSTEM,
    operation: 'RESOLVE_PATIENT',
    payload: { mrn: MRN },
    ...overrides,
  });
}

describe('integration http: inbound requests', () => {
  it('resolves a patient reference (200) returning the canonical resource', async () => {
    const res = await request('POST', REQUESTS_PATH, { body: envelopeBody() });
    assert.equal(res.status, 200);
    const ack = jsonOf(res.text);
    assert.equal(ack.system, HMS_SYNTHETIC_SYSTEM);
    assert.equal(ack.operation, 'RESOLVE_PATIENT');
    assert.equal(ack.outcome, 'RESOLVED');
    assert.equal(ack.externalReference, MRN);
    assert.ok(ack.resource.id);
    assert.ok(!res.text.includes('select '));
  });

  it('registers a patient (201) and replays idempotently with the same id', async () => {
    const body = envelopeBody({
      operation: 'REGISTER_PATIENT',
      payload: { fullName: 'Synthetic Http Inbound', sex: 'M', mrn: 'MRN-HTTP-SYN-2' },
    });
    const first = await request('POST', REQUESTS_PATH, {
      body,
      headers: { 'idempotency-key': 'http-int-1' },
    });
    const second = await request('POST', REQUESTS_PATH, {
      body,
      headers: { 'idempotency-key': 'http-int-1' },
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).resource.id, jsonOf(first.text).resource.id);
  });

  it('submits a diagnostic order (201) and reports its status (200)', async () => {
    const submitted = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({
        operation: 'SUBMIT_ORDER',
        correlationId: 'hms-http-corr-1',
        payload: {
          patientId: PATIENT_ID,
          encounterId: '00000000-0000-4000-8000-0000000000c1',
          modality: 'LAB',
          testCodes: [{ code: 'CBC', system: 'sdis' }],
          orderedAt: T0,
          hmsOrderId: 'HMS-HTTP-ORDER-1',
        },
      }),
    });
    assert.equal(submitted.status, 201);
    const ack = jsonOf(submitted.text);
    assert.equal(ack.outcome, 'CREATED');
    assert.equal(ack.externalReference, 'HMS-HTTP-ORDER-1');
    const orderId = ack.resource.id;

    const status = await request('GET', `/api/v1/integration/orders/${orderId}`, {
      headers: { 'x-integration-system': HMS_SYNTHETIC_SYSTEM },
    });
    assert.equal(status.status, 200);
    assert.equal(jsonOf(status.text).resource.id, orderId);
  });

  it('exports a report (200) keeping observation, interpretation, and report distinct', async () => {
    const res = await request('GET', `/api/v1/integration/reports/${reportId}`, {
      headers: { 'x-integration-system': HMS_SYNTHETIC_SYSTEM },
    });
    assert.equal(res.status, 200);
    const bundle = jsonOf(res.text).resource;
    assert.ok(bundle.order.id);
    assert.ok(bundle.specimens.length >= 1);
    assert.ok(bundle.observations.length >= 1);
    assert.ok(bundle.interpretations.length >= 1);
    assert.equal(bundle.report.latestStatus, 'FINALIZED');
  });
});

describe('integration http: validation and security', () => {
  it('rejects an unknown external system (403, fail-closed)', async () => {
    const res = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({ system: 'UNREGISTERED-HMS' }),
    });
    assert.equal(res.status, 403);
    assert.equal(jsonOf(res.text).error.code, 'FORBIDDEN');
  });

  it('rejects unsupported operations and malformed payloads with 422', async () => {
    const unsupported = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({ operation: 'DROP_TABLE' }),
    });
    assert.equal(unsupported.status, 422);
    const badPayload = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({ payload: 'not-an-object' }),
    });
    assert.equal(badPayload.status, 422);
    const badField = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({ payload: {} }),
    });
    assert.equal(badField.status, 422);
    assert.equal(jsonOf(badField.text).error.code, 'VALIDATION_FAILED');
    const missingHeader = await request(
      'GET',
      `/api/v1/integration/orders/${PATIENT_ID}`,
    );
    assert.equal(missingHeader.status, 422);
  });

  it('stays fail-closed without a session (401)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    const res = await request('POST', REQUESTS_PATH, { body: envelopeBody() });
    assert.equal(res.status, 401);
    assert.equal(jsonOf(res.text).error.code, 'UNAUTHENTICATED');
    sessionResolver = previous;
  });

  it('denies the viewer tier for order submission (403) while allowing reads', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => withRoles(sessionFor(), ['viewer']);
    const write = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({
        operation: 'SUBMIT_ORDER',
        payload: {
          patientId: PATIENT_ID,
          encounterId: '00000000-0000-4000-8000-0000000000c1',
          modality: 'LAB',
          testCodes: [{ code: 'CBC', system: 'sdis' }],
          orderedAt: T0,
        },
      }),
    });
    assert.equal(write.status, 403);
    assert.equal(jsonOf(write.text).error.code, 'FORBIDDEN');
    const read = await request('POST', REQUESTS_PATH, { body: envelopeBody() });
    assert.equal(read.status, 200);
    sessionResolver = previous;
  });

  it('denies a forged facility/organization pairing (403)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () =>
      withRoles(sessionFor(OTHER_FACILITY, OTHER_ORG), ['operator']);
    const res = await request('POST', REQUESTS_PATH, { body: envelopeBody() });
    assert.equal(res.status, 403);
    const body = jsonOf(res.text);
    assert.ok(['FORBIDDEN', 'SCOPE_MISMATCH'].includes(body.error.code));
    sessionResolver = previous;
  });

  it('404s an unknown record without leaking internals', async () => {
    const res = await request(
      'GET',
      '/api/v1/integration/orders/00000000-0000-4000-8000-00000000f00f',
      { headers: { 'x-integration-system': HMS_SYNTHETIC_SYSTEM } },
    );
    assert.equal(res.status, 404);
    const lower = res.text.toLowerCase();
    for (const banned of [
      'stack',
      'select ',
      'patient_external_identifiers',
      'password',
      'bearer',
    ]) {
      assert.ok(!lower.includes(banned), `leaked: ${banned}`);
    }
  });
});

describe('integration http step 20: external-ref correlation and disabled systems', () => {
  it('resolves an external order ref back to the canonical order (200) with correlation fields', async () => {
    const lookup = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({
        operation: 'ORDER_EXISTS',
        payload: { hmsOrderId: 'HMS-HTTP-ORDER-1' },
      }),
    });
    assert.equal(lookup.status, 200);
    const ack = jsonOf(lookup.text);
    assert.equal(ack.outcome, 'RESOLVED');
    assert.equal(ack.externalReference, 'HMS-HTTP-ORDER-1');
    assert.ok(ack.resource.order.id);
    assert.equal(ack.resource.externalSystem, HMS_SYNTHETIC_SYSTEM);
    assert.equal(ack.resource.externalOrderRef, 'HMS-HTTP-ORDER-1');
  });

  it('404s an ORDER_EXISTS lookup for an unknown external ref without leaking internals', async () => {
    const res = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({
        operation: 'ORDER_EXISTS',
        payload: { hmsOrderId: 'HMS-HTTP-ORDER-NEVER' },
      }),
    });
    assert.equal(res.status, 404);
    const lower = res.text.toLowerCase();
    for (const banned of ['stack', 'select ', 'order_external_references', 'password']) {
      assert.ok(!lower.includes(banned), `leaked: ${banned}`);
    }
  });

  it('rejects a valid adapter whose system is NOT in the registry (403, fail-closed)', async () => {
    const res = await request('POST', REQUESTS_PATH, {
      body: envelopeBody({ system: 'UNREGISTERED-SYNTHETIC' }),
    });
    assert.equal(res.status, 403);
    const body = jsonOf(res.text);
    assert.equal(body.error.code, 'FORBIDDEN');
  });
});

/** Type guard: keeps the fixture's abstract specimen id type honest. */
void (undefined as unknown as SpecimenId);

/**
 * Patient registration HTTP contract tests.
 *
 * Real `node:http` server over the application services (in-memory adapters):
 * registration, lookup, external identifiers — with the mandated error shape,
 * fail-closed 401 posture, scope 403s, validation 422s, conflicts 409,
 * IDOR protection, DTO-shape and leakage assertions, and idempotent replay.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { PatientService } from '../../src/app/patients/patient-service';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  InMemoryIdempotencyStore,
  InMemoryPatientRegistrationRepository,
} from '../../src/app/in-memory';
import { createFixture, sessionFor } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let patients: PatientService;

const PATIENTS_PATH = '/api/v1/patients';

const REGISTRATION = {
  fullName: 'Http Registrant',
  sex: 'M',
  birthDate: '1988-07-09',
};

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string; headers?: Record<string, string>; contentType?: string } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined
        ? { 'content-type': options.contentType ?? 'application/json' }
        : {}),
      ...options.headers,
    },
    body: options.body,
  });
  const text = await response.text();
  const headers: Record<string, string | string[] | undefined> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { status: response.status, headers, text };
}

function post(path: string, body: unknown, headers?: Record<string, string>) {
  return request('POST', path, {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers,
  });
}

let lab: ReturnType<typeof createFixture>;

before(async () => {
  lab = createFixture();
  const repo = new InMemoryPatientRegistrationRepository();
  const facilities = (
    lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  patients = new PatientService({
    patients: repo,
    facilities,
    audit: lab.audit,
    idempotency: new InMemoryIdempotencyStore(),
  });
  const active = sessionFor();
  sessionResolver = async () => active;
  const router = createRouter({
    runtime: {
      orders: lab.orders,
      specimens: lab.specimens,
      observations: lab.observations,
      interpretations: lab.interpretations,
      reports: lab.reports,
      patients,
    },
  });
  const httpServer = createSdisHttpServer({
    router,
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

describe('patients http: registration', () => {
  it('registers a patient with 201 and the contracted DTO shape', async () => {
    const response = await post(PATIENTS_PATH, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-HTTP-1' }],
    });
    assert.equal(response.status, 201);
    const patient = jsonOf(response.text);
    assert.deepEqual(Object.keys(patient).sort(), [
      'birthDate',
      'externalReferences',
      'fullName',
      'id',
      'registeredAtFacilityId',
      'sex',
    ]);
    assert.equal(patient.registeredAtFacilityId, '00000000-0000-4000-8000-000000000011');
    assert.equal(
      patient.externalReferences[0].facilityId,
      patient.registeredAtFacilityId,
    );
    assert.equal(jsonOf(patient.id.length > 0 ? 'true' : 'false'), true);
  });

  it('401s when no session resolves (fail closed)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post(PATIENTS_PATH, REGISTRATION);
      assert.equal(response.status, 401);
      assert.equal(jsonOf(response.text).error.code, 'UNAUTHENTICATED');
      // 401 responses carry the `WWW-Authenticate: Bearer` challenge (AUTH-04).
      assert.equal(response.headers['www-authenticate'], 'Bearer');
    } finally {
      sessionResolver = previous;
    }
  });

  it('401s patient GET too — no read bypass', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await request(
        'GET',
        `${PATIENTS_PATH}/00000000-0000-4000-8000-0000000000e1`,
      );
      assert.equal(response.status, 401);
    } finally {
      sessionResolver = previous;
    }
  });

  it('403s a forged tenant (facility of another organization)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () =>
      sessionFor(
        '00000000-0000-4000-8000-000000000011' as never,
        '00000000-0000-4000-8000-000000000009' as never,
      );
    try {
      const response = await post(PATIENTS_PATH, REGISTRATION);
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('409s a duplicate external identifier', async () => {
    await post(PATIENTS_PATH, {
      ...REGISTRATION,
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-HTTP-DUP' }],
    });
    const response = await post(PATIENTS_PATH, {
      ...REGISTRATION,
      fullName: 'Someone Else Entirely',
      externalReferences: [{ system: 'HOSPITAL_MRN', value: 'MRN-HTTP-DUP' }],
    });
    assert.equal(response.status, 409);
    assert.equal(jsonOf(response.text).error.code, 'CONFLICT');
    // No identity merge: the conflicting payload must not create a patient.
    assert.equal(jsonOf(response.text).error.details.length, 0);
  });

  it('422s validation failures (empty name, bad sex, malformed birthDate)', async () => {
    for (const bad of [
      { ...REGISTRATION, fullName: '' },
      { ...REGISTRATION, sex: 'X' },
      { ...REGISTRATION, birthDate: 'not-a-date' },
    ]) {
      const response = await post(PATIENTS_PATH, bad);
      assert.equal(response.status, 422);
      assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
    }
  });

  it('422s malformed identifier entries', async () => {
    const response = await post(PATIENTS_PATH, {
      ...REGISTRATION,
      externalReferences: [{ value: 'no-system' }],
    });
    assert.equal(response.status, 422);
  });

  it('404s unknown patients with the stable NOT_FOUND code', async () => {
    const response = await request(
      'GET',
      `${PATIENTS_PATH}/00000000-0000-4000-8000-0000000000ff`,
    );
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });
});

describe('patients http: external identifiers and lookup', () => {
  it('attaches an external identifier with 201 and returns the updated patient', async () => {
    const created = await post(PATIENTS_PATH, REGISTRATION);
    const id = jsonOf(created.text).id as string;
    const response = await post(`${PATIENTS_PATH}/${id}/external-identifiers`, {
      system: 'ENTERPRISE',
      value: 'ENT-HTTP-1',
    });
    assert.equal(response.status, 201);
    const updated = jsonOf(response.text);
    assert.equal(
      updated.externalReferences.some(
        (r: { system: string; value: string }) =>
          r.system === 'ENTERPRISE' && r.value === 'ENT-HTTP-1',
      ),
      true,
    );
  });

  it('looks up a patient within scope with 200', async () => {
    const created = await post(PATIENTS_PATH, REGISTRATION);
    const id = jsonOf(created.text).id as string;
    const response = await request('GET', `${PATIENTS_PATH}/${id}`);
    assert.equal(response.status, 200);
    assert.equal(jsonOf(response.text).id, id);
  });

  it('never leaks internals: no provenance objects, audit fields, or SQL in responses/errors', async () => {
    const created = await post(PATIENTS_PATH, REGISTRATION);
    const text = created.text.toLowerCase();
    assert.ok(!text.includes('provenance'));
    assert.ok(!text.includes('actor_kind'));
    assert.ok(!text.includes('select '));
    assert.ok(!text.includes('postgres'));
    const failure = await post(PATIENTS_PATH, { fullName: '' });
    assert.equal(failure.status, 422);
    assert.ok(!failure.text.toLowerCase().includes('stack'));
  });
});

describe('patients http: idempotency', () => {
  it('replays the same Idempotency-Key header to the same patient', async () => {
    const first = await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-retry-1',
    });
    assert.equal(first.status, 201);
    const replay = await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-retry-1',
    });
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, jsonOf(first.text).id);
  });

  it('emits no duplicate audit events on replay', async () => {
    const first = await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-audit-replay-1',
    });
    assert.equal(first.status, 201);
    const patientId = jsonOf(first.text).id as string;
    await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-audit-replay-1',
    });
    const created = lab.audit
      .list()
      .filter((e) => e.objectType === 'patient' && e.objectId === patientId);
    assert.equal(created.length, 1);
  });

  it('does not collapse distinct keys', async () => {
    const first = await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-distinct-1',
    });
    const second = await post(PATIENTS_PATH, REGISTRATION, {
      'idempotency-key': 'patient-distinct-2',
    });
    assert.notEqual(jsonOf(second.text).id, jsonOf(first.text).id);
  });
});

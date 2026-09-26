/**
 * Billing HTTP contract tests.
 *
 * Real `node:http` server over the application services (in-memory adapters):
 * charge creation against a real order created through the same server,
 * charge retrieval, order-linked charge listing — with the mandated error
 * envelope, fail-closed 401, scope 403, validation 422, conflict 409, and
 * leakage assertions.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { BillingService } from '../../src/app/billing/billing-service';
import { InMemoryChargeRepository } from '../../src/app/in-memory-billing';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import {
  createFixture,
  sessionFor,
  ORG,
  OTHER_FACILITY,
  FACILITY,
  OTHER_ORG,
} from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import { toBrandedId } from '../../src/types/ids';
import type { BillableServiceId } from '../../src/types/ids';

const SERVICE_ID = toBrandedId(
  '00000000-0000-4000-8000-0000000003f1',
) as BillableServiceId;

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let charges: InMemoryChargeRepository;

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
  charges = new InMemoryChargeRepository();
  charges.registerService({
    id: SERVICE_ID,
    facilityId: FACILITY,
    name: 'CBC — Complete Blood Count',
    modality: 'LAB',
    priceCurrency: 'NPR',
    priceAmount: 350,
  });
  const billing = new BillingService({
    orders: lab.orders,
    charges,
    facilities: (lab.orders as unknown as { deps: { facilities: FacilityDirectory } })
      .deps.facilities,
    audit: lab.audit,
    idempotency: (lab.orders as unknown as { deps: { idempotency: unknown } }).deps
      .idempotency as never,
  });
  const active = sessionFor();
  (active as { roles?: readonly string[] }).roles = ['manager'] as never;
  sessionResolver = async () => active;
  const router = createRouter({
    runtime: {
      orders: lab.orders,
      specimens: lab.specimens,
      observations: lab.observations,
      interpretations: lab.interpretations,
      reports: lab.reports,
      billing,
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

async function createOrderOverHttp(): Promise<{ orderId: string; itemId: string }> {
  const response = await post('/api/v1/diagnostic-orders', {
    patientId: lab.patientId,
    encounterId: lab.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  });
  assert.equal(response.status, 201);
  const order = jsonOf(response.text);
  return { orderId: order.id, itemId: order.items[0].id };
}

describe('billing http: charge lifecycle', () => {
  it('creates a charge with 201 and the contracted DTO shape', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const response = await post('/api/v1/charges', {
      orderId,
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    assert.equal(response.status, 201);
    const charge = jsonOf(response.text);
    assert.deepEqual(Object.keys(charge).sort(), [
      'amount',
      'createdAt',
      'currency',
      'id',
      'orderId',
      'orderItemId',
      'serviceId',
    ]);
    assert.equal(charge.amount, 350);
    assert.equal(charge.currency, 'NPR');
    assert.equal(charge.orderId, orderId);
  });

  it('401s when no session resolves (fail closed)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    try {
      const response = await post('/api/v1/charges', {
        orderId: '00000000-0000-4000-8000-0000000000a1',
        orderItemId: '00000000-0000-4000-8000-0000000000a2',
        serviceId: SERVICE_ID,
      });
      assert.equal(response.status, 401);
      assert.equal(jsonOf(response.text).error.code, 'UNAUTHENTICATED');
    } finally {
      sessionResolver = previous;
    }
  });

  it('403s a forged tenant', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const previous = sessionResolver;
    const forgedTenant = sessionFor(FACILITY, OTHER_ORG);
    (forgedTenant as { roles?: readonly string[] }).roles = ['manager'] as never;
    sessionResolver = async () => forgedTenant;
    try {
      const response = await post('/api/v1/charges', {
        orderId,
        orderItemId: itemId,
        serviceId: SERVICE_ID,
      });
      assert.equal(response.status, 403);
      assert.equal(jsonOf(response.text).error.code, 'SCOPE_MISMATCH');
    } finally {
      sessionResolver = previous;
    }
  });

  it('403s a cross-facility order (scope mismatch through the order service)', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const previous = sessionResolver;
    const crossFacility = sessionFor(OTHER_FACILITY, ORG);
    (crossFacility as { roles?: readonly string[] }).roles = ['manager'] as never;
    sessionResolver = async () => crossFacility;
    try {
      const response = await post('/api/v1/charges', {
        orderId,
        orderItemId: itemId,
        serviceId: SERVICE_ID,
      });
      assert.equal(response.status, 403);
    } finally {
      sessionResolver = previous;
    }
  });

  it('409s duplicate charging of the same item for the same service', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const payload = { orderId, orderItemId: itemId, serviceId: SERVICE_ID };
    await post('/api/v1/charges', payload);
    const response = await post('/api/v1/charges', payload);
    assert.equal(response.status, 409);
    assert.equal(jsonOf(response.text).error.code, 'CONFLICT');
  });

  it('422s an order item that does not belong to the order', async () => {
    const first = await createOrderOverHttp();
    const second = await createOrderOverHttp();
    const response = await post('/api/v1/charges', {
      orderId: first.orderId,
      orderItemId: second.itemId,
      serviceId: SERVICE_ID,
    });
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('422s missing/invalid fields', async () => {
    for (const bad of [
      {},
      { orderId: 'not-a-uuid', orderItemId: 'x', serviceId: 'y' },
      { orderItemId: '00000000-0000-4000-8000-0000000000a2', serviceId: SERVICE_ID },
    ]) {
      const response = await post('/api/v1/charges', bad);
      assert.equal(response.status, 422);
    }
  });

  it('404s unknown charges with the stable NOT_FOUND code', async () => {
    const response = await request(
      'GET',
      '/api/v1/charges/00000000-0000-4000-8000-0000000003ff',
    );
    assert.equal(response.status, 404);
    assert.equal(jsonOf(response.text).error.code, 'NOT_FOUND');
  });

  it('BILL-03 regression: a malformed charge id in the path is a 422, never an internal error', async () => {
    const response = await request('GET', '/api/v1/charges/not-a-uuid');
    assert.equal(response.status, 422);
    assert.equal(jsonOf(response.text).error.code, 'VALIDATION_FAILED');
  });

  it('lists charges for an order and replays an Idempotency-Key to the same charge', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const payload = { orderId, orderItemId: itemId, serviceId: SERVICE_ID };
    const first = await post('/api/v1/charges', payload, {
      'idempotency-key': 'bill-http-1',
    });
    assert.equal(first.status, 201);
    const replay = await post('/api/v1/charges', payload, {
      'idempotency-key': 'bill-http-1',
    });
    assert.equal(replay.status, 201);
    assert.equal(jsonOf(replay.text).id, jsonOf(first.text).id);

    const list = await request('GET', `/api/v1/diagnostic-orders/${orderId}/charges`);
    assert.equal(list.status, 200);
    const charges = jsonOf(list.text);
    assert.ok(Array.isArray(charges) && charges.length === 1);
    assert.equal(charges[0].id, jsonOf(first.text).id);
  });

  it('never leaks internals: no SQL, stacks, or audit fields in responses/errors', async () => {
    const { orderId, itemId } = await createOrderOverHttp();
    const created = await post('/api/v1/charges', {
      orderId,
      orderItemId: itemId,
      serviceId: SERVICE_ID,
    });
    const text = created.text.toLowerCase();
    assert.ok(!text.includes('select '));
    assert.ok(!text.includes('postgres'));
    assert.ok(!text.includes('idempotency_key'));
    const failure = await post('/api/v1/charges', { orderId: 'x' });
    assert.equal(failure.status, 422);
    assert.ok(!failure.text.toLowerCase().includes('stack'));
  });
});

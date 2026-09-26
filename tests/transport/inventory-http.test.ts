/**
 * Laboratory inventory HTTP contract tests (Step 14).
 *
 * Real `node:http` server over in-memory adapters: item/lot registration,
 * stock receipt and issue, derived balance and lot status — with the mandated
 * error envelope, fail-closed 401, RBAC 403, forged-scope 403, validation 422,
 * conflict 409, missing 404, and no SQL/stack/internal leakage.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { AddressInfo } from 'node:net';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function jsonOf(text: string): any {
  return JSON.parse(text);
}

import { InventoryService } from '../../src/app/inventory/inventory-service';
import { InMemoryInventoryRepository } from '../../src/app/in-memory-inventory';
import { AuthorizationService, claimedRoleResolver } from '../../src/app/authz/rbac';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import type { SessionResolver } from '../../src/transport/session';
import { InMemoryIdempotencyStore } from '../../src/app/in-memory';
import { createFixture, sessionFor, OTHER_FACILITY, OTHER_ORG } from '../app/helpers';
import type { FacilityDirectory } from '../../src/app/ports';
import type { ApplicationSession } from '../../src/app/context';

interface Response {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
}

async function request(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: string } = {},
): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: options.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: options.body,
  });
  return { status: response.status, headers: {}, text: await response.text() };
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

const ITEMS_PATH = '/api/v1/inventory/items';
const LOTS_PATH = '/api/v1/inventory/lots';
const RECEIVE_PATH = '/api/v1/inventory/receive';
const ISSUE_PATH = '/api/v1/inventory/issue';

let server: Server;
let baseUrl: string;
let sessionResolver: SessionResolver;
let inventory: InventoryService;

before(async () => {
  const fixture = createFixture();
  const facilities = (
    fixture.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  inventory = new InventoryService({
    inventory: new InMemoryInventoryRepository(),
    facilities,
    audit: fixture.audit,
    idempotency: new InMemoryIdempotencyStore(),
    authz: new AuthorizationService({ roleResolver: claimedRoleResolver() }),
  });
  const active = withRoles(sessionFor(), ['operator']);
  sessionResolver = async () => active;
  const httpServer = createSdisHttpServer({
    router: createRouter({ runtime: { inventory } }),
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

const SKU = 'HTTP-RG-1';

async function registerItem(overrides: Record<string, unknown> = {}): Promise<Response> {
  return request('POST', ITEMS_PATH, {
    body: JSON.stringify({
      sku: SKU,
      name: 'Synthetic reagent',
      category: 'REAGENT',
      ...overrides,
    }),
  });
}

describe('inventory http: item, lot, and stock operations', () => {
  it('registers an item (201) and returns a clean DTO', async () => {
    const res = await registerItem();
    assert.equal(res.status, 201);
    const body = jsonOf(res.text);
    assert.ok(body.id);
    assert.equal(body.sku, SKU);
    assert.equal(body.category, 'REAGENT');
    assert.ok(!res.text.includes('select '));
  });

  it('conflicts (409) on a duplicate sku in the same facility', async () => {
    const res = await registerItem();
    assert.equal(res.status, 409);
    assert.equal(jsonOf(res.text).error.code, 'CONFLICT');
  });

  it('receives stock (201) and reports the derived balance (200)', async () => {
    const item = jsonOf((await registerItem({ sku: 'HTTP-RG-2' })).text);
    const receipt = await request('POST', RECEIVE_PATH, {
      body: JSON.stringify({
        itemId: item.id,
        lotNumber: 'HTTP-LOT-1',
        expiryDate: '2027-06-30',
        quantity: 40,
      }),
    });
    assert.equal(receipt.status, 201);
    const movement = jsonOf(receipt.text);
    assert.equal(movement.movementType, 'IN');
    assert.equal(movement.quantitySigned, 40);

    const balance = await request('GET', `${ITEMS_PATH}/${item.id}/balance`);
    assert.equal(balance.status, 200);
    const body = jsonOf(balance.text);
    assert.equal(body.totalBalance, 40);
    assert.equal(body.lots.length, 1);
    assert.equal(body.lots[0].lot.expiryStatus, 'VALID');
    assert.equal(body.lots[0].consumable, true);
    assert.equal(body.lots[0].lot.lotNumber, 'HTTP-LOT-1');

    // Unexplained movements are refused (Step 31 §8): the reason is required.
    const unexplained = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: body.lots[0].lot.id,
        quantity: 15,
        movementType: 'OUT',
      }),
    });
    assert.equal(unexplained.status, 422);

    const issue = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: body.lots[0].lot.id,
        quantity: 15,
        movementType: 'OUT',
        reason: 'consumption',
      }),
    });
    assert.equal(issue.status, 201);
    assert.equal(jsonOf(issue.text).quantitySigned, -15);

    const after14 = await request('GET', `${ITEMS_PATH}/${item.id}/balance`);
    assert.equal(jsonOf(after14.text).totalBalance, 25);

    const lots = await request('GET', `${ITEMS_PATH}/${item.id}/lots`);
    assert.equal(lots.status, 200);
    assert.equal(jsonOf(lots.text).lots[0].balance, 25);
  });

  it('registers a lot explicitly (201) and lists it in lot status', async () => {
    const item = jsonOf((await registerItem({ sku: 'HTTP-RG-3' })).text);
    const lot = await request('POST', LOTS_PATH, {
      body: JSON.stringify({
        itemId: item.id,
        lotNumber: 'HTTP-LOT-3',
        expiryDate: '2019-01-01',
        receivedQuantity: 5,
      }),
    });
    assert.equal(lot.status, 201);
    assert.equal(jsonOf(lot.text).lotNumber, 'HTTP-LOT-3');

    const status = await request('GET', `${ITEMS_PATH}/${item.id}/lots`);
    assert.equal(status.status, 200);
    assert.equal(jsonOf(status.text).lots[0].lot.expiryStatus, 'EXPIRED');
    assert.equal(jsonOf(status.text).lots[0].consumable, false);
    assert.equal(jsonOf(status.text).lots[0].balance, 5);
  });

  it('replays a keyed receipt without duplicating stock (201, same id)', async () => {
    const item = jsonOf((await registerItem({ sku: 'HTTP-RG-4' })).text);
    const body = JSON.stringify({
      itemId: item.id,
      lotNumber: 'HTTP-LOT-4',
      expiryDate: '2027-06-30',
      quantity: 12,
      idempotencyKey: 'http-receipt-1',
    });
    const first = await request('POST', RECEIVE_PATH, { body });
    const second = await request('POST', RECEIVE_PATH, { body });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(jsonOf(second.text).id, jsonOf(first.text).id);
    const balance = await request('GET', `${ITEMS_PATH}/${item.id}/balance`);
    assert.equal(jsonOf(balance.text).totalBalance, 12);
  });
});

describe('inventory http: validation and security', () => {
  it('rejects invalid payloads with the existing 422 contract', async () => {
    const badSku = await registerItem({ sku: '!' });
    assert.equal(badSku.status, 422);
    const badCategory = await registerItem({ sku: 'HTTP-RG-9', category: 'REAGENT_KIT' });
    assert.equal(badCategory.status, 422);
    const badQuantity = await request('POST', RECEIVE_PATH, {
      body: JSON.stringify({
        itemId: '00000000-0000-4000-8000-0000000000d0',
        lotNumber: 'L',
        expiryDate: '2027-06-30',
        quantity: -5,
      }),
    });
    assert.equal(badQuantity.status, 422);
    assert.equal(jsonOf(badQuantity.text).error.code, 'VALIDATION_FAILED');
    const badMovement = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: '00000000-0000-4000-8000-0000000000d0',
        quantity: 1,
        movementType: 'DROP',
      }),
    });
    assert.equal(badMovement.status, 422);
  });

  it('stays fail-closed without a session (401)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => undefined;
    const res = await registerItem({ sku: 'HTTP-RG-401' });
    assert.equal(res.status, 401);
    assert.equal(jsonOf(res.text).error.code, 'UNAUTHENTICATED');
    sessionResolver = previous;
  });

  it('denies a role without the inventory permission (403)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () => withRoles(sessionFor(), ['viewer']);
    const res = await registerItem({ sku: 'HTTP-RG-403' });
    assert.equal(res.status, 403);
    assert.equal(jsonOf(res.text).error.code, 'FORBIDDEN');
    sessionResolver = previous;
  });

  it('denies a forged facility/organization pairing (403)', async () => {
    const previous = sessionResolver;
    sessionResolver = async () =>
      withRoles(sessionFor(OTHER_FACILITY, OTHER_ORG), ['operator']);
    const res = await registerItem({ sku: 'HTTP-RG-FORGED' });
    assert.equal(res.status, 403);
    const body = jsonOf(res.text);
    assert.ok(['FORBIDDEN', 'SCOPE_MISMATCH'].includes(body.error.code));
    sessionResolver = previous;
  });

  it('404s an unknown item without leaking internals', async () => {
    const res = await request(
      'GET',
      `${ITEMS_PATH}/00000000-0000-4000-8000-0000000000d1/balance`,
    );
    assert.equal(res.status, 404);
    const lower = res.text.toLowerCase();
    for (const banned of ['stack', 'select ', 'inventory_items', 'password', 'bearer']) {
      assert.ok(!lower.includes(banned), `leaked: ${banned}`);
    }
  });
});

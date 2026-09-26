/**
 * Inventory lifecycle HTTP contract tests (Step 31).
 *
 * Real `node:http` server over in-memory adapters: controlled lot transitions
 * (quarantine/release/retire), item retire/reactivate, expiring-lots query,
 * FEFO selection, lot/operation usage traceability, and the §8 reason gate on
 * issue — with the mandated error envelope, fail-closed RBAC, and scope
 * enforcement.
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
  return { status: response.status, text: await response.text() };
}

function withRoles(
  session: ApplicationSession,
  roles: readonly string[],
): ApplicationSession {
  (session as { roles?: readonly string[] }).roles = roles as never;
  return session;
}

const ITEMS_PATH = '/api/v1/inventory/items';
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

async function registerItem(sku: string): Promise<{ id: string }> {
  const res = await request('POST', ITEMS_PATH, {
    body: JSON.stringify({ sku, name: `Synthetic ${sku}`, category: 'REAGENT' }),
  });
  assert.equal(res.status, 201);
  return jsonOf(res.text);
}

async function receiveLot(
  itemId: string,
  lotNumber: string,
  expiryDate: string,
  quantity: number,
): Promise<{ lotId: string }> {
  const res = await request('POST', RECEIVE_PATH, {
    body: JSON.stringify({ itemId, lotNumber, expiryDate, quantity }),
  });
  assert.equal(res.status, 201);
  const balance = await request('GET', `${ITEMS_PATH}/${itemId}/lots`);
  const lot = jsonOf(balance.text).lots.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (l: any) => l.lot.lotNumber === lotNumber,
  );
  assert.ok(lot, `lot ${lotNumber} should appear in balance`);
  return { lotId: lot.lot.id };
}

describe('inventory lifecycle http (step 31)', () => {
  it('quarantines, releases, and retires a lot through controlled transitions', async () => {
    const item = await registerItem('LIFE-RG-1');
    const { lotId } = await receiveLot(item.id, 'LIFE-LOT-1', '2099-01-01', 10);

    const quarantine = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'QUARANTINED', reason: 'temperature excursion' }),
    });
    assert.equal(quarantine.status, 200);
    assert.equal(jsonOf(quarantine.text).status, 'QUARANTINED');

    // A quarantined lot cannot be consumed — issueStock is gated.
    const consume = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: lotId,
        quantity: 1,
        movementType: 'OUT',
        reason: 'x',
      }),
    });
    assert.equal(consume.status, 422);

    const release = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'RELEASED', reason: 'cleared by QA' }),
    });
    assert.equal(release.status, 200);
    assert.equal(jsonOf(release.text).status, 'RELEASED');

    const retire = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'RETIRED', reason: 'end of lifecycle' }),
    });
    assert.equal(retire.status, 200);
    assert.equal(jsonOf(retire.text).status, 'RETIRED');

    // Terminal: retiring again conflicts.
    const again = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'RELEASED', reason: 'attempt from terminal state' }),
    });
    assert.equal(again.status, 409);
  });

  it('rejects unsupported transitions and missing reasons (422/409)', async () => {
    const item = await registerItem('LIFE-RG-2');
    const { lotId } = await receiveLot(item.id, 'LIFE-LOT-2', '2099-01-01', 5);

    const badTarget = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'SOMETHING_ELSE', reason: 'x' }),
    });
    assert.equal(badTarget.status, 422);

    const noReason = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'QUARANTINED' }),
    });
    assert.equal(noReason.status, 422);

    // AVAILABLE -> RELEASED is not a valid transition (release comes after
    // quarantine only).
    const invalid = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'RELEASED', reason: 'skipping quarantine' }),
    });
    assert.equal(invalid.status, 409);
  });

  it('retires an item and stops all stock activity against it', async () => {
    const item = await registerItem('LIFE-RG-3');
    const { lotId } = await receiveLot(item.id, 'LIFE-LOT-3', '2099-01-01', 8);

    const retire = await request('POST', `${ITEMS_PATH}/${item.id}/status`, {
      body: JSON.stringify({ active: false, reason: 'product discontinued' }),
    });
    assert.equal(retire.status, 200);
    assert.equal(jsonOf(retire.text).active, false);

    const consume = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: lotId,
        quantity: 1,
        movementType: 'OUT',
        reason: 'x',
      }),
    });
    assert.equal(consume.status, 409);

    const reactivate = await request('POST', `${ITEMS_PATH}/${item.id}/status`, {
      body: JSON.stringify({ active: true, reason: 'supply resumed' }),
    });
    assert.equal(reactivate.status, 200);
    assert.equal(jsonOf(reactivate.text).active, true);
  });

  it('lists expiring lots within the bounded horizon and rejects bad horizons', async () => {
    const item = await registerItem('LIFE-RG-4');
    await receiveLot(item.id, 'LIFE-LOT-4', '2020-01-01', 6); // already expired
    await receiveLot(item.id, 'LIFE-LOT-5', '2099-01-01', 6); // far future

    const expiring = await request('GET', '/api/v1/inventory/expiring?horizonDays=30');
    assert.equal(expiring.status, 200);
    const lots = jsonOf(expiring.text).lots;
    assert.ok(Array.isArray(lots));
    const lotNumbers = lots.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (l: any) => l.lotNumber,
    );
    assert.ok(lotNumbers.includes('LIFE-LOT-4'));
    assert.ok(!lotNumbers.includes('LIFE-LOT-5'));

    const bad = await request('GET', '/api/v1/inventory/expiring?horizonDays=0');
    assert.equal(bad.status, 422);
    const huge = await request('GET', '/api/v1/inventory/expiring?horizonDays=1000');
    assert.equal(huge.status, 422);
  });

  it('selects the FEFO lot deterministically and excludes expired/quarantined lots', async () => {
    const item = await registerItem('LIFE-RG-5');
    const oldest = await receiveLot(item.id, 'LIFE-LOT-6', '2098-06-01', 5);
    await receiveLot(item.id, 'LIFE-LOT-7', '2099-06-01', 5);
    await receiveLot(item.id, 'LIFE-LOT-8', '2020-01-01', 5); // expired

    const pick = await request('GET', `${ITEMS_PATH}/${item.id}/fefo-selection`);
    assert.equal(pick.status, 200);
    assert.equal(jsonOf(pick.text).lotNumber, 'LIFE-LOT-6');

    // Quarantine the FEFO pick: the next earliest non-expired lot is chosen.
    const quarantine = await request(
      'POST',
      `/api/v1/inventory/lots/${oldest.lotId}/status`,
      {
        body: JSON.stringify({ target: 'QUARANTINED', reason: 'failed QC' }),
      },
    );
    assert.equal(quarantine.status, 200);
    const pick2 = await request('GET', `${ITEMS_PATH}/${item.id}/fefo-selection`);
    assert.equal(pick2.status, 200);
    assert.equal(jsonOf(pick2.text).lotNumber, 'LIFE-LOT-7');
  });

  it('traces lot usage and operation usage without rewriting history', async () => {
    const item = await registerItem('LIFE-RG-6');
    const { lotId } = await receiveLot(item.id, 'LIFE-LOT-9', '2099-01-01', 12);

    const issue = await request('POST', ISSUE_PATH, {
      body: JSON.stringify({
        batchId: lotId,
        quantity: 4,
        movementType: 'OUT',
        reason: 'analytical run',
        operationRef: 'op-order-42',
      }),
    });
    assert.equal(issue.status, 201);

    const lotUsage = await request('GET', `/api/v1/inventory/lots/${lotId}/usage`);
    assert.equal(lotUsage.status, 200);
    const lotBody = jsonOf(lotUsage.text);
    assert.equal(lotBody.lot.id, lotId);
    assert.equal(lotBody.movements.length, 2); // receipt + issue
    assert.ok(
      lotBody.movements.some(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m: any) => m.operationRef === 'op-order-42' && m.quantitySigned === -4,
      ),
    );

    const opUsage = await request(
      'GET',
      '/api/v1/inventory/operations/op-order-42/usage',
    );
    assert.equal(opUsage.status, 200);
    const opBody = jsonOf(opUsage.text);
    assert.equal(opBody.operationRef, 'op-order-42');
    assert.equal(opBody.movements.length, 1);
    assert.equal(opBody.movements[0].batchId, lotId);
  });

  it('enforces fail-closed authentication and RBAC on the new routes', async () => {
    const item = await registerItem('LIFE-RG-7');
    const { lotId } = await receiveLot(item.id, 'LIFE-LOT-10', '2099-01-01', 3);

    // Unauthorized role: viewer without inventory permission is denied.
    const viewer = withRoles(sessionFor(), ['viewer']);
    sessionResolver = async () => viewer;
    const forbidden = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'QUARANTINED', reason: 'nope' }),
    });
    assert.equal(forbidden.status, 403);

    // Forged scope is rejected before any resource check.
    const forged = withRoles(
      {
        ...sessionFor(),
        organizationId: OTHER_ORG,
        facilityId: OTHER_FACILITY,
      } as ApplicationSession,
      ['operator'],
    );
    sessionResolver = async () => forged;
    const forgedRes = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'QUARANTINED', reason: 'forged' }),
    });
    assert.ok([403, 404].includes(forgedRes.status));

    sessionResolver = async () => withRoles(sessionFor(), ['operator']);
    const ok = await request('POST', `/api/v1/inventory/lots/${lotId}/status`, {
      body: JSON.stringify({ target: 'QUARANTINED', reason: 'back as operator' }),
    });
    assert.equal(ok.status, 200);
  });
});

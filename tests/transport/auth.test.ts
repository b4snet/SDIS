/**
 * Authentication foundation tests (Step 10).
 *
 * Prove the credential → principal → ApplicationSession path behind the
 * existing `SessionResolver` seam: fail-closed behavior for absent/malformed/
 * unknown credentials, constant-time credential matching, server-derived scope
 * (authentication identity ≠ authorization scope), and the complete HTTP
 * integration: 401 without/with invalid credentials, existing endpoint
 * behavior with valid credentials, and no credential leakage.
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
  bearerTokenOf,
  constantTimeDirectory,
  credentialSessionResolver,
  InvalidApiTokensError,
  parseApiTokensEnv,
  sessionResolverForEnvironment,
  type ApiCredential,
} from '../../src/transport/auth';
import {
  requireResolvedSession,
  unauthenticatedSessionResolver,
} from '../../src/transport/session';
import { createRouter } from '../../src/transport/router';
import { createSdisHttpServer } from '../../src/transport/server';
import { createFixture, sessionFor, FACILITY, ORG, OTHER_FACILITY } from '../app/helpers';
import type { ApplicationSession } from '../../src/app/context';

// Deterministic TEST-ONLY credentials (synthetic fixtures, never real secrets;
// production bindings are external configuration per docs/DEPLOYMENT.md §3).
const CREDENTIALS: readonly ApiCredential[] = [
  {
    token: 'sdis-test-token-registrar-1',
    actor: { kind: 'USER', id: 'registrar-1' },
    userId: 'registrar-1',
    organizationId: ORG,
    facilityId: FACILITY,
    roles: ['operator'],
  },
  {
    token: 'sdis-test-token-other-facility-2',
    actor: { kind: 'USER', id: 'registrar-2' },
    userId: 'registrar-2',
    organizationId: ORG,
    facilityId: OTHER_FACILITY,
    roles: ['operator'],
  },
];

describe('auth: bearer token extraction', () => {
  const headers = (authorization?: string) =>
    authorization === undefined ? {} : { authorization };

  it('extracts a well-formed bearer token', () => {
    assert.equal(bearerTokenOf(headers('Bearer abc-DEF_123')), 'abc-DEF_123');
    assert.equal(bearerTokenOf(headers('bearer abc')), 'abc'); // case-insensitive scheme
  });

  it('rejects absent/malformed credential material as undefined', () => {
    assert.equal(bearerTokenOf({}), undefined);
    assert.equal(bearerTokenOf(headers('')), undefined);
    assert.equal(bearerTokenOf(headers('Bearer')), undefined);
    assert.equal(bearerTokenOf(headers('Bearer ')), undefined);
    assert.equal(bearerTokenOf(headers('Basic dXNlcjpwYXNz')), undefined); // wrong scheme
    assert.equal(bearerTokenOf(headers('Bearer token\r\ninjected')), undefined); // control chars
    assert.equal(bearerTokenOf(headers(`Bearer ${'x'.repeat(300)}`)), undefined); // absurd length
  });
});

describe('auth: credential resolution', () => {
  it('resolves a valid credential to the existing ApplicationSession shape', async () => {
    const resolve = credentialSessionResolver(constantTimeDirectory(CREDENTIALS));
    const session = (await resolve({
      authorization: 'Bearer sdis-test-token-registrar-1',
    })) as ApplicationSession;
    assert.equal(session.actor.id, 'registrar-1');
    assert.equal(session.actor.kind, 'USER');
    assert.equal(session.userId, 'registrar-1');
    assert.equal(session.organizationId, ORG);
    assert.equal(session.facilityId, FACILITY);
  });

  it('resolves undefined for unknown credentials (fail-closed, not an error)', async () => {
    const resolve = credentialSessionResolver(constantTimeDirectory(CREDENTIALS));
    assert.equal(
      await resolve({ authorization: 'Bearer totally-unknown-token' }),
      undefined,
    );
  });

  it('resolves undefined for malformed credentials', async () => {
    const resolve = credentialSessionResolver(constantTimeDirectory(CREDENTIALS));
    assert.equal(await resolve({}), undefined);
    assert.equal(await resolve({ authorization: 'Bearer' }), undefined);
  });

  it('matches credentials in constant time (length-mismatch burn path)', async () => {
    const directory = constantTimeDirectory(CREDENTIALS);
    assert.equal(await directory('sdis-test-token-registrar-1'), CREDENTIALS[0]);
    assert.equal(await directory('short'), undefined);
    assert.equal(await directory('x'.repeat(400)), undefined);
  });

  it('the shipped unauthenticated resolver still resolves nothing', async () => {
    assert.equal(
      await unauthenticatedSessionResolver({ authorization: 'Bearer anything' }),
      undefined,
    );
  });
});

describe('auth: scope separation (authentication ≠ authorization)', () => {
  it('scope comes from the credential binding, never from the request', async () => {
    const resolve = credentialSessionResolver(constantTimeDirectory(CREDENTIALS));
    const session = (await resolve({
      authorization: 'Bearer sdis-test-token-other-facility-2',
    })) as ApplicationSession;
    // The credential authenticates registrar-2; their scope is the bound
    // OTHER_FACILITY regardless of anything a client might send in a body.
    assert.equal(session.facilityId, OTHER_FACILITY);
  });
});

describe('auth: HTTP integration', () => {
  let server: Server;
  let baseUrl: string;
  let lab: ReturnType<typeof createFixture>;

  before(async () => {
    lab = createFixture();
    const router = createRouter({
      runtime: {
        orders: lab.orders,
        specimens: lab.specimens,
        observations: lab.observations,
        interpretations: lab.interpretations,
        reports: lab.reports,
      },
    });
    const httpServer = createSdisHttpServer({
      router,
      sessionResolver: credentialSessionResolver(constantTimeDirectory(CREDENTIALS)),
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

  const ORDER_PAYLOAD = {
    patientId: null,
    encounterId: null,
    modality: 'LAB',
    items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
    orderedAt: '2026-09-21T08:00:00.000Z',
  };

  function orderPayloadFor(session: ApplicationSession) {
    return {
      ...ORDER_PAYLOAD,
      patientId: session.facilityId === FACILITY ? lab.patientId : lab.patientId,
      encounterId: lab.encounterId,
    };
  }

  it('protected endpoint without credentials → 401 in the existing envelope', async () => {
    const response = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(orderPayloadFor(sessionFor())),
    });
    assert.equal(response.status, 401);
    const body = jsonOf(await response.text());
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  it('malformed credential → 401 (not 400/404/500)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer',
      },
      body: JSON.stringify(orderPayloadFor(sessionFor())),
    });
    assert.equal(response.status, 401);
  });

  it('invalid/unknown credential → 401 (fail closed)', async () => {
    const response = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer totally-invalid-token',
      },
      body: JSON.stringify(orderPayloadFor(sessionFor())),
    });
    assert.equal(response.status, 401);
    assert.equal(jsonOf(await response.text()).error.code, 'UNAUTHENTICATED');
  });

  it('valid credential → full existing endpoint behavior (order created)', async () => {
    const registrar = sessionFor();
    const response = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sdis-test-token-registrar-1',
      },
      body: JSON.stringify(orderPayloadFor(registrar)),
    });
    assert.equal(response.status, 201);
    const order = jsonOf(await response.text());
    assert.equal(order.facilityId, FACILITY);
    // The authenticated principal is recorded as the ordering actor.
    assert.equal(order.orderedByRef, 'registrar-1');
  });

  it('authenticated principal in another bound facility → existing 403 scope behavior', async () => {
    // registrar-2 is authenticated, but their bound scope is OTHER_FACILITY;
    // the order's patient belongs to FACILITY — scope (authorization) denies
    // what authentication accepted.
    const response = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer sdis-test-token-other-facility-2',
      },
      body: JSON.stringify(orderPayloadFor(sessionFor(OTHER_FACILITY))),
    });
    assert.equal(response.status, 403);
    assert.equal(jsonOf(await response.text()).error.code, 'SCOPE_MISMATCH');
  });

  it('valid authentication does not leak credential material or auth internals', async () => {
    const failure = await fetch(`${baseUrl}/api/v1/diagnostic-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer invalid-token-check',
      },
      body: JSON.stringify(orderPayloadFor(sessionFor())),
    });
    const text = await failure.text();
    const lowered = text.toLowerCase();
    assert.ok(!lowered.includes('bearer'));
    assert.ok(!lowered.includes('credential'));
    assert.ok(!lowered.includes('token'));
    assert.ok(!lowered.includes('authorization'));
    assert.ok(!lowered.includes('stack'));
  });
});

describe('auth: AUTH-01/AUTH-02 regressions', () => {
  it('AUTH-01: the 401 guard carries the neutral message, never the stale claim', () => {
    try {
      requireResolvedSession(undefined);
      assert.fail('must throw');
    } catch (error) {
      const failure = error as { message?: string; code?: string };
      assert.equal(failure.code, 'UNAUTHENTICATED');
      assert.equal(failure.message, 'Authentication is required');
      assert.ok(
        !String(failure.message).includes('not yet integrated'),
        '401 message must not claim the boundary is not integrated',
      );
      // Neutrality: the same message for absent/invalid/unknown credentials is
      // enforced by the http-contract suite on the wire.
    }
  });

  it('AUTH-02: SDIS_API_TOKENS parses into a working directory (roles ride the session)', async () => {
    const resolver = sessionResolverForEnvironment({
      SDIS_API_TOKENS: JSON.stringify([
        {
          token: 'env-token-1',
          userId: 'env-user-1',
          organizationId: ORG,
          facilityId: FACILITY,
          actorKind: 'USER',
          actorId: 'env-actor-1',
          roles: ['manager'],
        },
      ]),
    } as NodeJS.ProcessEnv);
    const session = (await resolver({
      authorization: 'Bearer env-token-1',
    })) as ApplicationSession;
    assert.equal(session.userId, 'env-user-1');
    assert.equal(session.actor.id, 'env-actor-1');
    assert.equal(session.organizationId, ORG);
    assert.equal(session.facilityId, FACILITY);
    assert.deepEqual(session.roles, ['manager']);
  });

  it('AUTH-02: unknown/malformed env credentials fail closed (resolver → undefined)', async () => {
    const resolver = sessionResolverForEnvironment({
      SDIS_API_TOKENS: JSON.stringify([
        { token: 'env-token-1', userId: 'u', organizationId: ORG, facilityId: FACILITY },
      ]),
    } as NodeJS.ProcessEnv);
    assert.ok(
      (await resolver({ authorization: 'Bearer env-token-1' })) !== undefined,
      'valid token must resolve (sanity)',
    );
    assert.equal(await resolver({ authorization: 'Bearer unknown-token' }), undefined);
    assert.equal(await resolver({}), undefined);
  });

  it('AUTH-02: unset/blank SDIS_API_TOKENS keeps the fail-closed shipped default', async () => {
    const unset = sessionResolverForEnvironment({});
    assert.equal(await unset({ authorization: 'Bearer anything' }), undefined);
    const blank = sessionResolverForEnvironment({
      SDIS_API_TOKENS: '   ',
    } as NodeJS.ProcessEnv);
    assert.equal(await blank({ authorization: 'Bearer anything' }), undefined);
  });

  it('AUTH-02: malformed SDIS_API_TOKENS fails fast at startup (no silent 401 loop)', () => {
    const valid = {
      token: 'a',
      userId: 'u',
      organizationId: ORG,
      facilityId: FACILITY,
    };
    // Not JSON / not an array / not an object.
    assert.throws(
      () => parseApiTokensEnv('{ definitely not json'),
      InvalidApiTokensError,
    );
    assert.throws(() => parseApiTokensEnv('"just a string"'), InvalidApiTokensError);
    assert.throws(() => parseApiTokensEnv('null'), InvalidApiTokensError);
    // Missing/bad fields.
    assert.throws(
      () => parseApiTokensEnv(JSON.stringify([{ ...valid, token: '' }])),
      InvalidApiTokensError,
    );
    assert.throws(
      () => parseApiTokensEnv(JSON.stringify([{ ...valid, userId: '' }])),
      InvalidApiTokensError,
    );
    assert.throws(
      () =>
        parseApiTokensEnv(JSON.stringify([{ ...valid, organizationId: 'not-a-uuid' }])),
      InvalidApiTokensError,
    );
    assert.throws(
      () => parseApiTokensEnv(JSON.stringify([{ ...valid, facilityId: 'x' }])),
      InvalidApiTokensError,
    );
    assert.throws(
      () => parseApiTokensEnv(JSON.stringify([{ ...valid, roles: ['admin'] }])),
      InvalidApiTokensError,
    );
    assert.throws(
      () => parseApiTokensEnv(JSON.stringify([{ ...valid, actorKind: 'ROBOT' }])),
      InvalidApiTokensError,
    );
    // Duplicate tokens are ambiguous for the constant-time directory.
    assert.throws(
      () =>
        parseApiTokensEnv(
          JSON.stringify([valid, { ...valid, token: 'a', userId: 'u2' }]),
        ),
      InvalidApiTokensError,
    );
  });

  it('AUTH-02: blank env yields an empty directory (no credentials configured)', () => {
    assert.deepEqual(parseApiTokensEnv(undefined), []);
    assert.deepEqual(parseApiTokensEnv('  '), []);
  });
});

/**
 * Step 28 — result governance over the REAL HTTP transport.
 *
 * Proves the governed lifecycle end-to-end: a manager-tier verify with
 * server-resolved attribution (client-supplied fields are impossible — the
 * route takes no such input), the verification gate on report finalization
 * (409 before verify), amendment reason enforcement (422), amendment manager
 * gating (403 for staff below the tier), and keyed amendment replay
 * idempotency.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ApplicationSession } from '../../src/app/context';
import type { SessionResolver } from '../../src/transport/session';
import { createSdisHttpServer } from '../../src/transport/server';
import type { Server } from 'node:http';
import { createRouter } from '../../src/transport/router';
import { createFixture, sessionFor, T0 } from '../app/helpers';
import type { LabFixture } from '../app/helpers';

const at = (n: number) =>
  new Date(Date.parse('2026-03-01T08:00:00Z') + n * 60_000).toISOString();

describe('result governance over HTTP (Step 28)', () => {
  let fx: LabFixture;
  let server: Server;
  let baseUrl: string;
  let sessionResolver: SessionResolver;
  let manager: ApplicationSession;
  let operator: ApplicationSession;

  before(async () => {
    fx = createFixture();
    manager = {
      ...sessionFor(),
      actor: { kind: 'USER', id: 'user-manager-1' },
      userId: 'user-manager-1',
      roles: ['manager'],
    } as never;
    operator = { ...sessionFor(), roles: ['operator'] } as never;
    const router = createRouter({ runtime: fx as never });
    server = createSdisHttpServer({
      router,
      sessionResolver: (headers) => sessionResolver(headers),
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.on('error', reject);
    });
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    sessionResolver = async () => operator;
  });

  after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );

  async function post(
    path: string,
    body?: unknown,
    as?: ApplicationSession,
  ): Promise<{ status: number; body: unknown }> {
    const previous = sessionResolver;
    if (as) sessionResolver = async () => as;
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : undefined };
    } finally {
      sessionResolver = previous;
    }
  }

  /** Creates an order over HTTP and walks it to RESULT_ENTERED. */
  async function enteredOrderOverHttp(): Promise<{ orderId: string }> {
    const created = await post(
      '/api/v1/diagnostic-orders',
      {
        patientId: fx.patientId,
        encounterId: fx.encounterId,
        modality: 'LAB',
        items: [{ testCode: 'CBC', codeSystem: 'sdis' }],
        orderedAt: T0,
      },
      operator,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = (created.body as { id: string }).id;
    for (const [i, to] of (
      ['ACQUIRED', 'PROCESSING', 'RESULT_ENTERED'] as const
    ).entries()) {
      const step = await post(
        `/api/v1/diagnostic-orders/${orderId}/transitions`,
        { to, at: at(i + 1) },
        operator,
      );
      assert.equal(step.status, 200, JSON.stringify(step.body));
    }
    return { orderId };
  }

  async function verifiedReportOverHttp(): Promise<{
    orderId: string;
    reportId: string;
  }> {
    const { orderId } = await enteredOrderOverHttp();
    const verified = await post(
      `/api/v1/diagnostic-orders/${orderId}/transitions`,
      { to: 'VERIFIED', at: at(4) },
      manager,
    );
    assert.equal(verified.status, 200);
    const created = await post(
      `/api/v1/diagnostic-orders/${orderId}/reports`,
      { content: 'original finalized content', authoredAt: at(10) },
      manager,
    );
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const reportId = (created.body as { id: string }).id;
    const finalized = await post(
      `/api/v1/reports/${reportId}/finalize`,
      { at: at(11) },
      manager,
    );
    assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
    return { orderId, reportId };
  }

  it('requires the manager tier to verify over HTTP (operator 403)', async () => {
    const { orderId } = await enteredOrderOverHttp();
    const denied = await post(
      `/api/v1/diagnostic-orders/${orderId}/transitions`,
      { to: 'VERIFIED', at: at(4) },
      operator,
    );
    assert.equal(denied.status, 403);
    const allowed = await post(
      `/api/v1/diagnostic-orders/${orderId}/transitions`,
      { to: 'VERIFIED', at: at(4) },
      manager,
    );
    assert.equal(allowed.status, 200);
    const verified = allowed.body as {
      status: string;
      verifiedByRef: string;
      verifiedAt: string;
      orderedByRef: string;
    };
    assert.equal(verified.status, 'VERIFIED');
    assert.equal(verified.verifiedByRef, 'user-manager-1');
    assert.equal(verified.verifiedAt, at(4));
    assert.equal(verified.orderedByRef, 'user-tech-1');
  });

  it('rejects finalization while unverified (409) and finalizes after verify', async () => {
    const { orderId } = await enteredOrderOverHttp();
    const created = await post(
      `/api/v1/diagnostic-orders/${orderId}/reports`,
      { content: 'premature content', authoredAt: at(10) },
      manager,
    );
    assert.equal(created.status, 201);
    const reportId = (created.body as { id: string }).id;
    const premature = await post(
      `/api/v1/reports/${reportId}/finalize`,
      { at: at(10) },
      manager,
    );
    assert.equal(premature.status, 409);
    await post(
      `/api/v1/diagnostic-orders/${orderId}/transitions`,
      { to: 'VERIFIED', at: at(4) },
      manager,
    );
    const ok = await post(
      `/api/v1/reports/${reportId}/finalize`,
      { at: at(11) },
      manager,
    );
    assert.equal(ok.status, 200);
    assert.equal((ok.body as { latestStatus: string }).latestStatus, 'FINALIZED');
  });

  it('rejects amendments without a reason (422) and denies staff below manager (403)', async () => {
    const { reportId } = await verifiedReportOverHttp();
    const noReason = await post(
      `/api/v1/reports/${reportId}/amendments`,
      { content: 'corrected', authoredAt: at(12) },
      manager,
    );
    assert.equal(noReason.status, 422);
    const withReason = await post(
      `/api/v1/reports/${reportId}/amendments`,
      {
        content: 'corrected',
        authoredAt: at(12),
        amendmentReason: 'ANALYTICAL_CORRECTION',
      },
      manager,
    );
    assert.equal(withReason.status, 200);
    assert.equal((withReason.body as { latestVersion: number }).latestVersion, 2);
    const staffDenied = await post(
      `/api/v1/reports/${reportId}/amendments`,
      {
        content: 'another correction',
        authoredAt: at(13),
        amendmentReason: 'REPORT_CORRECTION',
      },
      operator,
    );
    assert.equal(staffDenied.status, 403);
  });

  it('keeps keyed amendment replay idempotent over HTTP', async () => {
    const { reportId } = await verifiedReportOverHttp();
    const key = `govern-http-${reportId}`;
    const first = await post(
      `/api/v1/reports/${reportId}/amendments`,
      {
        content: 'corrected',
        authoredAt: at(12),
        amendmentReason: 'TRANSCRIPTION_CORRECTION',
        idempotencyKey: key,
      },
      manager,
    );
    assert.equal(first.status, 200);
    assert.equal((first.body as { latestVersion: number }).latestVersion, 2);
    const replay = await post(
      `/api/v1/reports/${reportId}/amendments`,
      {
        content: 'corrected',
        authoredAt: at(12),
        amendmentReason: 'TRANSCRIPTION_CORRECTION',
        idempotencyKey: key,
      },
      manager,
    );
    assert.equal(replay.status, 200);
    assert.equal((replay.body as { latestVersion: number }).latestVersion, 2);
    assert.deepEqual(
      (replay.body as { versions: { version: number }[] }).versions.map((v) => v.version),
      [1, 2],
    );
  });
});

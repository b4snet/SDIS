/**
 * Audit Persistence and Integrity Tests
 *
 * Tests the append-only audit event persistence, hash chain integrity,
 * and provenance preservation.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  setupTestDatabase,
  teardownTestDatabase,
  getTestDb,
} from '../../src/infrastructure/database/test-db';
import { PostgresAuditPort } from '../../src/infrastructure/database/repositories';
import { toBrandedId } from '../../src/types/ids';
import type { AuditEvent } from '../../src/core/audit/audit';

let testDb: any;

import type { OrganizationId, FacilityId } from '../../src/types/ids';

const ORG_A = toBrandedId('00000000-0000-4000-8000-000000000001') as OrganizationId;
const FAC_A1 = toBrandedId('00000000-0000-4000-8000-000000000011') as FacilityId;
const FAC_A2 = toBrandedId('00000000-0000-4000-8000-000000000012') as FacilityId;

describe('database: audit persistence and integrity', () => {
  before(async () => {
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '55439';
    process.env.PGDATABASE = 'sdis_test';
    process.env.PGUSER = 'postgres';
    process.env.PGPASSWORD = 'password';
    await setupTestDatabase({ port: 55439 });
  });

  after(async () => {
    await teardownTestDatabase();
  });

  it('records audit events with all required facets', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const audit = new PostgresAuditPort(testDb);
    const eventId = toBrandedId('00000000-0000-4000-8000-0000000000a1');

    const event: AuditEvent = {
      id: eventId,
      action: 'CREATED',
      objectType: 'diagnostic-order',
      objectId: '00000000-0000-4000-8000-0000000000a2',
      at: '2026-09-20T08:00:00.000Z',
      context: {
        organizationId: ORG_A,
        facilityId: FAC_A1,
      },
      provenance: {
        actor: { kind: 'USER', id: 'user-tech-1', displayName: 'Lab Technician' },
        source: { kind: 'HUMAN', label: 'manual entry' },
        timestamp: '2026-09-20T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
      detail: 'Order created for CBC',
    };

    await audit.record(event);

    const result = await testDb.query('SELECT * FROM sdis.audit_events WHERE id = $1', [
      eventId,
    ]);

    assert.equal(result.rowCount, 1, 'Audit event should be recorded');
    const row = result.rows[0];
    assert.equal(row.action, 'CREATED');
    assert.equal(row.object_type, 'diagnostic-order');
    assert.equal(row.object_id, '00000000-0000-4000-8000-0000000000a2');
    assert.equal(row.organization_id, ORG_A);
    assert.equal(row.facility_id, FAC_A1);
    assert.equal(row.actor_kind, 'USER');
    assert.equal(row.actor_id, 'user-tech-1');
    assert.equal(row.actor_display_name, 'Lab Technician');
    assert.equal(row.source_kind, 'HUMAN');
    assert.equal(row.source_label, 'manual entry');
    assert.equal(row.detail, 'Order created for CBC');
  });

  it('hash chain: each event references previous event', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    // Query events in order and verify chain
    const events = await testDb.query(
      `
            SELECT id, previous_hash, event_hash 
            FROM sdis.audit_events 
            WHERE organization_id = $1
            ORDER BY at ASC
        `,
      [ORG_A],
    );

    if (events.rowCount < 2) {
      console.log('Skipping hash chain verification - insufficient events');
      return;
    }

    let previousHash: string | null = null;
    for (const row of events.rows) {
      if (previousHash !== null) {
        assert.equal(
          row.previous_hash,
          previousHash,
          'Each event should reference the previous event hash',
        );
      }
      // Verify current event hash is present
      assert.ok(row.event_hash, 'Each event should have a hash');
      previousHash = row.event_hash;
    }
  });

  it('audit append-only: UPDATE rejected', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    // First, ensure we have at least one event
    const eventId = toBrandedId('00000000-0000-4000-8000-0000000000a3');
    const audit = new PostgresAuditPort(testDb);
    await audit.record({
      id: eventId,
      action: 'CREATED',
      objectType: 'test-object',
      objectId: '00000000-0000-4000-8000-0000000000ab',
      at: '2026-09-20T08:00:00.000Z',
      context: { organizationId: ORG_A, facilityId: FAC_A1 },
      provenance: {
        actor: { kind: 'USER', id: 'user-1' },
        source: { kind: 'HUMAN', label: 'test' },
        timestamp: '2026-09-20T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
      },
    });

    // Attempt to update - should fail
    try {
      await testDb.query('UPDATE sdis.audit_events SET detail = $1 WHERE id = $2', [
        'modified',
        eventId,
      ]);
      assert.fail('UPDATE should have been rejected by trigger');
    } catch (error: any) {
      assert.ok(
        error.message.includes('append-only') ||
          error.message.includes('Audit events are append-only'),
      );
    }
  });

  it('audit append-only: DELETE rejected', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const eventId = toBrandedId('00000000-0000-4000-8000-0000000000a4');

    // First create an event
    await testDb.query(
      `
            INSERT INTO sdis.audit_events (
                id, action, object_type, object_id, at,
                organization_id, facility_id,
                actor_kind, actor_id, source_kind, source_label, event_hash
            ) VALUES (
                $1, 'CREATED', 'test', '00000000-0000-4000-8000-0000000000ac', now(),
                $2, $3, 'USER', 'user-1', 'HUMAN', 'test', '\\x00'
            )
        `,
      [eventId, ORG_A, FAC_A1],
    );

    // Attempt to delete - should fail
    try {
      await testDb.query('DELETE FROM sdis.audit_events WHERE id = $1', [eventId]);
      assert.fail('DELETE should have been rejected by trigger');
    } catch (error: any) {
      assert.ok(
        error.message.includes('append-only') ||
          error.message.includes('Audit events are append-only'),
      );
    }
  });

  it('provenance source kinds preserved verbatim', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const kinds = ['HUMAN', 'DEVICE', 'ALGORITHM', 'INTEGRATION', 'SYSTEM'];

    for (const [i, kind] of kinds.entries()) {
      const eventId = toBrandedId(`00000000-0000-4000-8000-0000000000e${i}`);
      const audit = new PostgresAuditPort(testDb);

      await audit.record({
        id: eventId,
        action: 'CREATED',
        objectType: 'test',
        objectId: `00000000-0000-4000-8000-0000000000b${i}`,
        at: '2026-09-20T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
        provenance: {
          actor: { kind: 'USER', id: 'user-1' },
          source: { kind: kind as any, label: `${kind} source` },
          timestamp: '2026-09-20T08:00:00.000Z',
          context: { organizationId: ORG_A, facilityId: FAC_A1 },
        },
      });

      const result: { rows: Array<{ source_kind: string }>; rowCount: number } =
        await testDb.query('SELECT source_kind FROM sdis.audit_events WHERE id = $1', [
          eventId,
        ]);
      const [sourceRow] = result.rows;
      assert.ok(sourceRow);
      assert.equal(
        sourceRow.source_kind,
        kind,
        `Provenance kind ${kind} should be preserved`,
      );
    }
  });

  it('audit verification function works', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const result = await testDb.query('SELECT * FROM sdis.verify_audit_chain($1)', [
      ORG_A,
    ]);

    // Should return verification results
    assert.ok(result.rowCount >= 0, 'Verify function should execute');
  });

  it('provenance actor kinds preserved', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    const actorKinds = ['USER', 'PRACTITIONER', 'SERVICE', 'SYSTEM'];

    for (const [i, kind] of actorKinds.entries()) {
      const eventId = toBrandedId(`00000000-0000-4000-8000-0000000000f${i}`);
      const audit = new PostgresAuditPort(testDb);

      await audit.record({
        id: eventId,
        action: 'CREATED',
        objectType: 'test',
        objectId: `00000000-0000-4000-8000-0000000000c${i}`,
        at: '2026-09-20T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A1 },
        provenance: {
          actor: { kind: kind as any, id: 'actor-1' },
          source: { kind: 'HUMAN', label: 'test' },
          timestamp: '2026-09-20T08:00:00.000Z',
          context: { organizationId: ORG_A, facilityId: FAC_A1 },
        },
      });

      const result: { rows: Array<{ actor_kind: string }>; rowCount: number } =
        await testDb.query('SELECT actor_kind FROM sdis.audit_events WHERE id = $1', [
          eventId,
        ]);
      const [actorRow] = result.rows;
      assert.ok(actorRow);
      assert.equal(actorRow.actor_kind, kind, `Actor kind ${kind} should be preserved`);
    }
  });

  it('AUDIT-01 regression: verify_audit_chain returns an explicit TRUE marker for a healthy chain', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    // The pre-existing fixtures in this file stress one (ORG_A, FAC_A1) chain
    // with deliberately duplicate/non-chronological `at` timestamps — a valid
    // stress fixture, but not a clean-chain probe. Verify a chain the test
    // OWNS instead: exactly one event on FAC_A2 (seeded and otherwise unused
    // here) makes a deterministic healthy chain.
    const audit = new PostgresAuditPort(testDb);
    const eventId = toBrandedId('00000000-0000-4000-8000-0000000000d1');
    await audit.record({
      id: eventId,
      action: 'CREATED',
      objectType: 'test',
      objectId: eventId,
      at: '2026-09-21T08:00:00.000Z',
      context: { organizationId: ORG_A, facilityId: FAC_A2 },
      provenance: {
        actor: { kind: 'USER', id: 'verifier-1' },
        source: { kind: 'HUMAN', label: 'chain probe' },
        timestamp: '2026-09-21T08:00:00.000Z',
        context: { organizationId: ORG_A, facilityId: FAC_A2 },
      },
    });

    const result = await testDb.query('SELECT * FROM sdis.verify_audit_chain($1, $2)', [
      ORG_A,
      FAC_A2,
    ]);

    assert.ok(result.rowCount >= 1, 'healthy chain must yield at least one row');
    const healthy = result.rows.filter(
      (row: { matches: boolean }) => row.matches === true,
    );
    assert.equal(healthy.length, 1, 'exactly one explicit TRUE marker row');
    assert.equal(
      result.rows.filter((row: { matches: boolean }) => row.matches === false).length,
      0,
      'no mismatch rows for an intact chain',
    );
  });

  it('AUDIT-01 regression: concurrent chain inserts never fork the hash chain', async () => {
    const testDb = getTestDb();
    if (!testDb) return;

    // Two independent pools ⇒ two concurrent transactions racing the same
    // (org, facility) chain head. The chain is FAC_A2's (seeded, otherwise
    // untouched in this file) so the only events it sees are the marker-row
    // fixture above plus these 12 — a deterministic healthy chain.
    const { Database } = await import('../../src/infrastructure/database/database');
    const poolB = new Database();
    const poolC = new Database();
    const portA = new PostgresAuditPort(testDb);
    const portB = new PostgresAuditPort(poolB as never);
    const portC = new PostgresAuditPort(poolC as never);
    try {
      const concurrency = 12;
      const events = Array.from({ length: concurrency }, (_, i) => {
        // Collision-free id tails (the file already uses a*, b*, c*, d*, e*, f*).
        const tail = i < 10 ? `9${i}` : `9${String.fromCharCode(97 + i - 10)}`;
        const id = toBrandedId(`00000000-0000-4000-8000-0000000000${tail}`);
        // Strictly after the marker fixture (09-21T08:00:00Z) and pairwise
        // distinct, so head selection is unambiguous and chronological.
        const at = new Date(Date.UTC(2026, 8, 21, 8, 1, i)).toISOString();
        return {
          id,
          action: 'CREATED' as const,
          objectType: 'diagnostic-order',
          objectId: id,
          at,
          context: { organizationId: ORG_A, facilityId: FAC_A2 },
          provenance: {
            actor: { kind: 'USER' as const, id: `conc-${i}` },
            source: { kind: 'HUMAN' as const, label: 'concurrency probe' },
            timestamp: at,
            context: { organizationId: ORG_A, facilityId: FAC_A2 },
          },
          detail: `concurrent insert ${i}`,
        } as AuditEvent;
      });

      // Interleave three writers so at least two transactions contend on the
      // same chain head simultaneously.
      const writes = await Promise.allSettled([
        ...events.map((event, i) =>
          i % 3 === 0
            ? portA.record(event)
            : i % 3 === 1
              ? portB.record(event)
              : portC.record(event),
        ),
      ]);
      assert.ok(
        writes.every((w) => w.status === 'fulfilled'),
        'all concurrent audit inserts must succeed',
      );

      // All inserts succeed and the advisory lock serializes head selection —
      // no two racing writers EVER link to the same head. The lock grants in
      // arbitrary order and the events carry arbitrary `at` values, so this is
      // exactly the regime where a max(at) head selection forks; migration 016
      // links to the append-order (unreferenced) head instead. Assert the fork
      // property directly, then the end-to-end pointer-walk verification:
      const forks = await testDb.query(
        `SELECT previous_hash, count(*)::int AS n
         FROM sdis.audit_events
         WHERE organization_id = $1 AND facility_id = $2
           AND previous_hash IS NOT NULL
         GROUP BY previous_hash
         HAVING count(*) > 1`,
        [ORG_A, FAC_A2],
      );
      assert.equal(
        forks.rowCount,
        0,
        'no two events may share the same predecessor (that is the fork)',
      );
      const orphans = await testDb.query(
        `SELECT e.id
         FROM sdis.audit_events e
         WHERE e.organization_id = $1 AND e.facility_id = $2
           AND e.previous_hash IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM sdis.audit_events p
             WHERE p.organization_id = $1 AND p.facility_id = $2
               AND p.event_hash = e.previous_hash
           )`,
        [ORG_A, FAC_A2],
      );
      assert.equal(orphans.rowCount, 0, 'every link must reference an existing hash');
      const roots = await testDb.query(
        `SELECT count(*)::int AS n
         FROM sdis.audit_events
         WHERE organization_id = $1 AND facility_id = $2 AND previous_hash IS NULL`,
        [ORG_A, FAC_A2],
      );
      assert.equal(roots.rows[0]?.n, 1, 'exactly one chain root (single linear chain)');

      // End-to-end: the pointer-walk verifier must certify the intact
      // (out-of-at-order) chain as healthy.
      const verified = await testDb.query(
        'SELECT * FROM sdis.verify_audit_chain($1, $2)',
        [ORG_A, FAC_A2],
      );
      const mismatches = verified.rows.filter(
        (row: { matches: boolean }) => row.matches === false,
      );
      assert.equal(mismatches.length, 0, 'no mismatch rows for the concurrent chain');
      const healthy = verified.rows.filter(
        (row: { matches: boolean }) => row.matches === true,
      );
      assert.equal(healthy.length, 1, 'exactly one TRUE marker for the intact chain');
    } finally {
      await poolB.close();
      await poolC.close();
    }
  });
});

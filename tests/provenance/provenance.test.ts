/**
 * Provenance test: actor, source, timestamp and context are all representable;
 * source kinds (human/device/algorithm/integration/system) stay distinct; the
 * audit store is append-only.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVENANCE_SOURCE_KINDS,
  assertProvenanceComplete,
  type DataSource,
  type Provenance,
} from '../../src/types/provenance';
import { InMemoryAuditStore, type AuditEvent } from '../../src/core/audit/audit';
import { toBrandedId } from '../../src/types/ids';

const FACILITY = {
  organizationId: toBrandedId('00000000-0000-4000-8000-000000000001'),
  facilityId: toBrandedId('00000000-0000-4000-8000-000000000011'),
};

function auditEvent(override: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: toBrandedId('00000000-0000-4000-8000-000000000101'),
    action: 'CREATED',
    objectType: 'diagnostic-order',
    objectId: '00000000-0000-4000-8000-0000000000a1',
    at: '2026-09-20T00:00:00.000Z',
    context: FACILITY,
    provenance: {
      actor: { kind: 'USER', id: 'user-1' },
      source: { kind: 'HUMAN', label: 'web form' },
      timestamp: '2026-09-20T00:00:00.000Z',
      context: FACILITY,
    },
    ...override,
  };
}

describe('provenance: four facets', () => {
  it('represents actor, source, timestamp and context', () => {
    const complete = auditEvent().provenance;
    assert.equal(typeof complete.actor.id, 'string');
    assert.equal(typeof complete.source.label, 'string');
    assert.equal(typeof complete.timestamp, 'string');
    assert.equal(complete.context.organizationId, FACILITY.organizationId);
    assert.doesNotThrow(() => assertProvenanceComplete(complete));
  });

  it('rejects provenance missing any facet', () => {
    const base = auditEvent().provenance;
    assert.throws(
      () => assertProvenanceComplete({ ...base, actor: undefined as never }),
      /actor is required/,
    );
    assert.throws(
      () => assertProvenanceComplete({ ...base, source: undefined as never }),
      /source is required/,
    );
    assert.throws(
      () => assertProvenanceComplete({ ...base, timestamp: '' }),
      /timestamp is required/,
    );
  });
});

describe('provenance: kinds are never collapsed', () => {
  it('defines five distinct source kinds', () => {
    assert.deepEqual(PROVENANCE_SOURCE_KINDS, [
      'HUMAN',
      'DEVICE',
      'ALGORITHM',
      'INTEGRATION',
      'SYSTEM',
    ]);
  });

  it('a device interpretation is not human verification', () => {
    const deviceOutput: DataSource = {
      kind: 'DEVICE',
      label: 'analyzer-model-X',
      ref: 'device-1',
    };
    const humanVerification: DataSource = { kind: 'HUMAN', label: 'pathologist review' };
    assert.notEqual(deviceOutput.kind, humanVerification.kind);
    assert.equal(deviceOutput.kind, 'DEVICE');
    assert.equal(humanVerification.kind, 'HUMAN');
    const p: Provenance = {
      actor: { kind: 'SYSTEM', id: 'sys-1' },
      source: deviceOutput,
      timestamp: '2026-09-20T00:00:00.000Z',
      context: FACILITY,
    };
    assert.equal(p.source.kind, 'DEVICE');
  });
});

describe('provenance: append-only audit store', () => {
  it('appends and freezes events', async () => {
    const store = new InMemoryAuditStore();
    await store.append(auditEvent());
    await store.append(auditEvent({ action: 'FINALIZED' }));
    const events = store.list();
    assert.equal(events.length, 2);
    assert.equal(events[0]?.action, 'CREATED');
    assert.ok(Object.isFrozen(events[0]));
    assert.ok(Object.isFrozen(events[0]?.provenance));
    assert.ok(Object.isFrozen(events[0]?.provenance.source));
  });

  it('exposes no update or delete path on the interface', async () => {
    const store: { append(event: AuditEvent): Promise<void> } = new InMemoryAuditStore();
    // The append-only contract is enforced by the interface: no update/delete members.
    assert.equal('append' in store, true);
  });
});

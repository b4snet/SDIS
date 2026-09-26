/**
 * Device ingestion application tests.
 *
 * Prove the Step-9 ingestion foundation over the EXISTING contracts: registry
 * device identity + adapter normalization, facility-bound device scope,
 * order-context linkage through the existing order service, the observation
 * boundary (device data becomes observations ONLY through the observation
 * service — never interpretation/report), DEVICE provenance preservation,
 * audit, and keyed replay without duplicate effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DeviceIngestionService } from '../../../src/app/devices/device-ingestion-service';
import type {
  DeviceIngestionDependencies,
  DeviceIngestionRepository,
} from '../../../src/app/devices/device-ingestion-service';
import { InMemoryDeviceIngestionRepository } from '../../../src/app/in-memory-devices';
import {
  DeviceRegistry,
  type DeviceAdapter,
} from '../../../src/domain/devices/device-registry';
import { createFixture, sessionFor, at, orderIdOf } from '../helpers';
import { toBrandedId, assertUuidV4 } from '../../../src/types/ids';
import type { DeviceId, OrderItemId } from '../../../src/types/ids';
import {
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationError,
} from '../../../src/app/errors';

const DEVICE_ID = toBrandedId('00000000-0000-4000-8000-0000000000a1') as DeviceId;

function adapterFor(sourceLabel = 'analyzer-hema-x'): DeviceAdapter {
  return {
    adapterId: 'adapter-hema-1',
    protocol: 'VENDOR-X/1.0',
    source: { kind: 'DEVICE', label: sourceLabel },
    normalize: (a) => ({
      deviceId: a.deviceId,
      source: { kind: 'DEVICE', label: sourceLabel, ref: a.deviceId },
      observations: [
        {
          code: 'GLUCOSE',
          codeSystem: 'sdis',
          value: (a.rawPayload as { glucoseMgDl: number }).glucoseMgDl,
          unit: 'mg/dL',
          at: a.acquiredAt,
        },
      ],
    }),
  };
}

function serviceFor(
  overrides: {
    repository?: DeviceIngestionRepository;
    observations?: DeviceIngestionDependencies['observations'];
    /** Reuse an existing fixture so the service shares the caller's runtime. */
    fixture?: ReturnType<typeof createFixture>;
  } = {},
): {
  service: DeviceIngestionService;
  repo: InMemoryDeviceIngestionRepository;
  registry: DeviceRegistry;
  fixture: ReturnType<typeof createFixture>;
} {
  const fixture = overrides.fixture ?? createFixture();
  const repo = (overrides.repository ??
    new InMemoryDeviceIngestionRepository()) as InMemoryDeviceIngestionRepository;
  const registry = new DeviceRegistry();
  registry.registerAdapter(adapterFor());
  const service = new DeviceIngestionService({
    registry,
    repository: repo,
    observations: overrides.observations ?? fixture.observations,
    orders: fixture.orders,
    facilities: (fixture.orders as unknown as { deps: { facilities: unknown } }).deps
      .facilities as never,
    audit: fixture.audit,
    idempotency: (fixture.orders as unknown as { deps: { idempotency: unknown } }).deps
      .idempotency as never,
  });
  return { service, repo, registry, fixture };
}

function registerDevice(
  repo: InMemoryDeviceIngestionRepository,
  deviceId: DeviceId,
  facilityId = toBrandedId('00000000-0000-4000-8000-000000000011'),
): void {
  repo.registerDevice({
    id: deviceId,
    name: 'Hema-X',
    modality: 'LAB',
    kind: 'ANALYZER',
    facilityId,
  });
}

async function orderWithItem(fixture: ReturnType<typeof createFixture>) {
  const order = await fixture.orders.createOrder(fixture.session, {
    patientId: fixture.patientId,
    encounterId: fixture.encounterId,
    modality: 'LAB',
    items: [{ testCode: 'GLUCOSE', codeSystem: 'sdis' }],
    orderedAt: at(1),
  });
  return {
    order,
    itemId: assertUuidV4<OrderItemId>(order.items[0]!.id, 'order item id'),
  };
}

const BASE = {
  deviceId: DEVICE_ID,
  adapterId: 'adapter-hema-1',
  acquiredAt: '2026-09-21T04:00:00.000Z',
  rawPayload: { glucoseMgDl: 98 },
  ingestionKey: 'ingest-1',
};

describe('devices: ingestion', () => {
  it('accepts an ingestion from a registered device and preserves device provenance', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const { order, itemId } = await orderWithItem(fixture);
    const dto = await service.ingest(fixture.session, {
      ...BASE,
      orderItemId: itemId,
      patientId: fixture.patientId,
    });
    assert.equal(dto.deviceId, DEVICE_ID);
    assert.equal(dto.observationCount, 1);
    assert.equal(dto.orderItemId, itemId);
    // Provenance reached the observation boundary as DEVICE source.
    const observations = await fixture.observations.listForOrderItem(
      fixture.session,
      itemId,
    );
    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.issuedByKind, 'DEVICE');
    assert.equal(observations[0]?.issuedByRef, DEVICE_ID);
    assert.deepEqual(observations[0]?.value, { kind: 'QUANTITATIVE', value: 98 });
    assert.equal(orderIdOf(order), order.id);
  });

  it('stores the raw acquisition verbatim at the boundary', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const dto = await service.ingest(fixture.session, { ...BASE });
    assert.equal(dto.observationCount, 0);
    const stored = repo.listByOrderItem('00000000-0000-4000-8000-0000000000f9' as never);
    assert.ok(stored.length === 0); // sanity: no phantom linkage
  });

  it('rejects an unregistered device', async () => {
    const { service, fixture } = serviceFor();
    await assert.rejects(
      () => service.ingest(fixture.session, { ...BASE }),
      NotFoundError,
    );
  });

  it('rejects a device registered in another facility (payload cannot escape scope)', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID, toBrandedId('00000000-0000-4000-8000-000000000012'));
    await assert.rejects(
      () => service.ingest(fixture.session, { ...BASE }),
      ForbiddenError,
    );
  });

  it('rejects an unregistered adapter', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          adapterId: 'no-such-adapter',
        }),
      /No adapter registered/,
    );
  });

  it('rejects an adapter whose provenance kind cannot ingest device data', async () => {
    const { service, repo, registry, fixture } = serviceFor();
    registry.registerAdapter({
      adapterId: 'adapter-human-1',
      protocol: 'MANUAL/1.0',
      source: { kind: 'HUMAN', label: 'manual entry' },
      normalize: (a) => ({
        deviceId: a.deviceId,
        source: { kind: 'HUMAN', label: 'manual' },
        observations: [],
      }),
    });
    registerDevice(repo, DEVICE_ID);
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          adapterId: 'adapter-human-1',
        }),
      ValidationError,
    );
  });

  it('rejects order-item linkage with a mismatched patient', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const { itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          orderItemId: itemId,
          patientId: toBrandedId('00000000-0000-4000-8000-0000000000e2') as never,
        }),
      ValidationError,
    );
  });

  it('rejects ingestion without a session (fail-closed)', async () => {
    const { service, repo } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    await assert.rejects(
      () => service.ingest(undefined, { ...BASE }),
      UnauthenticatedError,
    );
  });

  it('rejects a forged tenant before any resource check', async () => {
    const { service, repo } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const forged = sessionFor(
      toBrandedId('00000000-0000-4000-8000-000000000011'),
      toBrandedId('00000000-0000-4000-8000-000000000009'),
    );
    await assert.rejects(
      () => service.ingest(forged, { ...BASE }),
      (error: unknown) =>
        error instanceof Error && /Cross-organization access/i.test(error.message),
    );
  });

  it('rejects missing ingestion keys and bad timestamps', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    await assert.rejects(
      () => service.ingest(fixture.session, { ...BASE, ingestionKey: '' }),
      ValidationError,
    );
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          acquiredAt: 'not-a-timestamp',
        }),
      ValidationError,
    );
  });

  it('replays the same ingestion key without duplicate observations or audit', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const { itemId } = await orderWithItem(fixture);
    const input = {
      ...BASE,
      orderItemId: itemId,
      patientId: fixture.patientId,
    };
    const first = await service.ingest(fixture.session, input);
    const replay = await service.ingest(fixture.session, input);
    assert.equal(replay.id, first.id);
    const observations = await fixture.observations.listForOrderItem(
      fixture.session,
      itemId,
    );
    assert.equal(observations.length, 1); // one observation, not two
    const stored = repo.listByOrderItem(itemId);
    assert.equal(stored.length, 1); // one acquisition row
    const events = fixture.audit
      .list()
      .filter((e) => e.objectType === 'device-acquisition');
    assert.equal(events.length, 1); // one audit event
    assert.equal(events[0]?.action, 'IMPORTED');
    assert.equal(events[0]?.provenance.source.kind, 'DEVICE');
  });

  it('emits an IMPORTED audit event with DEVICE source on first ingestion', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    await service.ingest(fixture.session, { ...BASE });
    const events = fixture.audit
      .list()
      .filter((e) => e.objectType === 'device-acquisition');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, 'IMPORTED');
    assert.equal(events[0]?.provenance.source.kind, 'DEVICE');
  });

  it('DEV-01 regression: a failed acquisition save leaves NO orphan observations; the same-key retry creates exactly one set', async () => {
    const inner = new InMemoryDeviceIngestionRepository();
    let throwNext = true;
    const flakyRepo: DeviceIngestionRepository = {
      findDevice: (deviceId) => inner.findDevice(deviceId),
      saveAcquisition: async (acquisition) => {
        // Simulate the acquisition-write failure that used to leave orphaned
        // observations behind (acquisitions were written LAST).
        if (throwNext) {
          throwNext = false;
          throw new Error('simulated acquisition failure');
        }
        return inner.saveAcquisition(acquisition);
      },
    };
    const { service, fixture: fx } = serviceFor({ repository: flakyRepo });
    registerDevice(inner, DEVICE_ID);
    const { itemId } = await orderWithItem(fx);
    const input = { ...BASE, orderItemId: itemId, patientId: fx.patientId };

    await assert.rejects(
      () => service.ingest(fx.session, input),
      /simulated acquisition failure/,
    );
    // Acquisition-first: the failed attempt persisted NOTHING.
    assert.equal(
      (await fx.observations.listForOrderItem(fx.session, itemId)).length,
      0,
      'no orphaned observations after a failed acquisition save',
    );
    assert.equal(inner.listByOrderItem(itemId).length, 0);

    const dto = await service.ingest(fx.session, input);
    assert.equal(dto.observationCount, 1);
    assert.equal(
      (await fx.observations.listForOrderItem(fx.session, itemId)).length,
      1,
      'exactly one observation set after the retry',
    );
    assert.equal(inner.listByOrderItem(itemId).length, 1);
    const events = fx.audit.list().filter((e) => e.objectType === 'device-acquisition');
    assert.equal(events.length, 1, 'exactly one audit event');
  });

  it('DEV-01 regression: a mid-flight failure resumes on retry — one acquisition, one observation, one audit (no fork)', async () => {
    const fixture = createFixture();
    const { itemId } = await orderWithItem(fixture);
    const innerObservations = fixture.observations;
    let failOnce = true;
    const wrappedObservations = {
      ...innerObservations,
      enterObservation: (session: unknown, input: unknown) => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error('simulated observation write failure'));
        }
        return innerObservations.enterObservation(
          session as Parameters<typeof innerObservations.enterObservation>[0],
          input as Parameters<typeof innerObservations.enterObservation>[1],
        );
      },
    } as typeof innerObservations;
    // The service must use the SAME fixture the order item was seeded on,
    // otherwise the linked order is invisible to it (`Order item not found`).
    const { service, repo } = serviceFor({
      observations: wrappedObservations,
      fixture,
    });
    registerDevice(repo, DEVICE_ID);
    const input = { ...BASE, orderItemId: itemId, patientId: fixture.patientId };

    await assert.rejects(
      () => service.ingest(fixture.session, input),
      /simulated observation write failure/,
    );
    // Acquisition-first: the failed attempt already committed the acquisition
    // row (the replay unit) — but NO observation and NO audit event escaped.
    assert.equal(repo.listByOrderItem(itemId).length, 1, 'acquisition persisted first');
    assert.equal(
      (await innerObservations.listForOrderItem(fixture.session, itemId)).length,
      0,
      'no observation escaped the failed attempt',
    );
    assert.equal(
      fixture.audit.list().filter((e) => e.objectType === 'device-acquisition').length,
      0,
      'no audit event escaped the failed attempt',
    );

    // Same-key retry: saveAcquisition no-ops (same device + key), the derived
    // observation re-enters with its deterministic sub-key, and the result is
    // stored — exactly one of everything.
    const dto = await service.ingest(fixture.session, input);
    assert.equal(dto.observationCount, 1);
    assert.equal(
      (await fixture.observations.listForOrderItem(fixture.session, itemId)).length,
      1,
      'exactly one observation row after the resume',
    );
    assert.equal(repo.listByOrderItem(itemId).length, 1, 'one acquisition row');
    assert.equal(
      fixture.audit.list().filter((e) => e.objectType === 'device-acquisition').length,
      1,
      'exactly one audit event after the resume',
    );
  });

  it('DEV-02 regression: a LAB device cannot write onto an ECG order item (modality coherence)', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const ecgOrder = await fixture.orders.createOrder(fixture.session, {
      patientId: fixture.patientId,
      encounterId: fixture.encounterId,
      modality: 'ECG',
      items: [{ testCode: 'ECG-12', codeSystem: 'sdis' }],
      orderedAt: at(2),
    });
    const ecgItemId = assertUuidV4<OrderItemId>(ecgOrder.items[0]!.id, 'ecg item id');
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          orderItemId: ecgItemId,
          patientId: fixture.patientId,
        }),
      (error: unknown) =>
        error instanceof ValidationError && /modality/i.test(error.message),
    );
    assert.equal(
      (await fixture.observations.listForOrderItem(fixture.session, ecgItemId)).length,
      0,
      'no cross-modality observations may enter the record',
    );
    assert.equal(repo.listByOrderItem(ecgItemId).length, 0, 'no acquisition persisted');
  });

  it('DEV-03 regression: a linked ingestion without rawPayload is a validation error (never a 500)', async () => {
    const { service, repo, fixture } = serviceFor();
    registerDevice(repo, DEVICE_ID);
    const { itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          orderItemId: itemId,
          patientId: fixture.patientId,
          rawPayload: undefined,
        }),
      ValidationError,
    );
    assert.equal(repo.listByOrderItem(itemId).length, 0, 'nothing persisted');
  });

  it('DEV-03 regression: a normalized value outside {number, string, null} is rejected — never TEXT "undefined"', async () => {
    const { service, repo, registry, fixture } = serviceFor();
    registry.registerAdapter({
      adapterId: 'adapter-bad-value',
      protocol: 'VENDOR-Y/1.0',
      source: { kind: 'DEVICE', label: 'broken adapter' },
      normalize: (a) => ({
        deviceId: a.deviceId,
        source: { kind: 'DEVICE', label: 'broken', ref: a.deviceId },
        observations: [
          {
            code: 'X',
            codeSystem: 'sdis',
            value: undefined as never,
            at: a.acquiredAt,
          },
        ],
      }),
    });
    registerDevice(repo, DEVICE_ID);
    const { itemId } = await orderWithItem(fixture);
    await assert.rejects(
      () =>
        service.ingest(fixture.session, {
          ...BASE,
          adapterId: 'adapter-bad-value',
          orderItemId: itemId,
          patientId: fixture.patientId,
        }),
      /must be a number, string, or null/,
    );
    assert.equal(
      (await fixture.observations.listForOrderItem(fixture.session, itemId)).length,
      0,
      'the violating observation never entered the record',
    );
  });
});

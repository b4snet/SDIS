/**
 * Device integration contract test: registry → adapter → acquisition →
 * normalization preserves device provenance. No real hardware is involved.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceRegistry,
  type DeviceAcquisition,
  type DeviceAdapter,
  type NormalizedResult,
} from '../../src/domain/devices/device-registry';
import { toBrandedId } from '../../src/types/ids';

const DEVICE_ID = toBrandedId('00000000-0000-4000-8000-0000000000a1');

const acquisition: DeviceAcquisition = {
  deviceId: DEVICE_ID,
  adapterId: 'adapter-hema-1',
  acquiredAt: '2026-09-20T04:00:00.000Z',
  ingestedAt: '2026-09-20T04:00:02.000Z',
  rawPayload: { glucoseMgDl: 98 },
};

const adapter: DeviceAdapter = {
  adapterId: 'adapter-hema-1',
  protocol: 'VENDOR-X/1.0',
  source: { kind: 'DEVICE', label: 'analyzer-hema-x', ref: 'device-1' },
  normalize(a: DeviceAcquisition): NormalizedResult {
    return {
      deviceId: a.deviceId,
      source: { kind: 'DEVICE', label: 'analyzer-hema-x', ref: a.deviceId },
      observations: [
        {
          code: 'GLUCOSE',
          codeSystem: 'sdis',
          value: (a.rawPayload as { glucoseMgDl: number }).glucoseMgDl,
          unit: 'mg/dL',
          at: a.acquiredAt,
        },
      ],
    };
  },
};

describe('devices: registry → adapter → observation', () => {
  it('registers an analyzer device on the LAB modality', () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({
      id: DEVICE_ID,
      name: 'Hema-X',
      model: 'HemaX-100',
      modality: 'LAB',
      kind: 'ANALYZER',
    });
    assert.equal(registry.findDevice(DEVICE_ID)?.name, 'Hema-X');
    assert.equal(registry.listByModality('LAB').length, 1);
    assert.equal(registry.listByModality('ECG').length, 0);
  });

  it('normalization preserves device provenance', () => {
    const registry = new DeviceRegistry();
    registry.registerDevice({
      id: DEVICE_ID,
      name: 'Hema-X',
      modality: 'LAB',
      kind: 'ANALYZER',
    });
    registry.registerAdapter(adapter);
    const boundAdapter = registry.acquire('adapter-hema-1');
    const result = boundAdapter.normalize(acquisition);
    assert.equal(result.deviceId, DEVICE_ID);
    assert.equal(result.source.kind, 'DEVICE');
    assert.equal(result.observations[0]?.value, 98);
    // adapter timestamp and ingestion timestamp are both preserved at acquisition
    assert.equal(acquisition.acquiredAt, '2026-09-20T04:00:00.000Z');
    assert.equal(acquisition.ingestedAt, '2026-09-20T04:00:02.000Z');
  });

  it('acquisition with an unknown adapter is rejected', () => {
    const registry = new DeviceRegistry();
    assert.throws(() => registry.acquire('no-such-adapter'), /No adapter registered/);
  });
});

/**
 * SDIS device boundary — registry, adapter, acquisition, normalization.
 *
 * Devices (analyzers, ECG/EEG/PFT/TMT/Echo/ultrasound) enter the platform ONLY
 * through adapters. Provenance preserves: source device, adapter, acquisition
 * timestamp, ingestion timestamp, and interpretation source. No real hardware is
 * connected in Step 1.
 */

import type { DeviceId } from '../../types/ids';
import type { DataSource, ProvenanceSourceKind } from '../../types/provenance';
import type { ModalityName } from '../../types/modality';

export interface Device {
  readonly id: DeviceId;
  readonly name: string;
  readonly model?: string;
  readonly modality: ModalityName;
  readonly kind:
    'ANALYZER' | 'ECG' | 'EEG' | 'PFT' | 'TMT' | 'ECHO' | 'ULTRASOUND' | 'OTHER';
}

export interface DeviceAcquisition {
  readonly deviceId: DeviceId;
  readonly adapterId: string;
  readonly acquiredAt: string;
  readonly ingestedAt: string;
  /** Opaque vendor payload — normalized into observations by the adapter. */
  readonly rawPayload: unknown;
}

export interface DeviceAdapter {
  readonly adapterId: string;
  readonly protocol: string;
  /** Adapts raw vendor data into normalized observation-shaped records. */
  normalize(acquisition: DeviceAcquisition): NormalizedResult;
  readonly source: DataSource;
}

export interface NormalizedResult {
  readonly deviceId: DeviceId;
  readonly source: DataSource;
  readonly observations: readonly NormalizedObservation[];
}

export interface NormalizedObservation {
  readonly code: string;
  readonly codeSystem: string;
  readonly value: number | string | null;
  readonly unit?: string;
  readonly at: string;
}

export class DeviceRegistry {
  private readonly devices = new Map<DeviceId, Device>();
  private readonly adapters = new Map<string, DeviceAdapter>();

  registerDevice(device: Device): void {
    if (this.devices.has(device.id)) throw new Error('Device already registered');
    this.devices.set(device.id, device);
  }

  registerAdapter(adapter: DeviceAdapter): void {
    if (this.adapters.has(adapter.adapterId))
      throw new Error('Adapter already registered');
    this.adapters.set(adapter.adapterId, adapter);
  }

  acquire(adapterId: string): DeviceAdapter {
    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new Error(`No adapter registered for "${adapterId}"`);
    return adapter;
  }

  findDevice(id: DeviceId): Device | undefined {
    return this.devices.get(id);
  }

  listByModality(modality: ModalityName): readonly Device[] {
    return [...this.devices.values()].filter((d) => d.modality === modality);
  }
}

/** Provenance kinds that a device adapter may claim. */
export function isDeviceSource(kind: ProvenanceSourceKind): boolean {
  return kind === 'DEVICE' || kind === 'ALGORITHM' || kind === 'INTEGRATION';
}

/**
 * In-memory device ingestion repository (test/development adapter) mirroring
 * migration 010 semantics: devices are facility-registered; acquisitions carry
 * device/adapter/timestamp metadata and a UNIQUE ingestion key.
 */

import type { DeviceId, OrderItemId, PatientId } from '../types/ids';
import type { DeviceIngestionRepository } from './devices/device-ingestion-service';
import { ConflictError } from './errors';

interface DeviceEntry {
  readonly id: DeviceId;
  readonly name: string;
  readonly modality: string;
  readonly kind: string;
  readonly facilityId: string;
}

interface AcquisitionEntry {
  readonly id: string;
  readonly deviceId: DeviceId;
  readonly orderItemId?: OrderItemId;
  readonly patientId?: PatientId;
  readonly facilityId: string;
  readonly adapterId: string;
  readonly acquiredAt: string;
  readonly ingestedAt: string;
  readonly rawPayload: unknown;
  readonly ingestionKey: string;
}

export class InMemoryDeviceIngestionRepository implements DeviceIngestionRepository {
  private readonly devices = new Map<DeviceId, DeviceEntry>();
  private readonly acquisitions = new Map<string, AcquisitionEntry>();
  private readonly byKey = new Map<string, string>();

  registerDevice(device: DeviceEntry): void {
    this.devices.set(device.id, device);
  }

  async findDevice(deviceId: DeviceId) {
    const device = this.devices.get(deviceId);
    return device ?? undefined;
  }

  async saveAcquisition(acquisition: AcquisitionEntry): Promise<string> {
    const existingId = this.byKey.get(acquisition.ingestionKey);
    if (existingId !== undefined) {
      // DEV-01 replay derivation: a retry after a mid-flight failure finds the
      // acquisition already persisted. The same device + key resumes (the
      // observations re-enter with deterministic sub-keys); a key reused by a
      // DIFFERENT device is a genuine conflict.
      const existing = this.acquisitions.get(existingId);
      if (existing?.deviceId === acquisition.deviceId) {
        return existing.id;
      }
      throw new ConflictError('An acquisition with this ingestion key already exists');
    }
    this.acquisitions.set(acquisition.id, acquisition);
    this.byKey.set(acquisition.ingestionKey, acquisition.id);
    return acquisition.id;
  }

  /** Test/debug read view (not part of the port). */
  listByOrderItem(orderItemId: OrderItemId): readonly AcquisitionEntry[] {
    return [...this.acquisitions.values()].filter((a) => a.orderItemId === orderItemId);
  }
}

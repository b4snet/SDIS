/**
 * PostgreSQL Device Ingestion Repository.
 *
 * Implements the `DeviceIngestionRepository` port against migration 010
 * (`sdis.devices`, `sdis.device_acquisitions`). The ingestion key is UNIQUE at
 * the schema level (durable retry safety); scope filtering is applied by the
 * application service using the session and RLS remains the database guarantee.
 */

import type { DeviceIngestionRepository } from '../../app/devices/device-ingestion-service';
import type { DeviceId, OrderItemId, PatientId } from '../../types/ids';
import { ConflictError } from '../../app/errors';
import { Database, getDatabase } from './database';

interface DeviceRow {
  id: string;
  name: string;
  modality: string;
  kind: string;
  facility_id: string;
}

export class PostgresDeviceIngestionRepository implements DeviceIngestionRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async findDevice(deviceId: DeviceId) {
    const result = await this.db.query<DeviceRow>(
      `SELECT id, name, modality, kind, facility_id FROM sdis.devices WHERE id = $1`,
      [deviceId],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id as DeviceId,
          name: row.name,
          modality: row.modality,
          kind: row.kind,
          facilityId: row.facility_id,
        }
      : undefined;
  }

  async saveAcquisition(acquisition: {
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
  }): Promise<string> {
    try {
      const inserted = await this.db.query<{ id: string }>(
        `INSERT INTO sdis.device_acquisitions
                (id, device_id, order_item_id, patient_id, facility_id, adapter_id,
                 acquired_at, ingested_at, raw_payload, ingestion_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             RETURNING id`,
        [
          acquisition.id,
          acquisition.deviceId,
          acquisition.orderItemId ?? null,
          acquisition.patientId ?? null,
          acquisition.facilityId,
          acquisition.adapterId,
          acquisition.acquiredAt,
          acquisition.ingestedAt,
          JSON.stringify(acquisition.rawPayload ?? null),
          acquisition.ingestionKey,
        ],
      );
      return inserted.rows[0]?.id ?? acquisition.id;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        (error as { code?: string }).code === '23505'
      ) {
        // DEV-01 replay derivation: a retry after a mid-flight failure finds the
        // acquisition row already persisted (the acquisition is the replay
        // unit). A repeat insert for the SAME device + ingestion key is a
        // resume — observations are re-derived idempotently upstream. A key
        // reused by a DIFFERENT device is a genuine conflict.
        const existing = await this.db.query<{ id: string }>(
          `SELECT id FROM sdis.device_acquisitions
             WHERE ingestion_key = $1 AND device_id = $2`,
          [acquisition.ingestionKey, acquisition.deviceId],
        );
        if (existing.rows[0]) {
          return existing.rows[0].id;
        }
        throw new ConflictError('An acquisition with this ingestion key already exists');
      }
      throw error;
    }
  }
}

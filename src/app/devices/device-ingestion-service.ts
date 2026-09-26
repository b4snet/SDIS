/**
 * SDIS device ingestion application service.
 *
 * Accepts a NORMALIZED acquisition from a REGISTERED device and persists it at
 * the ingestion boundary. This service composes the EXISTING contracts —
 * there is NO second device registry, modality registry, observation model,
 * or provenance system:
 *
 * - `DeviceRegistry` (domain): device identity, adapter resolution,
 *   modality match, and normalization of the raw payload;
 * - `ObservationService` (existing laboratory service): the ONLY path from
 *   acquisition to observation records — preserving
 *   Observation ≠ Interpretation ≠ Report (device data never becomes an
 *   interpretation or report here, and no clinical rule is evaluated);
 * - the acquisition record itself is persisted raw (opaque payload verbatim)
 *   with device identity, adapter, acquired-at and ingested-at timestamps.
 *
 * Scope (docs/TENANCY.md): the device must be registered in the SESSION
 * facility — a payload can never move an acquisition into another facility or
 * organization. When an order-item context is supplied, the order must be
 * scope-verified and belong to the device's facility (server-derived only).
 *
 * Provenance: the acquisition's observation provenance is the ADAPTER's
 * declared source (kind DEVICE/ALGORITHM/INTEGRATION with the device id as
 * ref) — device provenance is never collapsed into human/system.
 */

import { randomUUID } from 'node:crypto';
import {
  DeviceRegistry,
  isDeviceSource,
  type DeviceAcquisition,
  type NormalizedObservation,
} from '../../domain/devices/device-registry';
import type { DeviceId, OrderItemId, PatientId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ForbiddenError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';
import { type ObservationService } from '../laboratory/observation-service';
import { type OrderService } from '../laboratory/order-service';

/** Persistence port for the ingestion boundary (devices + raw acquisitions). */
export interface DeviceIngestionRepository {
  findDevice(deviceId: DeviceId): Promise<
    | {
        readonly id: DeviceId;
        readonly name: string;
        readonly modality: string;
        readonly kind: string;
        readonly facilityId: string;
      }
    | undefined
  >;
  /** Persists the raw acquisition with device/adapter/timestamp metadata. */
  saveAcquisition(acquisition: {
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
    /**
     * Returns the ACTUALLY persisted acquisition id — on a same-key resume
     * (DEV-01) this is the id of the row committed by the earlier attempt, so
     * the returned DTO and audit reference the real stored row.
     */
  }): Promise<string>;
}

export interface IngestAcquisitionInput {
  readonly deviceId: DeviceId;
  readonly adapterId: string;
  readonly acquiredAt: string;
  /** Opaque vendor payload — normalized by the registered adapter. */
  readonly rawPayload: unknown;
  /**
   * Optional diagnostic context. When supplied, the order item must exist,
   * belong to a scope-verified order in the device's facility, and carry the
   * given patient. Without it, the acquisition is stored raw and stops at the
   * ingestion boundary (no observation is created).
   */
  readonly orderItemId?: OrderItemId;
  readonly patientId?: PatientId;
  /** Stable key making ingestion retry-safe. */
  readonly ingestionKey: string;
}

export interface AcquisitionDTO {
  readonly id: string;
  readonly deviceId: string;
  readonly adapterId: string;
  readonly modality: string;
  readonly facilityId: string;
  readonly acquiredAt: string;
  readonly ingestedAt: string;
  /** Number of observations created (0 when no order-item context was given). */
  readonly observationCount: number;
  /** Order-item context when the acquisition was linked to the workflow. */
  readonly orderItemId?: string;
  readonly patientId?: string;
}

export interface DeviceIngestionDependencies {
  readonly registry: DeviceRegistry;
  readonly repository: DeviceIngestionRepository;
  /** The EXISTING observation path — acquisitions never bypass it. */
  readonly observations: ObservationService;
  readonly orders: OrderService;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

export class DeviceIngestionService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: DeviceIngestionDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Ingests one normalized acquisition. Retry-safe via the existing
   * idempotency engine keyed on `ingestionKey`. A replay returns the stored
   * result and repeats NO side effect (no duplicate acquisition, observations,
   * or audit events).
   */
  async ingest(
    session: ApplicationSession | undefined,
    input: IngestAcquisitionInput,
  ): Promise<AcquisitionDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.DEVICE_INGEST);
    await assertSessionFacility(session, this.deps.facilities);
    if (!input.deviceId || !input.adapterId) {
      throw new ValidationError('An ingestion requires a device and an adapter');
    }
    if (!input.acquiredAt || Number.isNaN(new Date(input.acquiredAt).getTime())) {
      throw new ValidationError('An acquisition requires a valid acquired-at timestamp');
    }
    if (!input.ingestionKey) {
      throw new ValidationError('An ingestion requires a stable ingestion key');
    }
    if (input.orderItemId !== undefined && input.patientId === undefined) {
      throw new ValidationError(
        'Linking an acquisition to an order item requires the patient',
      );
    }
    // DEV-03: a linked acquisition MUST carry the vendor payload — the adapter
    // derives the observations from it. Omitted payloads are rejected here
    // (422 upstream), never allowed to become a "undefined"-shaped value.
    if (
      input.orderItemId !== undefined &&
      (input.rawPayload === undefined || input.rawPayload === null)
    ) {
      throw new ValidationError(
        'Linking an acquisition to an order item requires a raw payload',
      );
    }
    return runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.DEVICE_INGEST,
      input.ingestionKey,
      () => this.ingestOnce(session, input),
      session,
    );
  }

  private async ingestOnce(
    session: ApplicationSession,
    input: IngestAcquisitionInput,
  ): Promise<AcquisitionDTO> {
    // Device identity is validated against the registry-backed store — an
    // unregistered device is a 404 (no registration oracle for callers).
    const device = await this.deps.repository.findDevice(input.deviceId);
    if (!device) throw new NotFoundError('Device not found');
    // The device is bound to its registration facility: payloads cannot
    // escape into another facility or organization.
    if (device.facilityId !== session.facilityId) {
      throw new ForbiddenError('Device is registered in another facility');
    }
    // Modality/device contract: the adapter must be registered and its
    // normalization source must be a device-capable provenance kind.
    const adapter = this.deps.registry.acquire(input.adapterId);
    if (!isDeviceSource(adapter.source.kind)) {
      throw new ValidationError('The adapter source kind cannot ingest device data');
    }

    // Optional workflow context: the order is scope-verified by the EXISTING
    // order service, and must belong to the device's facility.
    if (input.orderItemId !== undefined) {
      const order = await this.deps.orders.requireScopedOrderByItem(
        session,
        input.orderItemId,
      );
      if (input.patientId !== undefined && order.patientId !== input.patientId) {
        throw new ValidationError('Patient does not match the order patient');
      }
      // DEV-02: the device's modality and the order's modality are the same
      // coherent diagnostic domain — a LAB analyzer must not write onto an
      // ECG order item (cross-modality observations never enter the record).
      if (order.modality !== device.modality) {
        throw new ValidationError(
          `Device modality ${device.modality} does not match order modality ${order.modality}`,
        );
      }
    }

    const acquisition: DeviceAcquisition = {
      deviceId: input.deviceId,
      adapterId: input.adapterId,
      acquiredAt: input.acquiredAt,
      ingestedAt: new Date().toISOString(),
      rawPayload: input.rawPayload,
    };

    // DEV-01: the acquisition row is THE replay unit — it MUST be persisted
    // before any derived observation is entered. A failed run can then be
    // retried with the same key (the store no-ops a repeat insert), and each
    // derived observation carries a deterministic sub-key so re-derivation is
    // idempotent: exactly one observation row per derived value, one
    // acquisition row, one audit event — never a partial orphan set.
    const id = randomUUID() as string & { readonly __brand: 'AcquisitionId' };
    const acquisitionId = await this.deps.repository.saveAcquisition({
      id: id as unknown as string,
      deviceId: input.deviceId,
      ...(input.orderItemId !== undefined ? { orderItemId: input.orderItemId } : {}),
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
      facilityId: device.facilityId,
      adapterId: input.adapterId,
      acquiredAt: acquisition.acquiredAt,
      ingestedAt: acquisition.ingestedAt,
      rawPayload: input.rawPayload,
      ingestionKey: input.ingestionKey,
    });

    let observationCount = 0;
    if (input.orderItemId !== undefined && input.patientId !== undefined) {
      // The ADAPTER owns normalization (existing domain boundary). Device
      // provenance (kind + label + device id ref) is preserved verbatim.
      const result = adapter.normalize(acquisition);
      for (const [observationIndex, observation] of result.observations.entries()) {
        await this.deps.observations.enterObservation(session, {
          orderItemId: input.orderItemId,
          patientId: input.patientId,
          code: observation.code,
          codeSystem: observation.codeSystem,
          value: toObservationValue(observation),
          ...(observation.unit ? { unit: observation.unit } : {}),
          issuedBy: adapterSource(adapter, input.deviceId),
          at: observation.at,
          idempotencyKey: `${input.ingestionKey}:observation:${observationIndex}`,
        });
        observationCount += 1;
      }
    }

    await this.audit.record(session, {
      action: 'IMPORTED',
      objectType: 'device-acquisition',
      objectId: acquisitionId,
      at: acquisition.ingestedAt,
      source: adapterSource(adapter, input.deviceId),
      detail: `device ${device.name} acquisition via ${input.adapterId} (${observationCount} observations)`,
    });

    return {
      id: acquisitionId,
      deviceId: input.deviceId,
      adapterId: input.adapterId,
      modality: device.modality,
      facilityId: device.facilityId,
      acquiredAt: acquisition.acquiredAt,
      ingestedAt: acquisition.ingestedAt,
      observationCount,
      ...(input.orderItemId !== undefined ? { orderItemId: input.orderItemId } : {}),
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
    };
  }
}

/** The adapter's declared source, refined with the concrete device id. */
function adapterSource(adapter: { source: DataSource }, deviceId: DeviceId): DataSource {
  return {
    kind: adapter.source.kind,
    label: adapter.source.label,
    ref: adapter.source.ref ?? deviceId,
  };
}

/** Maps a normalized value onto the existing ObservationValue union. */
function toObservationValue(
  observation: NormalizedObservation,
): import('../../domain/results/observation').ObservationValue {
  const value = observation.value;
  // DEV-03: only the declared value union is accepted — a contract-violating
  // `undefined` (or any other shape) is rejected, never stringified into
  // TEXT "undefined".
  if (typeof value === 'number') {
    return { kind: 'QUANTITATIVE', value };
  }
  if (typeof value === 'string') {
    return { kind: 'TEXT', text: value };
  }
  if (value === null) {
    return { kind: 'TEXT', text: '' };
  }
  throw new ValidationError(
    'Normalized observation value must be a number, string, or null',
  );
}

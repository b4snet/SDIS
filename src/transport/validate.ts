/**
 * SDIS HTTP transport — request-shape validation.
 *
 * The transport validates TRANSPORT CONCERNS ONLY: presence, JSON shape,
 * encodings, and identifier format. Clinical/domain lifecycle rules, scope,
 * and identity semantics are validated exclusively by the application services
 * (Checkpoint: "Do not duplicate domain lifecycle rules in controllers").
 *
 * Identifier format is the Step-1 contract: UUID v4 branded ids
 * (`src/types/ids.ts`). Timestamps must be ISO-8601 instants. Provenance
 * source kinds must be one of the five NEVER-collapsed kinds
 * (`src/types/provenance.ts`).
 */

import { isUuidV4 } from '../types/ids';
import type {
  ChargeId,
  DepartmentId,
  DeviceId,
  DiagnosticOrderId,
  DocumentId,
  EncounterId,
  InventoryItemId,
  NotificationIntentId,
  OrderItemId,
  PatientId,
  QualityRecordId,
  ReportId,
  SetupConfigId,
  SpecimenId,
  TerminologyMappingId,
} from '../types/ids';
import { PROVENANCE_SOURCE_KINDS, type DataSource } from '../types/provenance';
import type { ObservationValue } from '../domain/results/observation';
import { TransportFailure } from './errors';

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function bad(message: string): TransportFailure {
  return new TransportFailure(422, message);
}

export function requireObject(body: Json | undefined): Record<string, Json> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('Request body must be a JSON object');
  }
  return body;
}

/** A required nested JSON object field (e.g. an opaque vendor payload). */
export function requireObjectField(
  obj: Record<string, Json>,
  field: string,
): Record<string, Json> {
  const value = obj[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`Field "${field}" is required and must be a JSON object`);
  }
  return value;
}

export function requiredString(obj: Record<string, Json>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw bad(`Field "${field}" is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  obj: Record<string, Json>,
  field: string,
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw bad(`Field "${field}" must be a string`);
  }
  return value;
}

/** Timestamps are transport-representable instants; semantics live below. */
export function requiredTimestamp(obj: Record<string, Json>, field: string): string {
  const value = requiredString(obj, field);
  if (Number.isNaN(new Date(value).getTime())) {
    throw bad(`Field "${field}" must be an ISO-8601 timestamp`);
  }
  return value;
}

export function requiredUuid<T extends string>(
  obj: Record<string, Json>,
  field: string,
): T {
  const value = requiredString(obj, field);
  if (!isUuidV4(value)) {
    throw bad(`Field "${field}" must be a UUID v4 identifier`);
  }
  return value as T;
}

export function requiredSource(obj: Record<string, Json>, field: string): DataSource {
  const value = obj[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`Field "${field}" must be an object with kind/label`);
  }
  const kind = (value as Record<string, Json>)['kind'];
  const label = (value as Record<string, Json>)['label'];
  if (typeof kind !== 'string' || !PROVENANCE_SOURCE_KINDS.includes(kind as never)) {
    throw bad(
      `Field "${field}.kind" must be one of ${PROVENANCE_SOURCE_KINDS.join(', ')}`,
    );
  }
  if (typeof label !== 'string' || label.length === 0) {
    throw bad(`Field "${field}.label" is required and must be a non-empty string`);
  }
  const ref = (value as Record<string, Json>)['ref'];
  if (ref !== undefined && ref !== null && typeof ref !== 'string') {
    throw bad(`Field "${field}.ref" must be a string`);
  }
  const source: DataSource = { kind: kind as DataSource['kind'], label };
  return ref !== undefined && ref !== null && typeof ref === 'string'
    ? { ...source, ref }
    : source;
}

/** Value kinds mirror the domain ObservationValue union — no extra kinds. */
export function requiredObservationValue(
  obj: Record<string, Json>,
  field: string,
): ObservationValue {
  const value = obj[field];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw bad(`Field "${field}" must be an object with a kind discriminator`);
  }
  const v = value as Record<string, Json>;
  switch (v['kind']) {
    case 'QUANTITATIVE': {
      if (typeof v['value'] !== 'number' || !Number.isFinite(v['value'])) {
        throw bad('Field "value.value" must be a finite number for QUANTITATIVE');
      }
      return { kind: 'QUANTITATIVE', value: v['value'] };
    }
    case 'QUALITATIVE':
    case 'TEXT': {
      if (typeof v['text'] !== 'string' || v['text'].length === 0) {
        throw bad(`Field "value.text" must be a non-empty string for ${v['kind']}`);
      }
      return { kind: v['kind'], text: v['text'] };
    }
    case 'CODED': {
      if (typeof v['code'] !== 'string' || v['code'].length === 0) {
        throw bad('Field "value.code" must be a non-empty string for CODED');
      }
      if (typeof v['codeSystem'] !== 'string' || v['codeSystem'].length === 0) {
        throw bad('Field "value.codeSystem" must be a non-empty string for CODED');
      }
      return { kind: 'CODED', code: v['code'], codeSystem: v['codeSystem'] };
    }
    default:
      throw bad(
        'Field "value.kind" must be one of QUANTITATIVE, QUALITATIVE, CODED, TEXT',
      );
  }
}

export function requiredItems(
  obj: Record<string, Json>,
  field: string,
): { testCode: string; codeSystem: string }[] {
  const value = obj[field];
  if (!Array.isArray(value) || value.length === 0) {
    throw bad(`Field "${field}" must be a non-empty array`);
  }
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw bad(`Field "${field}" entries must be objects`);
    }
    const item = entry as Record<string, Json>;
    return {
      testCode: requiredString(item, 'testCode'),
      codeSystem: requiredString(item, 'codeSystem'),
    };
  });
}

/** Branded-id parsers for values re-entering the application boundary. */
function parseUuidPath<T extends string>(segment: string, value: string): T {
  // Path-boundary defence (BILL-03 / TERM-03 family): malformed ids must fail
  // as VALIDATION (422) at the transport, never reach the store as a raw cast
  // (PostgreSQL would raise 22P02 → an internal 500).
  if (!isUuidV4(value)) {
    throw bad(`Path segment "${segment}" must be a UUID v4 identifier`);
  }
  return value as T;
}

export const parsePatientId = (v: string): PatientId => parseUuidPath('patientId', v);
export const parseEncounterId = (v: string): EncounterId =>
  parseUuidPath('encounterId', v);
export const parseOrderId = (v: string): DiagnosticOrderId => parseUuidPath('orderId', v);
export const parseOrderItemId = (v: string): OrderItemId =>
  parseUuidPath('orderItemId', v);
export const parseSpecimenId = (v: string): SpecimenId => parseUuidPath('specimenId', v);
export const parseReportId = (v: string): ReportId => parseUuidPath('reportId', v);
export const parseDocumentId = (v: string): DocumentId => parseUuidPath('documentId', v);
export const parseInventoryItemId = (v: string): InventoryItemId =>
  parseUuidPath('inventoryItemId', v);
export const parseDepartmentId = (v: string): DepartmentId =>
  parseUuidPath('departmentId', v);
export const parseSetupConfigId = (v: string): SetupConfigId =>
  parseUuidPath('setupConfigId', v);
export const parseQualityRecordId = (v: string): QualityRecordId =>
  parseUuidPath('qualityRecordId', v);
export const parseChargeId = (v: string): ChargeId => parseUuidPath('chargeId', v);
export const parseTerminologyMappingId = (v: string): TerminologyMappingId =>
  parseUuidPath('mappingId', v);
export const parseDeviceId = (v: string): DeviceId => parseUuidPath('deviceId', v);
export const parseNotificationIntentId = (v: string): NotificationIntentId =>
  parseUuidPath('notificationIntentId', v);

/** A JSON integer field that must be a positive version number (422 otherwise). */
export function requiredVersionNumber(obj: Record<string, Json>, field: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw bad(`Field "${field}" must be a positive integer`);
  }
  return value;
}

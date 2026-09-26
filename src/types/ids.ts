/**
 * SDIS core identifier types.
 *
 * Every identifier in the system is a UUID v4 string wrapped in a branded type so
 * that cross-entity confusion (e.g. treating an OrderItemId as a SpecimenId) is a
 * compile-time error.
 *
 * These are foundational contracts. They are not database tables.
 */

declare const sdisId: unique symbol;

type BrandedId<Name extends string> = string & { readonly [sdisId]: Name };

export type OrganizationId = BrandedId<'OrganizationId'>;
export type FacilityId = BrandedId<'FacilityId'>;
export type DepartmentId = BrandedId<'DepartmentId'>;
export type PractitionerId = BrandedId<'PractitionerId'>;
export type UserId = BrandedId<'UserId'>;
export type PatientId = BrandedId<'PatientId'>;
export type EncounterId = BrandedId<'EncounterId'>;
export type DiagnosticOrderId = BrandedId<'DiagnosticOrderId'>;
export type OrderItemId = BrandedId<'OrderItemId'>;
export type SpecimenId = BrandedId<'SpecimenId'>;
export type ObservationId = BrandedId<'ObservationId'>;
export type InterpretationId = BrandedId<'InterpretationId'>;
export type ReportId = BrandedId<'ReportId'>;
export type ReportVersionId = BrandedId<'ReportVersionId'>;
export type DeviceId = BrandedId<'DeviceId'>;
export type DocumentId = BrandedId<'DocumentId'>;
export type BillableServiceId = BrandedId<'BillableServiceId'>;
export type ChargeId = BrandedId<'ChargeId'>;
export type InvoiceId = BrandedId<'InvoiceId'>;
export type PaymentId = BrandedId<'PaymentId'>;
export type AuditEventId = BrandedId<'AuditEventId'>;
export type InventoryItemId = BrandedId<'InventoryItemId'>;
export type SetupConfigId = BrandedId<'SetupConfigId'>;
export type TerminologyMappingId = BrandedId<'TerminologyMappingId'>;
export type QualityRecordId = BrandedId<'QualityRecordId'>;
export type NotificationEventId = BrandedId<'NotificationEventId'>;
export type NotificationIntentId = BrandedId<'NotificationIntentId'>;
export type NotificationDeliveryAttemptId = BrandedId<'NotificationDeliveryAttemptId'>;

/** Validates a UUID v4 string (RFC 4122 variant). */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

/** Asserts that `value` is a valid UUID v4 and returns it as the branded type. */
export function assertUuidV4<Id extends string>(value: string, label: string): Id {
  if (!isUuidV4(value)) {
    throw new TypeError(`Invalid ${label}: expected a UUID v4, got "${value}"`);
  }
  return value as Id;
}

/**
 * Type-safe alias used to construct a branded identifier from already-validated
 * input. The `never` brand is assignable to every specific brand, so the result
 * can stand in for any branded id — it still cannot be passed where a plain
 * `string` (e.g. an unvalidated API payload) is required pre-validation.
 */
export function toBrandedId(value: string): string & { readonly [sdisId]: never } {
  return value as string & { readonly [sdisId]: never };
}

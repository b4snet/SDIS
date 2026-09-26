/**
 * SDIS document boundary — metadata + object storage abstraction.
 *
 * Scanned documents and generated artifacts (requisitions, referrals, reports,
 * consents, certificates, SOPs...) are referenced by metadata; the bytes live
 * behind a storage abstraction. The architecture is NOT bound to local filesystem
 * storage. No S3/cloud claim is made unless actually configured.
 */

import type { DocumentId, FacilityId, OrderItemId, PatientId } from '../../types/ids';

export type DocumentType =
  | 'REQUISITION'
  | 'REFERRAL'
  | 'REPORT'
  | 'CONSENT'
  | 'PATIENT_DOCUMENT'
  | 'BILLING_DOCUMENT'
  | 'QUALITY_DOCUMENT'
  | 'CALIBRATION_CERTIFICATE'
  | 'SOP'
  | 'CERTIFICATE'
  | 'OTHER';

/**
 * Document lifecycle (Step 23). Documents are NEVER physically deleted:
 * clinical records carry retention obligations, so removal of access is a
 * first-class RETIRED state instead — metadata and content remain intact and
 * auditable, but the document is no longer retrievable through either the
 * staff or the patient boundary.
 */
export type DocumentStatus = 'ACTIVE' | 'RETIRED';

/** A retired document never returns to ACTIVE (retirement is one-way). */
export function canRetireDocument(meta: { readonly status?: DocumentStatus }): boolean {
  return (meta.status ?? 'ACTIVE') === 'ACTIVE';
}

export interface DocumentLocation {
  readonly provider: 'LOCAL_FS' | 'OBJECT_STORE';
  readonly ref: string;
  readonly encrypted: boolean;
}

export interface DocumentMetadata {
  readonly id: DocumentId;
  readonly documentType: DocumentType;
  readonly facilityId: FacilityId;
  readonly patientId?: PatientId;
  readonly orderId?: OrderItemId;
  readonly location: DocumentLocation;
  readonly version: number;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly uploadedAt: string;
  /** Retention window; deletion/archival is a governed process. */
  readonly retentionUntil?: string;
  /**
   * Lifecycle state (Step 23). Defaults to ACTIVE for documents created
   * before the field existed. Retired documents keep metadata + content
   * (no physical deletion) but are no longer retrievable.
   */
  readonly status?: DocumentStatus;
  /**
   * Explicit patient-access eligibility (Step 23). Documents are NOT
   * patient-visible by default — a document becomes visible only when the
   * uploading principal deliberately marks it so. Never derived from the
   * document type alone.
   */
  readonly patientVisible?: boolean;
}

/** Documents containing identity must be stored encrypted. */
export function assertStorageSafety(meta: DocumentMetadata): void {
  const canIdentify =
    meta.patientId !== undefined ||
    meta.documentType === 'REPORT' ||
    meta.documentType === 'CONSENT' ||
    meta.documentType === 'CERTIFICATE';
  if (canIdentify && !meta.location.encrypted) {
    throw new Error('Document location must be encrypted when it can identify a patient');
  }
}

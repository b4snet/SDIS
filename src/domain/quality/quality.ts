/**
 * SDIS Quality Management boundary — first-class, contract-only in Step 1.
 *
 * Reserved families: SOPs, document control, training, competency, calibration,
 * maintenance, QC, IQC, EQA/PT, nonconformities, corrective/preventive actions,
 * risk management, incidents, internal audit, quality indicators, records retention.
 *
 * Documenting these families is NOT accreditation readiness.
 */

import type { FacilityId } from '../../types/ids';
import type { Provenance } from '../../types/provenance';

export type QualityFamily =
  | 'SOP'
  | 'DOCUMENT_CONTROL'
  | 'TRAINING'
  | 'COMPETENCY'
  | 'CALIBRATION'
  | 'MAINTENANCE'
  | 'QC'
  | 'IQC'
  | 'EQA'
  | 'NONCONFORMITY'
  | 'CORRECTIVE_ACTION'
  | 'PREVENTIVE_ACTION'
  | 'RISK'
  | 'INCIDENT'
  | 'INTERNAL_AUDIT'
  | 'QUALITY_INDICATOR'
  | 'RECORDS_RETENTION';

export interface QualityRecord {
  readonly family: QualityFamily;
  readonly facilityId: FacilityId;
  /** What the record refers to (device, document, batch, ...). */
  readonly referenceType: string;
  readonly referenceId?: string;
  readonly at: string;
  readonly provenance: Provenance;
}

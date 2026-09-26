/**
 * SDIS Master Setup boundary — administrative configuration domain.
 *
 * Configuration source-of-truth rules:
 * - Every configuration record is scoped and versioned.
 * - Billing/tax-like values are date-effective and source-versioned; no statutory
 *   rules are invented.
 */

import type { FacilityContext } from '../../types/tenant';

export type ConfigFamily =
  | 'ORGANIZATION'
  | 'FACILITY'
  | 'DEPARTMENT'
  | 'LAB_SECTION'
  | 'TEST_CATALOG'
  | 'SPECIMEN_TYPE'
  | 'UNIT'
  | 'REFERENCE_RANGE'
  | 'PACKAGE'
  | 'PRICING'
  | 'BILLING_CONFIG'
  | 'REPORT_TEMPLATE'
  | 'USER'
  | 'ROLE'
  | 'PERMISSION'
  | 'DEVICE'
  | 'ANALYZER'
  | 'MODALITY'
  | 'DOCUMENT_TYPE'
  | 'QUALITY_SETTING'
  | 'NOTIFICATION_SETTING';

export interface ConfigRecord {
  readonly family: ConfigFamily;
  readonly context: FacilityContext;
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  /** Source of the value, e.g. a regulatory version when statutory. */
  readonly sourceVersion?: string;
  readonly effectiveFrom: string;
}

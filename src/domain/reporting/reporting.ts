/**
 * SDIS reporting boundary — HMIS Reports and Daily Reports as first-class domains.
 *
 * Report logic is NEVER hard-coded into transactional controllers. Aggregation
 * happens against reporting read models with explicit access controls.
 */

import type { FacilityContext } from '../../types/tenant';

export type ReportCategory =
  | 'REGISTRATION'
  | 'INVESTIGATION'
  | 'LABORATORY'
  | 'WORKLOAD'
  | 'TURNAROUND_TIME'
  | 'CRITICAL_VALUES'
  | 'QUALITY'
  | 'REVENUE'
  | 'INVENTORY'
  | 'DAILY_ACTIVITY'
  | 'DEPARTMENT'
  | 'FACILITY'
  | 'ORGANIZATION';

export type DailyReportMetric =
  | 'REGISTRATIONS'
  | 'INVESTIGATIONS'
  | 'SPECIMENS'
  | 'RESULTS'
  | 'BILLING'
  | 'REVENUE'
  | 'INVENTORY_MOVEMENTS'
  | 'CRITICAL_VALUES'
  | 'TURNAROUND_METRICS'
  | 'OPERATIONAL_WORKLOAD';

export interface ReportPeriod {
  readonly from: string;
  readonly to: string;
}

export interface ReportRequest {
  readonly category: ReportCategory;
  readonly context: FacilityContext;
  readonly period: ReportPeriod;
  readonly metrics?: readonly DailyReportMetric[];
}

export interface ReportResult {
  readonly category: ReportCategory;
  readonly context: FacilityContext;
  readonly period: ReportPeriod;
  readonly rows: readonly unknown[];
  readonly generatedAt: string;
}

export interface ReportExecutor {
  execute(request: ReportRequest): Promise<ReportResult>;
}

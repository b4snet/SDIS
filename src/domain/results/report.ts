/**
 * SDIS diagnostic report contract — the clinical communication artifact.
 *
 * Immutability rules:
 * - FINALIZED reports are immutable.
 * - Corrections are AMENDMENTS: a new report version is created that supersedes the
 *   previous version. Prior versions are never silently rewritten.
 */

import type {
  DiagnosticOrderId,
  FacilityId,
  PatientId,
  ReportId,
  ReportVersionId,
} from '../../types/ids';
import { randomUUID } from 'node:crypto';

export type ReportStatus = 'DRAFT' | 'FINALIZED';

export interface ReportVersion {
  readonly id: ReportVersionId;
  readonly reportId: ReportId;
  readonly version: number;
  readonly status: ReportStatus;
  readonly content: string;
  readonly authoredByRef: string;
  readonly authoredAt: string;
  readonly finalizedAt?: string;
  readonly supersedesVersionId?: ReportVersionId;
  /**
   * Amendment reason (Step 28) — REQUIRED on every superseding version and
   * absent on v1/initial versions. Bounded operational vocabulary; the reason
   * is governance metadata, never clinical content.
   */
  readonly amendmentReason?: ReportAmendmentReason;
}

/**
 * Bounded amendment vocabulary (Step 28). Operational correction categories
 * only — never a clinical statement and never a diagnosis.
 */
export const REPORT_AMENDMENT_REASONS = [
  'TRANSCRIPTION_CORRECTION',
  'ANALYTICAL_CORRECTION',
  'ADMINISTRATIVE_CORRECTION',
  'REPORT_CORRECTION',
] as const;

export type ReportAmendmentReason = (typeof REPORT_AMENDMENT_REASONS)[number];

export function isReportAmendmentReason(value: unknown): value is ReportAmendmentReason {
  return (
    typeof value === 'string' &&
    (REPORT_AMENDMENT_REASONS as readonly string[]).includes(value)
  );
}

export interface DiagnosticReport {
  readonly id: ReportId;
  readonly orderId: DiagnosticOrderId;
  readonly patientId: PatientId;
  readonly facilityId: FacilityId;
  readonly versions: readonly ReportVersion[];
}

export function createReport(
  input: Omit<ReportVersion, 'id' | 'version' | 'status' | 'supersedesVersionId'> & {
    reportId: ReportId;
  } & Pick<DiagnosticReport, 'orderId' | 'patientId' | 'facilityId'>,
): DiagnosticReport {
  const v1: ReportVersion = {
    id: randomUUID() as ReportVersionId,
    ...input,
    version: 1,
    status: 'DRAFT',
  };
  return { ...input, id: input.reportId, versions: [v1] };
}

/** Finalization marks the current head version immutable. */
export function finalizeReport(
  report: DiagnosticReport,
  finalizedAt: string,
  authorRef: string,
): DiagnosticReport {
  const head = report.versions[report.versions.length - 1];
  if (!head) throw new Error('Report has no versions');
  if (head.status === 'FINALIZED') {
    throw new Error('Report is already finalized — no silent overwrite');
  }
  const frozenHead: ReportVersion = Object.freeze({
    ...head,
    status: 'FINALIZED',
    finalizedAt,
    authoredByRef: authorRef,
  });
  const versions = [...report.versions.slice(0, -1), frozenHead];
  return Object.freeze({ ...report, versions: Object.freeze(versions) });
}

/**
 * Amendment creates a NEW version (version+1) that supersedes the head.
 * The prior finalized version is never mutated. The head must be FINALIZED
 * (Step 28: amendments govern issued reports, not drafts — a draft is simply
 * edited through creation-time rules). A reason from the bounded vocabulary
 * is mandatory; empty/whitespace reasons are rejected.
 */
export function amendReport(
  report: DiagnosticReport,
  newContent: string,
  authoredByRef: string,
  authoredAt: string,
  newVersionId: ReportVersionId,
  amendmentReason: ReportAmendmentReason,
): DiagnosticReport {
  const head = report.versions[report.versions.length - 1];
  if (!head) throw new Error('Report has no versions');
  if (head.status !== 'FINALIZED') {
    throw new Error('Only a FINALIZED report can be amended — edit the draft instead');
  }
  if (!isReportAmendmentReason(amendmentReason)) {
    throw new Error('A report amendment requires a reason from the bounded vocabulary');
  }
  const amendment: ReportVersion = {
    id: newVersionId,
    reportId: report.id,
    version: head.version + 1,
    status: 'DRAFT',
    content: newContent,
    authoredByRef,
    authoredAt,
    supersedesVersionId: head.id,
    amendmentReason,
  };
  return {
    ...report,
    versions: Object.freeze([...report.versions, amendment]),
  };
}

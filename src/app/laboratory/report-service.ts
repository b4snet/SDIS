/**
 * SDIS report application service.
 *
 * The report is the clinical communication artifact (docs/CLINICAL_SAFETY.md §2).
 * FINALIZED reports are immutable — the domain enforces it and this service
 * preserves it. Corrections are AMENDMENTS producing a new version that
 * supersedes the head; prior versions are never silently rewritten.
 */

import { randomUUID } from 'node:crypto';
import {
  amendReport,
  createReport,
  finalizeReport,
  isReportAmendmentReason,
  REPORT_AMENDMENT_REASONS,
  type DiagnosticReport,
  type ReportAmendmentReason,
} from '../../domain/results/report';
import type { DiagnosticOrderId, ReportId, ReportVersionId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertResourceInFacilityScope,
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { toReportDTO, type ReportDTO } from '../dto';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type {
  AuditPort,
  FacilityDirectory,
  IdempotencyStore,
  ReportRepository,
} from '../ports';
import { type OrderService } from './order-service';

const REPORT_ENTRY_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'application report entry',
};

export interface CreateReportInput {
  readonly orderId: DiagnosticOrderId;
  readonly content: string;
  readonly authoredByRef: string;
  readonly authoredAt: string;
  readonly idempotencyKey?: string;
  readonly source?: DataSource;
}

export interface AmendedReportInput {
  readonly reportId: ReportId;
  readonly content: string;
  readonly authoredByRef: string;
  readonly authoredAt: string;
  /**
   * REQUIRED amendment reason (Step 28) — bounded vocabulary from the domain.
   * A missing/out-of-vocabulary reason is a 422; governance metadata is never
   * silently defaulted.
   */
  readonly amendmentReason: string;
  /** Optional stable key: a keyed replay returns the stored amended report. */
  readonly idempotencyKey?: string;
  readonly source?: DataSource;
}

export interface ReportServiceDependencies {
  readonly orders: OrderService;
  readonly facilities: FacilityDirectory;
  readonly reports: ReportRepository;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
  /**
   * Optional QC boundary (Step 27): when wired, finalization is refused while
   * the facility has an active analytical hold (409). QC NEVER rewrites
   * patient results — it can only pause the workflow, auditable both sides.
   */
  readonly qualityHoldProbe?: () => Promise<string | undefined>;
}

export class ReportService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: ReportServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Creates the draft report (version 1) for an order. Content is assembled by
   * the caller — nothing is auto-generated, and no clinical rules are applied.
   */
  async createReport(
    session: ApplicationSession | undefined,
    input: CreateReportInput,
  ): Promise<ReportDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.REPORT_CREATE);
    if (!input.content || !input.content.trim()) {
      throw new ValidationError('A report requires content');
    }
    if (!input.authoredAt) {
      throw new ValidationError('A report requires an authored-at timestamp');
    }
    const order = await this.deps.orders.requireScopedOrder(session, input.orderId);

    const source = input.source ?? REPORT_ENTRY_SOURCE;
    const report = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.REPORT_CREATE,
      input.idempotencyKey,
      () =>
        this.createWithAudit(session, input, order.patientId, order.facilityId, source),
      session,
    );
    return toReportDTO(report);
  }

  private async createWithAudit(
    session: ApplicationSession,
    input: CreateReportInput,
    patientId: DiagnosticReport['patientId'],
    facilityId: DiagnosticReport['facilityId'],
    source: DataSource,
  ): Promise<DiagnosticReport> {
    const reportId = randomUUID() as ReportId;
    const report = createReport({
      reportId,
      orderId: input.orderId,
      patientId,
      facilityId,
      content: input.content,
      authoredByRef: input.authoredByRef,
      authoredAt: input.authoredAt,
    });
    await this.deps.reports.save(report);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'diagnostic-report',
      objectId: reportId,
      at: input.authoredAt,
      source,
    });
    return report;
  }

  /**
   * Finalizes the head version. An already-finalized report throws CONFLICT —
   * there is no silent overwrite path. Keyed callers get retry-safety: a replay
   * with the same idempotency key returns the stored finalized report instead
   * of surfacing a false CONFLICT.
   */
  async finalizeReport(
    session: ApplicationSession | undefined,
    reportId: ReportId,
    finalizerRef: string,
    at: string,
    options: {
      readonly source?: DataSource;
      readonly idempotencyKey?: string;
    } = {},
  ): Promise<ReportDTO> {
    requireSession(session);
    // Finalization is a report-producing authorization act (same tier that
    // may create/verify diagnostic content; no separate finalize permission).
    await this.deps.authz?.assertPermission(session, PERMISSIONS.REPORT_CREATE);
    // QC hold boundary (Step 27): an active analytical hold pauses the
    // workflow — an operational act, never a clinical judgement on results.
    if (this.deps.qualityHoldProbe) {
      const hold = await this.deps.qualityHoldProbe();
      if (hold) {
        throw new ConflictError(
          'Report finalization is on analytical hold; release the hold to proceed',
        );
      }
    }
    const source = options.source ?? REPORT_ENTRY_SOURCE;
    const finalized = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.REPORT_FINALIZE,
      options.idempotencyKey,
      () => this.finalizeOnce(session, reportId, finalizerRef, at, source),
      session,
    );
    return toReportDTO(finalized);
  }

  private async finalizeOnce(
    session: ApplicationSession,
    reportId: ReportId,
    finalizerRef: string,
    at: string,
    source: DataSource,
  ): Promise<DiagnosticReport> {
    const report = await this.requireScopedReport(session, reportId);
    const head = report.versions[report.versions.length - 1];
    if (!head) throw new ConflictError('Report has no versions');
    if (head.status === 'FINALIZED') {
      throw new ConflictError('Report is already finalized — no silent overwrite');
    }
    // Result-governance gate (Step 28): a report finalizes only AFTER the
    // underlying diagnostic content was VERIFIED (order lifecycle
    // RESULT_ENTERED → VERIFIED → FINALIZED). Amendments re-finalize the new
    // version; the verification gate applies to the ORDER's content, which
    // stays verified — so FINALIZED orders may proceed to REPORTED.
    const order = await this.deps.orders.getOrder(session, report.orderId);
    if (
      order &&
      order.status !== 'VERIFIED' &&
      order.status !== 'FINALIZED' &&
      order.status !== 'REPORTED'
    ) {
      throw new ConflictError(
        `Diagnostic content must be VERIFIED before the report finalizes (current: ${order.status})`,
      );
    }
    const finalized = finalizeReport(report, at, finalizerRef);
    await this.deps.reports.save(finalized);
    await this.audit.record(session, {
      action: 'FINALIZED',
      objectType: 'diagnostic-report',
      objectId: report.id,
      at,
      source,
      detail: `version ${head.version} finalized`,
    });
    return finalized;
  }

  /**
   * Amendment creates a new superseding version (version+1). The prior version
   * is never mutated. Only the authoritative finalizer may amend. Keyed
   * callers get retry-safety: a replay returns the stored amended report and
   * creates NO additional version.
   */
  async amendReport(
    session: ApplicationSession | undefined,
    input: AmendedReportInput,
  ): Promise<ReportDTO> {
    requireSession(session);
    // Amendment authorization (Step 28): issuing a correction to an already
    // finalized/communicated report is an administrative act above ordinary
    // result entry — the manager tier holds it (SETUP_MANAGE). Amendment
    // permission is NOT granted merely by being able to create reports.
    await this.deps.authz?.assertPermission(session, PERMISSIONS.REPORT_AMEND);
    if (!input.content || !input.content.trim()) {
      throw new ValidationError('An amended report requires content');
    }
    if (!input.authoredAt) {
      throw new ValidationError('An amended report requires an authored-at timestamp');
    }
    if (!isReportAmendmentReason(input.amendmentReason)) {
      throw new ValidationError(
        'A report amendment requires a reason from the bounded vocabulary: ' +
          REPORT_AMENDMENT_REASONS.join(', '),
      );
    }
    const amended = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.REPORT_AMEND,
      input.idempotencyKey,
      () => this.amendOnce(session, input),
      session,
    );
    return toReportDTO(amended);
  }

  private async amendOnce(
    session: ApplicationSession,
    input: AmendedReportInput,
  ): Promise<DiagnosticReport> {
    const report = await this.requireScopedReport(session, input.reportId);
    const head = report.versions[report.versions.length - 1];
    if (!head) throw new ConflictError('Report has no versions');
    const newVersionId = randomUUID() as ReportVersionId;
    const amended = amendReport(
      report,
      input.content,
      input.authoredByRef,
      input.authoredAt,
      newVersionId,
      input.amendmentReason as ReportAmendmentReason,
    );
    await this.deps.reports.save(amended);
    await this.audit.record(session, {
      action: 'AMENDED',
      objectType: 'diagnostic-report',
      objectId: report.id,
      at: input.authoredAt,
      source: input.source ?? REPORT_ENTRY_SOURCE,
      detail: `version ${head.version + 1} supersedes version ${head.version} (reason: ${input.amendmentReason})`,
    });
    return amended;
  }

  /** Read view for the caller scope (IDOR-resistant). */
  async getReport(
    session: ApplicationSession | undefined,
    reportId: ReportId,
  ): Promise<ReportDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.REPORT_READ);
    return toReportDTO(await this.requireScopedReport(session, reportId));
  }

  /** Report must exist and be inside the session facility scope. */
  async requireScopedReport(
    session: ApplicationSession,
    reportId: ReportId,
  ): Promise<DiagnosticReport> {
    await assertSessionFacility(session, this.deps.facilities);
    const report = await this.deps.reports.findById(reportId);
    if (!report) throw new NotFoundError('Report not found');
    assertResourceInFacilityScope(session, report);
    return report;
  }
}

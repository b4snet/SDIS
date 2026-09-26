/**
 * SDIS patient report access (Step 22) — the application boundary for
 * patient-facing access to finalized diagnostic reports.
 *
 * Safety model (docs/CLINICAL_SAFETY.md §10):
 *
 * - A patient-facing principal is an `ApplicationSession` whose actor kind is
 *   `PATIENT` and whose role claim is `patient` (fail-closed: any other actor
 *   kind, or no binding, owns nothing).
 * - Ownership is resolved SERVER-SIDE through the injected
 *   `PatientPrincipalRegistry`: the authenticated principal maps to exactly
 *   ONE canonical patient identity. Patient id, report id, name, date of
 *   birth, phone, or external identifiers supplied by a client are lookup
 *   attributes at most — NEVER proof of ownership.
 * - Visibility: only FINALIZED report versions are patient-visible. DRAFT
 *   content (including the DRAFT head of an amended report) is never
 *   exposed. The canonical lifecycle is reused untouched — no second
 *   lifecycle, no patient-side copy that can diverge.
 * - The patient-safe DTO is a deliberate projection: no internal audit,
 *   provenance, staff references, or workflow state. Observation vs
 *   interpretation vs report distinctions remain in the canonical model;
 *   nothing is flattened and nothing is authored here (no AI, no advice,
 *   no reference ranges).
 * - Read-only. Patient access mutates nothing and changes no clinical
 *   provenance; each access event is audited through the ONE existing
 *   append-only audit path.
 */

import type { PatientId, ReportId } from '../../types/ids';
import type { ApplicationSession } from '../context';
import { requireSession } from '../context';
import { assertSessionFacility } from '../context';
import { ForbiddenError, NotFoundError } from '../errors';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, FacilityDirectory } from '../ports';
import { AuditRecorder } from '../audit';
import type { DiagnosticReport, ReportVersion } from '../../domain/results/report';
import type { PatientPrincipalRegistry, ReportRepository } from '../ports';

/** Audit actions available to this service (subset of the domain vocabulary). */
const ACCESS_AUDIT_ACTION = 'VERIFIED' as const;
const ACCESS_AUDIT_OBJECT = 'patient-report-access';
const ACCESS_SOURCE = { kind: 'SYSTEM', label: 'patient-access-boundary' } as const;

export interface PatientReportAccessDependencies {
  /** Ownership binding: patient principal -> canonical patient identity. */
  readonly principalRegistry: PatientPrincipalRegistry;
  /** The canonical report store — the ONLY report repository used. */
  readonly reports: ReportRepository;
  /** Session-facility validation (same contract as every other service). */
  readonly facilities: FacilityDirectory;
  readonly audit: AuditPort;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

/** One patient-visible report version: content plus benign timing metadata. */
export interface PatientReportVersionView {
  readonly version: number;
  readonly status: 'FINALIZED';
  readonly content: string;
  readonly finalizedAt: string;
  /** Present when this version supersedes an earlier one (amendment chain). */
  readonly supersedesVersion?: number;
}

/**
 * The patient-safe report view. Deliberately NOT the internal DTO: no staff
 * references, no provenance objects, no audit fields, no workflow metadata.
 */
export interface PatientReportView {
  /** The canonical report id — the patient-side handle for the resource. */
  readonly reportId: string;
  /** The order this report belongs to (benign linkage, no internal ids). */
  readonly orderId: string;
  readonly modality?: string;
  readonly encounterDate?: string;
  readonly facilityId: string;
  /** Highest patient-visible version number (FINALIZED versions only). */
  readonly latestVisibleVersion: number;
  /** FINALIZED version with the highest number — the authoritative view. */
  readonly current: PatientReportVersionView;
  /** Complete FINALIZED version history, oldest first. */
  readonly versions: readonly PatientReportVersionView[];
}

/** Non-owning patient references are indistinguishable from missing ones. */
const NOT_FOUND = () => new NotFoundError('Report not found');

/** A staff/session principal that is not a patient principal never owns data. */
const NOT_A_PATIENT = () =>
  new ForbiddenError('Patient access is required for this resource');

/** True only for sessions whose actor is a PATIENT principal. */
export function isPatientSession(
  session: ApplicationSession | undefined,
): session is ApplicationSession {
  return session?.actor?.kind === 'PATIENT';
}

export class PatientReportAccessService {
  constructor(private readonly deps: PatientReportAccessDependencies) {}

  /**
   * Lists the authenticated patient's reports for the session facility.
   * Only FINALIZED content is visible; reports with no finalized version are
   * omitted entirely (their existence is not leaked).
   */
  async listMyReports(
    session: ApplicationSession | undefined,
    options: { readonly auditAccess?: boolean } = {},
  ): Promise<readonly PatientReportView[]> {
    const owned = await this.requireOwnedPatient(session);
    const reports = await this.deps.reports.listByPatientAndFacility(
      owned.patientId,
      owned.session.facilityId,
    );
    const views = reports
      .map((report) => this.toVisibleView(report))
      .filter((view): view is PatientReportView => view !== undefined);
    if (options.auditAccess !== false && views.length > 0) {
      await this.recordAccess(
        owned.session,
        reports.map((report) => report.id).join(','),
      );
    }
    return views;
  }

  /**
   * Returns one owned, finalized report as the patient-safe view. A report
   * that does not exist, belongs to another patient, or has no finalized
   * version is the same indistinguishable NOT_FOUND — a forged report id
   * must never reveal which failure occurred.
   */
  async getMyReport(
    session: ApplicationSession | undefined,
    reportId: ReportId,
    options: { readonly auditAccess?: boolean } = {},
  ): Promise<PatientReportView> {
    const owned = await this.requireOwnedPatient(session);
    const report = await this.deps.reports.findById(reportId);
    const view = report ? this.toVisibleView(report) : undefined;
    if (
      !report ||
      !view ||
      report.patientId !== owned.patientId ||
      report.facilityId !== owned.session.facilityId
    ) {
      throw NOT_FOUND();
    }
    if (options.auditAccess !== false) {
      await this.recordAccess(owned.session, report.id);
    }
    return view;
  }

  /**
   * The ownership gate. Resolves the ONE canonical patient identity for the
   * authenticated patient principal. Fails closed: no session, non-patient
   * actor, or missing binding yields an authorization failure — the service
   * never falls back to client-supplied identifiers.
   */
  private async requireOwnedPatient(
    session: ApplicationSession | undefined,
  ): Promise<{ readonly session: ApplicationSession; readonly patientId: PatientId }> {
    if (!isPatientSession(session)) {
      throw NOT_A_PATIENT();
    }
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.PATIENT_REPORT_READ);
    const patientId = await this.deps.principalRegistry.resolvePatientId(session.userId);
    if (!patientId) {
      // A patient principal with no binding owns nothing (fail closed).
      throw NOT_FOUND();
    }
    return { session, patientId };
  }

  /**
   * Projects a canonical report onto the patient-safe view. Returns undefined
   * when NO version is finalized (draft-only reports are invisible).
   */
  private toVisibleView(report: DiagnosticReport): PatientReportView | undefined {
    const finalized = report.versions.filter(
      (version): version is ReportVersion & { readonly finalizedAt: string } =>
        version.status === 'FINALIZED' && typeof version.finalizedAt === 'string',
    );
    if (finalized.length === 0) return undefined;
    const versions = finalized.map((version) => {
      const supersedes = version.supersedesVersionId
        ? report.versions.find(
            (candidate) => candidate.id === version.supersedesVersionId,
          )
        : undefined;
      return {
        version: version.version,
        status: 'FINALIZED' as const,
        content: version.content,
        finalizedAt: version.finalizedAt,
        ...(supersedes ? { supersedesVersion: supersedes.version } : {}),
      };
    });
    const current = versions[versions.length - 1];
    if (!current) return undefined;
    return {
      reportId: report.id,
      orderId: report.orderId,
      facilityId: report.facilityId,
      latestVisibleVersion: current.version,
      current,
      versions,
    };
  }

  /** Access event through the ONE append-only audit path (no payload logged). */
  private async recordAccess(
    session: ApplicationSession,
    objectIds: string,
  ): Promise<void> {
    await new AuditRecorder(this.deps.audit).record(session, {
      action: ACCESS_AUDIT_ACTION,
      objectType: ACCESS_AUDIT_OBJECT,
      objectId: objectIds,
      at: new Date().toISOString(),
      source: ACCESS_SOURCE,
      detail: 'patient report access',
    });
  }
}

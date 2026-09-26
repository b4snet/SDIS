/**
 * SDIS patient document access (Step 23) — the patient-facing boundary for
 * documents, built on the Step-22 patient principal model.
 *
 * Safety model (mirrors docs/CLINICAL_SAFETY.md §10/§11):
 *
 * - The same fail-closed ownership gate as report access: a PATIENT-principal
 *   session with the `patient` role, resolved through the server-side
 *   `PatientPrincipalRegistry` binding. Client-supplied ids are never
 *   ownership proof; no binding owns nothing.
 * - Visibility is EXPLICIT: only documents linked to the owned patient AND
 *   marked `patientVisible` are exposed. Retirement removes access for staff
 *   and patients alike. A non-visible, foreign, retired, or unknown document
 *   is the SAME indistinguishable NOT_FOUND.
 * - Content flows through the canonical `DocumentService` (storage port,
 *   checksum verification) — never a raw storage path.
 * - Read-only; each access event is audited through the ONE append-only
 *   audit path with the PATIENT actor preserved.
 */

import type { DocumentId, PatientId } from '../../types/ids';
import type { ApplicationSession } from '../context';
import { requireSession } from '../context';
import { assertSessionFacility } from '../context';
import { ForbiddenError, NotFoundError } from '../errors';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import { AuditRecorder } from '../audit';
import type { FacilityDirectory } from '../ports';
import type { AuditPort, PatientPrincipalRegistry } from '../ports';
import type { DocumentMetadataRepository } from '../documents/document-service';
import type {
  DocumentContentDTO,
  DocumentDTO,
  DocumentService,
} from '../documents/document-service';
import type { DocumentMetadata } from '../../domain/documents/documents';

const ACCESS_AUDIT_OBJECT = 'patient-document-access';
const ACCESS_SOURCE = { kind: 'SYSTEM', label: 'patient-access-boundary' } as const;

/** Foreign / non-visible / retired / unknown are indistinguishable. */
const NOT_FOUND = new NotFoundError('Document not found');

/**
 * Patient-safe projection of document metadata: display name, type, timing,
 * and status only — no storage provider/ref/encryption flags, no internal
 * workflow metadata.
 */
function toPatientDocumentDTO(meta: DocumentMetadata): DocumentDTO {
  const slash = meta.location.ref.indexOf('/');
  return {
    id: meta.id,
    documentType: meta.documentType,
    facilityId: meta.facilityId,
    ...(meta.patientId ? { patientId: meta.patientId } : {}),
    displayName: slash === -1 ? meta.location.ref : meta.location.ref.slice(0, slash),
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    version: meta.version,
    status: meta.status ?? 'ACTIVE',
    patientVisible: meta.patientVisible ?? false,
    uploadedAt: meta.uploadedAt,
    ...(meta.retentionUntil ? { retentionUntil: meta.retentionUntil } : {}),
  };
}

export interface PatientDocumentAccessDependencies {
  /** Ownership binding: patient principal -> canonical patient identity. */
  readonly principalRegistry: PatientPrincipalRegistry;
  /** Metadata reads (visibility + ownership) straight off the port. */
  readonly documentMetadata: DocumentMetadataRepository;
  /** Content through the canonical service (storage port + checksum). */
  readonly documents: DocumentService;
  readonly facilities: FacilityDirectory;
  readonly audit: AuditPort;
  readonly authz?: AuthorizationService;
}

export class PatientDocumentAccessService {
  constructor(private readonly deps: PatientDocumentAccessDependencies) {}

  /**
   * Lists documents explicitly eligible for patient access and linked to the
   * owned patient. Existence of ineligible documents is never leaked.
   */
  async listMyDocuments(
    session: ApplicationSession | undefined,
  ): Promise<readonly DocumentDTO[]> {
    const owned = await this.requireOwnedPatient(session);
    const all = await this.deps.documentMetadata.listByPatient(
      owned.patientId,
      owned.session.facilityId,
    );
    return all
      .filter((meta) => meta.patientVisible && (meta.status ?? 'ACTIVE') === 'ACTIVE')
      .map((meta) => toPatientDocumentDTO(meta));
  }

  /**
   * Returns one owned, patient-visible, non-retired document's metadata.
   * Foreign / non-visible / retired / unknown ids are the same 404.
   */
  async getMyDocument(
    session: ApplicationSession | undefined,
    documentId: DocumentId,
  ): Promise<DocumentDTO> {
    const owned = await this.requireOwnedPatient(session);
    const meta = await this.deps.documentMetadata.findById(documentId);
    if (
      !meta ||
      meta.patientId !== owned.patientId ||
      meta.facilityId !== owned.session.facilityId ||
      !meta.patientVisible ||
      (meta.status ?? 'ACTIVE') === 'RETIRED'
    ) {
      throw NOT_FOUND;
    }
    return toPatientDocumentDTO(meta);
  }

  /**
   * Returns one owned, patient-visible document's verified content through
   * the canonical service (checksum-checked before returning).
   */
  async getMyDocumentContent(
    session: ApplicationSession | undefined,
    documentId: DocumentId,
  ): Promise<DocumentContentDTO> {
    await this.getMyDocument(session, documentId); // same gate, audited below
    const owned = await this.requireOwnedPatient(session);
    const content = await this.deps.documents.getDocumentContent(
      owned.session,
      documentId,
    );
    await this.recordAccess(owned.session, documentId);
    return content;
  }

  /** Identical fail-closed ownership gate to the Step-22 report service. */
  private async requireOwnedPatient(
    session: ApplicationSession | undefined,
  ): Promise<{ readonly session: ApplicationSession; readonly patientId: PatientId }> {
    if (session?.actor?.kind !== 'PATIENT') {
      throw new ForbiddenError('Patient access is required for this resource');
    }
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.PATIENT_DOCUMENT_READ);
    const patientId = await this.deps.principalRegistry.resolvePatientId(session.userId);
    if (!patientId) {
      // A patient principal with no binding owns nothing (fail closed).
      throw new NotFoundError('Document not found');
    }
    return { session, patientId };
  }

  /** Access event through the ONE append-only audit path (no content logged). */
  private async recordAccess(
    session: ApplicationSession,
    documentId: string,
  ): Promise<void> {
    await new AuditRecorder(this.deps.audit).record(session, {
      action: 'VERIFIED',
      objectType: ACCESS_AUDIT_OBJECT,
      objectId: documentId,
      at: new Date().toISOString(),
      source: ACCESS_SOURCE,
      detail: 'patient document access',
    });
  }
}

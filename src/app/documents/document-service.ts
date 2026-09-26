/**
 * SDIS document management application service (Step 13).
 *
 * Makes the EXISTING document domain contract
 * (`src/domain/documents/documents.ts`) a real capability: metadata is created
 * through the domain `DocumentMetadata` shape and `assertStorageSafety` rule,
 * content goes through an injected `DocumentContentStore` port (the
 * application never touches a filesystem or object store), resource links are
 * validated against the SAME scope before persisting, and every record carries
 * server-derived provenance and audit.
 *
 * There is NO second document model, NO deletion (the domain defines no
 * delete lifecycle; retention is a governed future process), NO OCR/document
 * AI/PACS/DICOM, and no standards-conformance claim.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  assertStorageSafety,
  canRetireDocument,
  type DocumentLocation,
  type DocumentMetadata,
  type DocumentStatus,
  type DocumentType,
} from '../../domain/documents/documents';
import type { DocumentId, OrderItemId, PatientId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import { assertSessionFacility, type ApplicationSession } from '../context';
import {
  ConflictError,
  NotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import type { AuditPort, FacilityDirectory, IdempotencyStore } from '../ports';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';

/** Storage port: the application depends on THIS, never a concrete store. */
export interface DocumentContentStore {
  /**
   * Persists content bytes and returns an opaque storage reference. The ref
   * is infrastructure-owned (never a path the client can interpret) and must
   * be safe to persist as metadata. Implementations choose their own layout;
   * `displayName` is provided for content-disposition recovery and is always
   * a validated, path-free name.
   */
  put(params: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly documentId: DocumentId;
    readonly displayName?: string;
  }): Promise<{
    readonly ref: string;
    readonly provider: DocumentLocation['provider'];
    readonly encrypted: boolean;
  }>;
  /** Retrieves the exact bytes previously stored under `ref`. */
  get(ref: string): Promise<Uint8Array | undefined>;
}

/** Persistence port for document metadata (write-capable directory). */
export interface DocumentMetadataRepository {
  save(meta: DocumentMetadata): Promise<DocumentMetadata>;
  findById(id: DocumentId): Promise<DocumentMetadata | undefined>;
  /**
   * Documents linked to one patient within one facility (Step 23 staff
   * listing). Scope comes from the SERVER-derived session, never the client.
   */
  listByPatient(
    patientId: PatientId,
    facilityId: ApplicationSession['facilityId'],
  ): Promise<readonly DocumentMetadata[]>;
}

export interface StoreDocumentInput {
  readonly documentType: DocumentType;
  readonly displayName: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  /** Optional validated resource links (scope-checked by the service). */
  readonly patientId?: PatientId;
  readonly orderItemId?: OrderItemId;
  /** Retention window as provided by governance; recorded, never acted on. */
  readonly retentionUntil?: string;
  /**
   * Explicit patient-access eligibility (Step 23). False by default: a
   * document is patient-visible ONLY when the uploader deliberately marks it.
   */
  readonly patientVisible?: boolean;
  readonly idempotencyKey?: string;
}

/** Content-type policy (conservative, boundary-level — NOT clinical policy). */
const ALLOWED_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/tiff',
  'text/plain',
  'application/json',
];

/** Maximum document size (bytes) — matches the transport body ceiling scale. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export interface DocumentDTO {
  readonly id: string;
  readonly documentType: DocumentType;
  readonly facilityId: string;
  readonly patientId?: string;
  readonly orderItemId?: string;
  readonly displayName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  /** Present on creation responses (integrity proof); omitted on plain reads. */
  readonly sha256?: string;
  readonly version: number;
  readonly status: DocumentStatus;
  readonly patientVisible: boolean;
  readonly uploadedAt: string;
  readonly retentionUntil?: string;
}

export interface DocumentContentDTO {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly displayName: string;
}

export interface DocumentServiceDependencies {
  readonly store: DocumentContentStore;
  readonly documents: DocumentMetadataRepository;
  /** Resource directories for link validation (same scope, validated ids). */
  readonly patients: {
    findById(id: PatientId): Promise<{ registeredAtFacilityId: string } | undefined>;
  };
  readonly orders: {
    findByOrderItemId(
      orderItemId: OrderItemId,
    ): Promise<{ facilityId: string } | undefined>;
  };
  readonly facilities: FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  readonly authz?: AuthorizationService;
}

const DOCUMENT_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'document upload/import',
};

/** Provenance source derived from the AUTHENTICATED session (never client data). */
function documentSourceFor(session: ApplicationSession): DataSource {
  return session.actor.kind === 'PATIENT'
    ? { kind: 'SYSTEM', label: 'patient document access', ref: session.userId }
    : DOCUMENT_SOURCE;
}

function toDTO(meta: DocumentMetadata, sha256?: string): DocumentDTO {
  return {
    id: meta.id,
    documentType: meta.documentType,
    facilityId: meta.facilityId,
    ...(meta.patientId ? { patientId: meta.patientId } : {}),
    ...(meta.orderId ? { orderItemId: meta.orderId } : {}),
    displayName: displayNameOf(meta),
    mimeType: meta.mimeType,
    sizeBytes: meta.sizeBytes,
    ...(sha256 ? { sha256 } : {}),
    version: meta.version,
    status: meta.status ?? 'ACTIVE',
    patientVisible: meta.patientVisible ?? false,
    uploadedAt: meta.uploadedAt,
    ...(meta.retentionUntil ? { retentionUntil: meta.retentionUntil } : {}),
  };
}

/**
 * The safe display name rides on the storage ref (`<name>/<opaque>` layout
 * is infrastructure-owned); the name itself never contains a path.
 */
function displayNameOf(meta: DocumentMetadata): string {
  // Storage refs are laid out `<displayName>/<opaque-tail>` by both store
  // implementations (the service validates the name before it is embedded),
  // so the display name is the FIRST segment — never parsed as a path.
  const ref = meta.location.ref;
  const slash = ref.indexOf('/');
  return slash === -1 ? ref : ref.slice(0, slash);
}

export class DocumentService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: DocumentServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Stores one document (content + metadata) in a single logical operation.
   * Retry-safe via the existing idempotency engine: a replay returns the
   * stored result and creates no duplicate metadata or audit events.
   */
  async storeDocument(
    session: ApplicationSession | undefined,
    input: StoreDocumentInput,
  ): Promise<DocumentDTO> {
    if (!session) throw new ValidationError('An authenticated session is required');
    await this.deps.authz?.assertPermission(session, PERMISSIONS.DOCUMENT_CREATE);
    // The session facility must exist in the facility directory (forged
    // scope fails closed here, exactly like every other service).
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    return runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.DOCUMENT_CREATE,
      input.idempotencyKey,
      () => this.storeOnce(session, input, facilityId),
      session,
    );
  }

  private async storeOnce(
    session: ApplicationSession,
    input: StoreDocumentInput,
    facilityId: ApplicationSession['facilityId'],
  ): Promise<DocumentDTO> {
    // ---- Validation (conservative, boundary-level) -------------------------
    if (!input.documentType) {
      throw new ValidationError('A document requires a type');
    }
    const displayName = (input.displayName ?? '').trim();
    if (!displayName) {
      throw new ValidationError('A document requires a display name');
    }
    if (
      displayName.includes('/') ||
      displayName.includes('\\') ||
      displayName.includes('..')
    ) {
      throw new ValidationError(
        'A document display name must not contain path separators',
      );
    }
    if (!input.mimeType || !ALLOWED_MIME_TYPES.includes(input.mimeType)) {
      throw new ValidationError(
        `Field "mimeType" must be one of ${ALLOWED_MIME_TYPES.join(', ')}`,
      );
    }
    if (!input.bytes || input.bytes.length === 0) {
      throw new ValidationError('A document requires non-empty content');
    }
    if (input.bytes.length > MAX_DOCUMENT_BYTES) {
      throw new ValidationError('Document content exceeds the maximum allowed size');
    }
    const sha256 = createHash('sha256').update(input.bytes).digest('hex');
    const id = randomUUID() as DocumentId;

    // ---- Resource-link validation (same scope, validated references) ------
    if (input.patientId !== undefined) {
      const patient = await this.deps.patients.findById(input.patientId);
      if (!patient) throw new NotFoundError('Patient not found');
      if (patient.registeredAtFacilityId !== session.facilityId) {
        throw new ScopeMismatchError();
      }
    }
    if (input.orderItemId !== undefined) {
      const order = await this.deps.orders.findByOrderItemId(input.orderItemId);
      if (!order) throw new NotFoundError('Diagnostic order not found');
      if (order.facilityId !== session.facilityId) {
        throw new ScopeMismatchError();
      }
    }

    // ---- Content through the storage port (never a concrete store here) ---
    const stored = await this.deps.store.put({
      bytes: input.bytes,
      sha256,
      documentId: id,
      displayName,
    });
    const location: DocumentLocation = {
      provider: stored.provider,
      ref: stored.ref,
      encrypted: stored.encrypted,
    };

    // ---- Domain contract: metadata shape + storage-safety rule ------------
    const uploadedAt = new Date().toISOString();
    const meta: DocumentMetadata = {
      id,
      documentType: input.documentType,
      facilityId,
      ...(input.patientId !== undefined ? { patientId: input.patientId } : {}),
      ...(input.orderItemId !== undefined ? { orderId: input.orderItemId } : {}),
      location,
      version: 1,
      mimeType: input.mimeType,
      sizeBytes: input.bytes.length,
      uploadedAt,
      status: 'ACTIVE',
      patientVisible: input.patientVisible ?? false,
      ...(input.retentionUntil ? { retentionUntil: input.retentionUntil } : {}),
    };
    assertStorageSafety(meta);

    await this.deps.documents.save(meta);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'document',
      objectId: meta.id,
      at: uploadedAt,
      source: documentSourceFor(session),
      detail: `${meta.documentType} ${input.mimeType} ${meta.sizeBytes}B`,
    });
    return toDTO(meta, sha256);
  }

  /** Metadata by id, constrained to the session scope (IDOR-resistant). */
  async getDocument(
    session: ApplicationSession | undefined,
    documentId: DocumentId,
  ): Promise<DocumentDTO> {
    if (!session) throw new ValidationError('An authenticated session is required');
    await assertSessionFacility(session, this.deps.facilities);
    const meta = await this.deps.documents.findById(documentId);
    if (!meta || meta.facilityId !== session.facilityId) {
      throw new NotFoundError('Document not found');
    }
    return toDTO(meta);
  }

  /**
   * Staff listing by patient within the session facility (Step 23): only
   * documents explicitly linked to that patient; scope is server-derived.
   */
  async listDocumentsForPatient(
    session: ApplicationSession | undefined,
    patientId: PatientId,
  ): Promise<readonly DocumentDTO[]> {
    if (!session) throw new ValidationError('An authenticated session is required');
    await this.deps.authz?.assertPermission(session, PERMISSIONS.DOCUMENT_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const patient = await this.deps.patients.findById(patientId);
    if (!patient || patient.registeredAtFacilityId !== session.facilityId) {
      throw new NotFoundError('Patient not found');
    }
    const all = await this.deps.documents.listByPatient(patientId, session.facilityId);
    return all.map((meta) => toDTO(meta));
  }

  /**
   * Retirement (Step 23): removes ACCESS, never content. One-way (a retired
   * document never returns to ACTIVE), audited, and idempotent-friendly:
   * retiring an already-retired document returns the current state without a
   * duplicate audit event.
   */
  async retireDocument(
    session: ApplicationSession | undefined,
    documentId: DocumentId,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<DocumentDTO> {
    if (!session) throw new ValidationError('An authenticated session is required');
    await this.deps.authz?.assertPermission(session, PERMISSIONS.DOCUMENT_CREATE);
    await assertSessionFacility(session, this.deps.facilities);
    const meta = await this.deps.documents.findById(documentId);
    if (!meta || meta.facilityId !== session.facilityId) {
      throw new NotFoundError('Document not found');
    }
    if (!canRetireDocument(meta)) {
      return toDTO(meta); // already retired — no duplicate side effect
    }
    const retired = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.DOCUMENT_RETIRE,
      options.idempotencyKey,
      async () => {
        const updated = await this.deps.documents.save({
          ...meta,
          status: 'RETIRED' as const,
          version: meta.version,
        });
        await this.audit.record(session, {
          action: 'UPDATED',
          objectType: 'document',
          objectId: meta.id,
          at: new Date().toISOString(),
          source: documentSourceFor(session),
          detail: 'document retired (access removed; content retained)',
        });
        return updated;
      },
      session,
    );
    return toDTO(retired);
  }

  /**
   * Content retrieval with REAL integrity verification (Step 23): the stored
   * bytes are re-hashed and compared against the RECORDED checksum — a
   * mismatch is surfaced as a conflict, never returned silently. Retired
   * documents are no longer retrievable (metadata + content remain intact).
   */
  async getDocumentContent(
    session: ApplicationSession | undefined,
    documentId: DocumentId,
  ): Promise<DocumentContentDTO> {
    if (!session) throw new ValidationError('An authenticated session is required');
    await assertSessionFacility(session, this.deps.facilities);
    const meta = await this.deps.documents.findById(documentId);
    if (!meta || meta.facilityId !== session.facilityId) {
      throw new NotFoundError('Document not found');
    }
    if ((meta.status ?? 'ACTIVE') === 'RETIRED') {
      throw new NotFoundError('Document not found');
    }
    const bytes = await this.deps.store.get(meta.location.ref);
    if (!bytes) {
      throw new ConflictError('Document content is not available');
    }
    const contentSha = createHash('sha256').update(bytes).digest('hex');
    const recordedSha = splitDocumentRefSha(meta.location.ref);
    if (recordedSha && recordedSha !== contentSha) {
      // Checksum mismatch: stored content does not match the recorded digest.
      throw new ConflictError('Document content integrity verification failed');
    }
    return {
      bytes,
      mimeType: meta.mimeType,
      sha256: contentSha,
      sizeBytes: meta.sizeBytes,
      displayName: displayNameOf(meta),
    };
  }
}

/**
 * Extracts the recorded digest embedded in a `<displayName>/<sha256>` storage
 * ref when present. The in-memory and local stores both use this layout; a
 * ref without a digest tail simply skips deep verification (metadata remains
 * authoritative).
 */
function splitDocumentRefSha(ref: string): string | undefined {
  const slash = ref.indexOf('/');
  const tail = slash === -1 ? undefined : ref.slice(slash + 1);
  return tail && /^[0-9a-f]{64}$/.test(tail) ? tail : undefined;
}

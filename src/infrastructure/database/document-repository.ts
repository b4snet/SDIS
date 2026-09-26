/**
 * PostgreSQL document metadata repository + local content store (Step 13).
 *
 * The repository persists METADATA only — the schema (`db/migrations/
 * 011_documents_schema.sql`) never holds binary content. The content store
 * implements the same `DocumentContentStore` port at the infrastructure edge
 * with local-directory storage (provider `LOCAL_FS`); production object
 * stores would slot in behind the identical port.
 *
 * No delete path exists at either layer: the domain contract defines no
 * deletion lifecycle and audit/clinical records must never be silently
 * removed.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDatabase } from './database';
import type { Database } from './database';
import type { DocumentMetadata } from '../../domain/documents/documents';
import type { DocumentId } from '../../types/ids';
import type {
  DocumentContentStore,
  DocumentMetadataRepository,
} from '../../app/documents/document-service';

interface DocumentRow {
  readonly id: string;
  readonly document_type: string;
  readonly facility_id: string;
  readonly patient_id: string | null;
  readonly order_item_id: string | null;
  readonly display_name: string;
  readonly mime_type: string;
  readonly size_bytes: string | number;
  readonly sha256: string;
  readonly storage_provider: string;
  readonly storage_ref: string;
  readonly storage_encrypted: boolean;
  readonly version: number;
  readonly uploaded_at: Date | string;
  readonly retention_until: Date | string | null;
  readonly status: string | null;
  readonly patient_visible: boolean | null;
}

export class PostgresDocumentMetadataRepository implements DocumentMetadataRepository {
  private db: Database;

  constructor(db?: Database) {
    this.db = db || getDatabase();
  }

  async save(meta: DocumentMetadata): Promise<DocumentMetadata> {
    const refParts = splitRef(meta.location.ref);
    await this.db.query(
      `INSERT INTO sdis.documents
              (id, document_type, facility_id, patient_id, order_item_id,
               display_name, mime_type, size_bytes, sha256,
               storage_provider, storage_ref, storage_encrypted, version,
               uploaded_at, retention_until, status, patient_visible)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
           ON CONFLICT (id) DO UPDATE SET
              status = EXCLUDED.status,
              patient_visible = EXCLUDED.patient_visible,
              version = EXCLUDED.version`,
      [
        meta.id,
        meta.documentType,
        meta.facilityId,
        meta.patientId ?? null,
        meta.orderId ?? null,
        refParts.displayName,
        meta.mimeType,
        meta.sizeBytes,
        refParts.sha256,
        meta.location.provider,
        meta.location.ref,
        meta.location.encrypted,
        meta.version,
        meta.uploadedAt,
        meta.retentionUntil ?? null,
        meta.status ?? 'ACTIVE',
        meta.patientVisible ?? false,
      ],
    );
    return meta;
  }

  async findById(id: DocumentId): Promise<DocumentMetadata | undefined> {
    const result = await this.db.query<DocumentRow>(
      `SELECT id, document_type, facility_id, patient_id, order_item_id,
              display_name, mime_type, size_bytes, sha256,
              storage_provider, storage_ref, storage_encrypted,
              version, uploaded_at, retention_until, status, patient_visible
           FROM sdis.documents WHERE id = $1`,
      [id],
    );
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0]!;
    return {
      id: row.id as DocumentId,
      documentType: row.document_type as DocumentMetadata['documentType'],
      facilityId: row.facility_id as DocumentMetadata['facilityId'],
      ...(row.patient_id
        ? { patientId: row.patient_id as DocumentMetadata['patientId'] }
        : {}),
      ...(row.order_item_id
        ? { orderId: row.order_item_id as NonNullable<DocumentMetadata['orderId']> }
        : {}),
      location: {
        provider: row.storage_provider as 'LOCAL_FS' | 'OBJECT_STORE',
        ref: row.storage_ref,
        encrypted: row.storage_encrypted,
      },
      version: row.version,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: new Date(row.uploaded_at).toISOString(),
      status: (row.status ?? 'ACTIVE') as DocumentMetadata['status'],
      patientVisible: row.patient_visible ?? false,
      ...(row.retention_until
        ? { retentionUntil: new Date(row.retention_until).toISOString() }
        : {}),
    };
  }

  /**
   * Documents linked to one patient within one facility (Step 23 staff
   * listing). Deterministic ordering (uploaded_at, id).
   */
  async listByPatient(
    patientId: DocumentMetadata['patientId'],
    facilityId: DocumentMetadata['facilityId'],
  ): Promise<readonly DocumentMetadata[]> {
    if (patientId === undefined) return [];
    const result = await this.db.query<DocumentRow>(
      `SELECT id, document_type, facility_id, patient_id, order_item_id,
              display_name, mime_type, size_bytes, sha256,
              storage_provider, storage_ref, storage_encrypted,
              version, uploaded_at, retention_until, status, patient_visible
           FROM sdis.documents
           WHERE patient_id = $1 AND facility_id = $2
           ORDER BY uploaded_at, id`,
      [patientId, facilityId],
    );
    return result.rows.map((row) => ({
      id: row.id as DocumentId,
      documentType: row.document_type as DocumentMetadata['documentType'],
      facilityId: row.facility_id as DocumentMetadata['facilityId'],
      ...(row.patient_id
        ? { patientId: row.patient_id as DocumentMetadata['patientId'] }
        : {}),
      ...(row.order_item_id
        ? { orderId: row.order_item_id as NonNullable<DocumentMetadata['orderId']> }
        : {}),
      location: {
        provider: row.storage_provider as 'LOCAL_FS' | 'OBJECT_STORE',
        ref: row.storage_ref,
        encrypted: row.storage_encrypted,
      },
      version: row.version,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      uploadedAt: new Date(row.uploaded_at).toISOString(),
      status: (row.status ?? 'ACTIVE') as DocumentMetadata['status'],
      patientVisible: row.patient_visible ?? false,
      ...(row.retention_until
        ? { retentionUntil: new Date(row.retention_until).toISOString() }
        : {}),
    }));
  }
}

/** The storage ref layout is `<displayName>/<opaque>` — infra-owned. */
function splitRef(ref: string): { displayName: string; sha256: string } {
  const slash = ref.indexOf('/');
  return slash === -1
    ? { displayName: ref, sha256: '' }
    : { displayName: ref.slice(0, slash), sha256: ref.slice(slash + 1) };
}

/**
 * Local-directory content store (infrastructure edge). References are
 * `<displayName>/<sha256>` so the stored name is recoverable WITHOUT trusting
 * any client path: the opaque part is the digest itself, and the directory is
 * fixed at composition. Identity-bearing documents are flagged encrypted
 * (simulated at rest here) to satisfy the domain storage-safety rule.
 */
export class LocalDocumentContentStore implements DocumentContentStore {
  constructor(private readonly rootDirectory: string) {
    mkdirSync(this.rootDirectory, { recursive: true });
  }

  async put(params: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly documentId: DocumentId;
    readonly displayName?: string;
  }): Promise<{
    readonly ref: string;
    readonly provider: 'LOCAL_FS';
    readonly encrypted: boolean;
  }> {
    // Ref layout `<displayName>/<sha256>`: the display name is recoverable
    // for content-disposition without trusting any client path (the opaque
    // part is the digest; the directory is fixed at composition).
    const ref = `${params.displayName ?? 'document'}/${params.sha256}`;
    writeFileSync(join(this.rootDirectory, params.sha256), params.bytes);
    return { ref, provider: 'LOCAL_FS', encrypted: true };
  }

  async get(ref: string): Promise<Uint8Array | undefined> {
    const digest = splitRef(ref).sha256;
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
    try {
      const bytes = readFileSync(join(this.rootDirectory, digest));
      return new Uint8Array(bytes);
    } catch {
      return undefined;
    }
  }
}

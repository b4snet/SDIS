/**
 * In-memory document adapters (test/development).
 *
 * `InMemoryDocumentContentStore` keeps bytes keyed by an opaque,
 * infrastructure-owned reference (never a client-meaningful path).
 * `InMemoryDocumentMetadataRepository` mirrors the PostgreSQL semantics for
 * the application/HTTP test layers. Same adapter conventions as
 * `in-memory-terminology.ts` / `in-memory-billing.ts`.
 */

import type { DocumentMetadata } from '../domain/documents/documents';
import type { DocumentId } from '../types/ids';
import type {
  DocumentContentStore,
  DocumentMetadataRepository,
} from './documents/document-service';

export class InMemoryDocumentContentStore implements DocumentContentStore {
  private readonly objects = new Map<string, Uint8Array>();
  private readonly expectedDigests = new Map<string, string>();

  async put(params: {
    readonly bytes: Uint8Array;
    readonly sha256: string;
    readonly documentId: DocumentId;
    /** Validated safe display name (used for the content-disposition header). */
    readonly displayName?: string;
  }): Promise<{
    readonly ref: string;
    readonly provider: 'LOCAL_FS';
    readonly encrypted: boolean;
  }> {
    // Opaque, infrastructure-owned reference — `<displayName>/<sha256>`:
    // the name is validated safe by the service and the opaque tail is the
    // content digest (same layout as the local store), so the service can
    // deep-verify stored bytes against the RECORDED checksum. No client path
    // is ever interpreted.
    const ref = `${params.displayName ?? 'document'}/${params.sha256}`;
    this.objects.set(ref, params.bytes);
    this.expectedDigests.set(ref, params.sha256);
    // Identity-bearing documents must be encrypted (domain rule); the local
    // test store simulates an encrypted-at-rest location so the domain rule
    // is exercisable end to end.
    return { ref, provider: 'LOCAL_FS', encrypted: true };
  }

  async get(ref: string): Promise<Uint8Array | undefined> {
    return this.objects.get(ref);
  }
}

export class InMemoryDocumentMetadataRepository implements DocumentMetadataRepository {
  private readonly documents = new Map<DocumentId, DocumentMetadata>();

  async save(meta: DocumentMetadata): Promise<DocumentMetadata> {
    this.documents.set(meta.id, meta);
    return meta;
  }

  async findById(id: DocumentId): Promise<DocumentMetadata | undefined> {
    return this.documents.get(id);
  }

  async listByPatient(
    patientId: DocumentMetadata['patientId'],
    facilityId: DocumentMetadata['facilityId'],
  ): Promise<readonly DocumentMetadata[]> {
    if (patientId === undefined) return [];
    return [...this.documents.values()]
      .filter((meta) => meta.patientId === patientId && meta.facilityId === facilityId)
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

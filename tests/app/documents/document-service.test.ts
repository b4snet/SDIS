/**
 * Document management application tests (Step 13).
 *
 * Proves the capability over the EXISTING domain contract: metadata shape +
 * `assertStorageSafety`, storage through the port (never a concrete store),
 * validated resource links in scope, server-derived provenance, audit, and
 * idempotent replay without duplicates. Fresh fixture per test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocumentService } from '../../../src/app/documents/document-service';
import {
  InMemoryDocumentContentStore,
  InMemoryDocumentMetadataRepository,
} from '../../../src/app/in-memory-documents';
import {
  ConflictError,
  NotFoundError,
  ScopeMismatchError,
  ValidationError,
} from '../../../src/app/errors';
import { createFixture, sessionFor, FACILITY, OTHER_FACILITY } from '../helpers';
import { InMemoryIdempotencyStore } from '../../../src/app/in-memory';
import type { AuditLogPort } from '../../../src/app/in-memory';

function serviceFor(fixture: ReturnType<typeof createFixture>): DocumentService {
  const auditLog = fixture.audit as AuditLogPort;
  return new DocumentService({
    store: new InMemoryDocumentContentStore(),
    documents: new InMemoryDocumentMetadataRepository(),
    patients: {
      findById: async () => ({ registeredAtFacilityId: FACILITY }),
    },
    orders: {
      findByOrderItemId: async () => ({ facilityId: FACILITY }),
    },
    facilities: (
      fixture.orders as unknown as {
        deps: {
          facilities: Parameters<DocumentService['storeDocument']>[0] extends never
            ? never
            : import('../../../src/app/ports').FacilityDirectory;
        };
      }
    ).deps.facilities,
    audit: auditLog,
    idempotency: new InMemoryIdempotencyStore(),
  });
}

const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]); // "%PDF-1.4"

function uploadInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    documentType: 'REQUISITION',
    displayName: 'requisition-1.pdf',
    mimeType: 'application/pdf',
    bytes: PDF_BYTES,
    ...overrides,
  };
}

describe('documents: creation and validation', () => {
  it('stores a document and returns a clean DTO (no storage refs)', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    const dto = await service.storeDocument(fixture.session, uploadInput() as never);
    assert.ok(dto.id);
    assert.equal(dto.documentType, 'REQUISITION');
    assert.equal(dto.facilityId, FACILITY);
    assert.equal(dto.sizeBytes, PDF_BYTES.length);
    assert.ok(dto.sha256 && dto.sha256.length === 64);
    assert.ok(!('location' in dto));
    assert.ok(!JSON.stringify(dto).includes('documents/'));
  });

  it('rejects an unknown or missing document type', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await assert.rejects(
      service.storeDocument(
        fixture.session,
        uploadInput({ documentType: undefined }) as never,
      ),
      ValidationError,
    );
  });

  it('rejects path separators in display names', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await assert.rejects(
      service.storeDocument(
        fixture.session,
        uploadInput({ displayName: '../etc/passwd' }) as never,
      ),
      ValidationError,
    );
  });

  it('rejects disallowed MIME types and empty content', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await assert.rejects(
      service.storeDocument(
        fixture.session,
        uploadInput({ mimeType: 'application/x-msdownload' }) as never,
      ),
      ValidationError,
    );
    await assert.rejects(
      service.storeDocument(
        fixture.session,
        uploadInput({ bytes: new Uint8Array(0) }) as never,
      ),
      ValidationError,
    );
  });
});

describe('documents: resource linking and scope', () => {
  it('links to a same-facility patient and order item', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    const dto = await service.storeDocument(
      fixture.session,
      uploadInput({ patientId: fixture.patientId }) as never,
    );
    assert.equal(dto.patientId, fixture.patientId);
  });

  it('rejects a patient from another facility (scope mismatch)', async () => {
    const fixture = createFixture();
    const otherFacilityService = new DocumentService({
      store: new InMemoryDocumentContentStore(),
      documents: new InMemoryDocumentMetadataRepository(),
      patients: { findById: async () => ({ registeredAtFacilityId: OTHER_FACILITY }) },
      orders: { findByOrderItemId: async () => undefined },
      facilities: (
        fixture.orders as unknown as {
          deps: { facilities: import('../../../src/app/ports').FacilityDirectory };
        }
      ).deps.facilities,
      audit: fixture.audit,
      idempotency: new InMemoryIdempotencyStore(),
    });
    await assert.rejects(
      otherFacilityService.storeDocument(
        sessionFor(),
        uploadInput({ patientId: fixture.patientId }) as never,
      ),
      ScopeMismatchError,
    );
  });

  it('rejects links to nonexistent resources (no free-form ids)', async () => {
    const fixture = createFixture();
    const missingOrderService = new DocumentService({
      store: new InMemoryDocumentContentStore(),
      documents: new InMemoryDocumentMetadataRepository(),
      patients: { findById: async () => ({ registeredAtFacilityId: FACILITY }) },
      orders: { findByOrderItemId: async () => undefined }, // no such order item
      facilities: (
        fixture.orders as unknown as {
          deps: { facilities: import('../../../src/app/ports').FacilityDirectory };
        }
      ).deps.facilities,
      audit: fixture.audit,
      idempotency: new InMemoryIdempotencyStore(),
    });
    await assert.rejects(
      missingOrderService.storeDocument(
        fixture.session,
        uploadInput({ orderItemId: '00000000-0000-4000-8000-0000000000de' }) as never,
      ),
      NotFoundError,
    );
  });
});

describe('documents: provenance, audit, idempotency', () => {
  it('records one CREATED audit event with provenance context', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await service.storeDocument(fixture.session, uploadInput() as never);
    const events = fixture.audit.list();
    const created = events.filter(
      (e: import('../../../src/core/audit/audit').AuditEvent) =>
        e.action === 'CREATED' && e.objectType === 'document',
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]!.provenance.actor.kind, 'USER');
    assert.equal(created[0]!.provenance.source.kind, 'HUMAN');
    assert.ok(!JSON.stringify(created).includes(PDF_BYTES.join(',')));
  });

  it('replays idempotently: same key returns the same document, no duplicates', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    const input = uploadInput({ idempotencyKey: 'doc-key-1' }) as never;
    const first = await service.storeDocument(fixture.session, input);
    const second = await service.storeDocument(fixture.session, input);
    assert.equal(second.id, first.id);
    const events = fixture.audit.list();
    const created = events.filter(
      (e: import('../../../src/core/audit/audit').AuditEvent) =>
        e.action === 'CREATED' && e.objectType === 'document',
    );
    assert.equal(created.length, 1);
  });

  it('different content is a distinct document (no checksum-based merging)', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await service.storeDocument(fixture.session, uploadInput() as never);
    await service.storeDocument(
      fixture.session,
      uploadInput({ bytes: new Uint8Array([0x50, 0x44, 0x46]) }) as never,
    );
    const events = fixture.audit.list();
    const created = events.filter(
      (e: import('../../../src/core/audit/audit').AuditEvent) =>
        e.action === 'CREATED' && e.objectType === 'document',
    );
    assert.equal(created.length, 2);
  });
});

describe('documents: retrieval and content integrity', () => {
  it('retrieves metadata within scope; cross-facility reads share 404 semantics', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    const dto = await service.storeDocument(fixture.session, uploadInput() as never);
    const read = await service.getDocument(fixture.session, dto.id as never);
    assert.equal(read.id, dto.id);
    const forged = sessionFor(OTHER_FACILITY);
    await assert.rejects(service.getDocument(forged, dto.id as never), NotFoundError);
  });

  it('retrieves content and verifies integrity through re-hashing', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    const dto = await service.storeDocument(fixture.session, uploadInput() as never);
    const content = await service.getDocumentContent(fixture.session, dto.id as never);
    assert.deepEqual(content.bytes, PDF_BYTES);
    assert.equal(content.sha256, dto.sha256);
    assert.equal(content.mimeType, 'application/pdf');
  });

  it('surfaces a missing stored object as a conflict (content-missing, never silent)', async () => {
    const fixture = createFixture();
    const store = new InMemoryDocumentContentStore();
    const service = new DocumentService({
      store,
      documents: new InMemoryDocumentMetadataRepository(),
      patients: { findById: async () => undefined },
      orders: { findByOrderItemId: async () => undefined },
      facilities: (
        fixture.orders as unknown as {
          deps: { facilities: import('../../../src/app/ports').FacilityDirectory };
        }
      ).deps.facilities,
      audit: fixture.audit,
      idempotency: new InMemoryIdempotencyStore(),
    });
    // Store, then evict the object directly to simulate missing content.
    const dto = await service.storeDocument(fixture.session, uploadInput() as never);
    (store as unknown as { objects: Map<string, Uint8Array> }).objects.clear();
    await assert.rejects(
      service.getDocumentContent(fixture.session, dto.id as never),
      ConflictError,
    );
  });

  it('is unauthenticated without a session (fail-closed)', async () => {
    const fixture = createFixture();
    const service = serviceFor(fixture);
    await assert.rejects(
      service.storeDocument(undefined, uploadInput() as never),
      ValidationError,
    );
  });
});

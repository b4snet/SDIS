/**
 * Document lifecycle & access extensions — application/security tests (Step 23).
 *
 * Proves the Step-23 capability over the EXISTING Step-13 document service:
 * retirement (access removal, never deletion), staff per-patient listing,
 * explicit patient visibility, patient document access through the Step-22
 * ownership gate, real checksum verification, and the clinical-safety
 * invariants (document handling never touches clinical records).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFixture,
  sessionFor,
  FACILITY,
  OTHER_FACILITY,
  ORG,
  PATIENT_ID,
  OTHER_PATIENT_ID,
  ENCOUNTER_ID,
  at,
  type LabFixture,
} from './helpers';
import type { ApplicationSession } from '../../src/app/context';
import {
  AuthorizationService,
  claimedRoleResolver,
  ROLES,
} from '../../src/app/authz/rbac';
import { InMemoryPatientPrincipalRegistry } from '../../src/app/in-memory';
import {
  InMemoryDocumentContentStore,
  InMemoryDocumentMetadataRepository,
} from '../../src/app/in-memory-documents';
import {
  DocumentService,
  type DocumentServiceDependencies,
} from '../../src/app/documents/document-service';
import { PatientDocumentAccessService } from '../../src/app/patient-access/document-access-service';
import { canRetireDocument } from '../../src/domain/documents/documents';
import type { FacilityDirectory } from '../../src/app/ports';

/** One wired document stack over a lab fixture's patient/order data. */
interface DocFixture {
  readonly documents: DocumentService;
  readonly store: InMemoryDocumentContentStore;
  readonly repo: InMemoryDocumentMetadataRepository;
  readonly patientAccess: PatientDocumentAccessService;
  readonly bindings: InMemoryPatientPrincipalRegistry;
  readonly lab: LabFixture;
  readonly staff: ApplicationSession;
}

function createDocFixture(): DocFixture {
  const staff = {
    ...sessionFor(),
    roles: ['operator'] as never,
  };
  const lab = createFixture(staff);
  const facilities = (
    lab.orders as unknown as { deps: { facilities: FacilityDirectory } }
  ).deps.facilities;
  const store = new InMemoryDocumentContentStore();
  const repo = new InMemoryDocumentMetadataRepository();
  const authz = new AuthorizationService({ roleResolver: claimedRoleResolver() });
  const deps: DocumentServiceDependencies = {
    store,
    documents: repo,
    patients: {
      findById: async (id) => {
        const found = await (
          lab.orders as unknown as {
            deps: {
              patients: {
                findById(
                  id: string,
                ): Promise<{ registeredAtFacilityId: string } | undefined>;
              };
            };
          }
        ).deps.patients.findById(id);
        return found ?? undefined;
      },
    },
    orders: {
      findByOrderItemId: async () => undefined,
    },
    facilities,
    audit: lab.audit,
    idempotency: (lab.orders as unknown as { deps: { idempotency: never } }).deps
      .idempotency,
    authz,
  };
  const documents = new DocumentService(deps);
  const bindings = new InMemoryPatientPrincipalRegistry();
  bindings.bind('patient-doc-user-1', PATIENT_ID);
  const patientAccess = new PatientDocumentAccessService({
    principalRegistry: bindings,
    documentMetadata: repo,
    documents,
    facilities,
    audit: lab.audit,
    authz,
  });
  return { documents, store, repo, patientAccess, bindings, lab, staff };
}

const PDF_INPUT = {
  documentType: 'REPORT' as const,
  displayName: 'signed-report.pdf',
  mimeType: 'application/pdf',
  bytes: new TextEncoder().encode('synthetic signed report bytes'),
  patientId: PATIENT_ID,
};

/** The Step-22 patient session shape for the shared binding. */
function patientSession(userId = 'patient-doc-user-1'): ApplicationSession {
  return {
    actor: { kind: 'PATIENT', id: userId },
    userId,
    organizationId: ORG,
    facilityId: FACILITY,
    roles: [ROLES.PATIENT],
  };
}

describe('documents step 23: lifecycle (retire, never delete)', () => {
  it('retires a document: content removed from every read path, metadata intact', async () => {
    const f = createDocFixture();
    const doc = await f.documents.storeDocument(f.staff, PDF_INPUT);

    const retired = await f.documents.retireDocument(f.staff, doc.id as never);
    assert.equal(retired.status, 'RETIRED');
    assert.equal(retired.id, doc.id);

    // Content retrieval is gone; metadata stays IDOR-resistant in scope.
    await assert.rejects(
      f.documents.getDocumentContent(f.staff, doc.id as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
    const meta = await f.documents.getDocument(f.staff, doc.id as never);
    assert.equal(meta.status, 'RETIRED');

    // Content still physically present (no deletion) — retention by design.
    const meta2 = await f.repo.findById(doc.id as never);
    assert.ok(meta2);
    assert.ok(await f.store.get(meta2.location.ref));
  });

  it('retirement is one-way and replay-safe (no duplicate audit)', async () => {
    const f = createDocFixture();
    const doc = await f.documents.storeDocument(f.staff, PDF_INPUT);
    await f.documents.retireDocument(f.staff, doc.id as never);
    const auditAfterFirst = f.lab.audit.list().length;

    // Same-key replay returns current state without a new audit event.
    const replay = await f.documents.retireDocument(f.staff, doc.id as never, {
      idempotencyKey: 'retire-once-23',
    });
    assert.equal(replay.status, 'RETIRED');

    await f.documents.retireDocument(f.staff, doc.id as never, {
      idempotencyKey: 'retire-once-23',
    });
    assert.equal(f.lab.audit.list().length, auditAfterFirst);

    assert.ok(!canRetireDocument({ status: 'RETIRED' }));
    assert.ok(canRetireDocument({ status: 'ACTIVE' }));
  });

  it('rejects retirement outside scope (no existence leak)', async () => {
    const f = createDocFixture();
    const doc = await f.documents.storeDocument(f.staff, PDF_INPUT);
    // An unauthorized principal (no document permission) is FORBIDDEN —
    // authorization fires before any resource check, by design.
    const unauthorized = sessionFor();
    await assert.rejects(
      f.documents.retireDocument(unauthorized, doc.id as never),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
    // An authorized operator from another facility gets the same 404 as an
    // unknown document (no cross-facility existence leak).
    const foreign = {
      ...sessionFor(OTHER_FACILITY),
      roles: ['operator'] as never,
    };
    await assert.rejects(
      f.documents.retireDocument(foreign, doc.id as never),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });
});

describe('documents step 23: integrity & provenance', () => {
  it('verifies content against the RECORDED checksum (mismatch is a conflict)', async () => {
    const f = createDocFixture();
    const doc = await f.documents.storeDocument(f.staff, PDF_INPUT);

    // Happy path: returned digest matches the recorded one.
    const content = await f.documents.getDocumentContent(f.staff, doc.id as never);
    assert.equal(content.sha256, doc.sha256);

    // Tamper with the stored bytes under the SAME ref (same digest tail as
    // the metadata): the re-hash no longer matches the RECORDED checksum,
    // which must surface as a conflict — never silently returned.
    const meta = await f.repo.findById(doc.id as never);
    assert.ok(meta);
    const digest = meta.location.ref.slice(meta.location.ref.indexOf('/') + 1);
    await f.store.put({
      bytes: new TextEncoder().encode('tampered bytes'),
      sha256: digest,
      documentId: doc.id as never,
      displayName: 'signed-report.pdf',
    });
    await assert.rejects(
      f.documents.getDocumentContent(f.staff, doc.id as never),
      (error: { code?: string }) => error.code === 'CONFLICT',
    );
  });

  it('derives provenance from the session actor, never from client input', async () => {
    const f = createDocFixture();
    const doc = await f.documents.storeDocument(f.staff, PDF_INPUT);
    const events = f.lab.audit
      .list()
      .filter(
        (event: { objectType: string; objectId: string }) =>
          event.objectType === 'document' && event.objectId === doc.id,
      );
    assert.equal(events.length, 1);
    const created = events[0];
    assert.ok(created);
    assert.equal(created.action, 'CREATED');
    assert.equal(created.provenance.actor.kind, 'USER');
    assert.equal(created.provenance.actor.id, f.staff.actor.id);
    // Uploading a document does not fabricate clinical authorship: the
    // provenance source is the upload boundary, not a claimed author.
    assert.ok(!JSON.stringify(created.provenance).includes('Dr.'));
  });
});

describe('documents step 23: staff listing & patient visibility', () => {
  it('lists per-patient documents within the session facility only', async () => {
    const f = createDocFixture();
    await f.documents.storeDocument(f.staff, PDF_INPUT);
    await f.documents.storeDocument(f.staff, {
      ...PDF_INPUT,
      displayName: 'referral.pdf',
      patientId: OTHER_PATIENT_ID,
    });

    const mine = await f.documents.listDocumentsForPatient(f.staff, PATIENT_ID);
    assert.equal(mine.length, 1);
    assert.equal(mine[0]?.patientId, PATIENT_ID);

    // A patient outside the facility is indistinguishable from nonexistent.
    await assert.rejects(
      f.documents.listDocumentsForPatient(
        f.staff,
        '00000000-0000-4000-8000-00000000beef' as never,
      ),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });

  it('documents are NOT patient-visible by default; visibility is explicit', async () => {
    const f = createDocFixture();
    await f.documents.storeDocument(f.staff, PDF_INPUT);
    const visible = await f.documents.storeDocument(f.staff, {
      ...PDF_INPUT,
      displayName: 'shareable-result.pdf',
      patientVisible: true,
    });

    const views = await f.patientAccess.listMyDocuments(patientSession());
    assert.equal(views.length, 1);
    assert.equal(views[0]?.id, visible.id);
    assert.equal(views[0]?.patientVisible, true);
  });

  it('patient reads owned+visible docs; foreign/invisible/retired are the same 404', async () => {
    const f = createDocFixture();
    const visible = await f.documents.storeDocument(f.staff, {
      ...PDF_INPUT,
      patientVisible: true,
    });
    const hidden = await f.documents.storeDocument(f.staff, PDF_INPUT);
    const retiredVisible = await f.documents.storeDocument(f.staff, {
      ...PDF_INPUT,
      displayName: 'retired.pdf',
      patientVisible: true,
    });
    await f.documents.retireDocument(f.staff, retiredVisible.id as never);

    const ok = await f.patientAccess.getMyDocument(patientSession(), visible.id as never);
    assert.equal(ok.id, visible.id);
    for (const candidate of [
      hidden.id,
      retiredVisible.id,
      '00000000-0000-4000-8000-00000000dead',
    ]) {
      await assert.rejects(
        f.patientAccess.getMyDocument(patientSession(), candidate as never),
        (error: { code?: string }) => error.code === 'NOT_FOUND',
      );
    }
    // A different patient principal gets the same 404 for the visible doc.
    f.bindings.bind('patient-doc-user-2', OTHER_PATIENT_ID);
    await assert.rejects(
      f.patientAccess.getMyDocument(
        patientSession('patient-doc-user-2'),
        visible.id as never,
      ),
      (error: { code?: string }) => error.code === 'NOT_FOUND',
    );
  });

  it('patient content retrieval is audited once with the PATIENT actor', async () => {
    const f = createDocFixture();
    const visible = await f.documents.storeDocument(f.staff, {
      ...PDF_INPUT,
      patientVisible: true,
    });
    const before = f.lab.audit.list().length;
    const content = await f.patientAccess.getMyDocumentContent(
      patientSession(),
      visible.id as never,
    );
    assert.equal(content.displayName, 'signed-report.pdf');
    const events = f.lab.audit.list().slice(before);
    assert.equal(events.length, 1);
    const access = events[0];
    assert.ok(access);
    assert.equal(access.objectType, 'patient-document-access');
    assert.equal(access.provenance.actor.kind, 'PATIENT');
    assert.ok(!JSON.stringify(events).includes('synthetic signed report bytes'));
  });

  it('staff principals cannot pass the patient gate (fail closed)', async () => {
    const f = createDocFixture();
    await assert.rejects(
      f.patientAccess.listMyDocuments(f.staff),
      (error: { code?: string }) => error.code === 'FORBIDDEN',
    );
  });
});

describe('documents step 23: clinical safety', () => {
  it('document handling never mutates clinical records or their provenance', async () => {
    const f = createDocFixture();
    // A clinical record exists (order); capture its audit stream.
    const order = await f.lab.orders.createOrder(f.staff, {
      patientId: PATIENT_ID,
      encounterId: ENCOUNTER_ID,
      modality: 'LAB',
      items: [{ testCode: 'SYN-DOC', codeSystem: 'SDIS-SYNTHETIC' }],
      orderedAt: at(10),
    });
    const clinicalAuditBefore = JSON.stringify(
      f.lab.audit
        .list()
        .filter(
          (event: { objectType: string }) =>
            event.objectType !== 'document' &&
            event.objectType !== 'patient-document-access',
        ),
    );

    await f.documents.storeDocument(f.staff, PDF_INPUT);
    await f.documents.listDocumentsForPatient(f.staff, PATIENT_ID);
    await f.patientAccess.listMyDocuments(patientSession());
    void order;

    const clinicalAuditAfter = JSON.stringify(
      f.lab.audit
        .list()
        .filter(
          (event: { objectType: string }) =>
            event.objectType !== 'document' &&
            event.objectType !== 'patient-document-access',
        ),
    );
    assert.equal(clinicalAuditAfter, clinicalAuditBefore);
  });
});

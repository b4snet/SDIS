-- Migration 011: Document Metadata Schema
-- Documents are referenced by METADATA; the bytes live behind a storage
-- abstraction (`DocumentContentStore` port) and are never stored in
-- PostgreSQL by this schema. This is an evidence/artifact foundation — no
-- OCR, document AI, PACS, DICOM storage, or external document providers are
-- implemented or implied, and no standards conformance (DICOM/FHIR
-- DocumentReference/HL7/IHE) is claimed.
--
-- Deletion: the existing domain contract has no deletion lifecycle
-- (`retentionUntil` is a governed future process), so this schema has NO
-- delete path wired into application behavior.

SET search_path = sdis, public;

-- ============================================================
-- DOCUMENTS (metadata only — content behind the storage port)
-- ============================================================
CREATE TABLE sdis.documents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type   TEXT NOT NULL CHECK (document_type IN
        ('REQUISITION','REFERRAL','REPORT','CONSENT','PATIENT_DOCUMENT',
         'BILLING_DOCUMENT','QUALITY_DOCUMENT','CALIBRATION_CERTIFICATE',
         'SOP','CERTIFICATE','OTHER')),
    -- Scope: a document belongs to exactly one facility; patient/order links
    -- are optional associations validated by the application against the
    -- same scope before insert (never free-form client references).
    facility_id     UUID NOT NULL REFERENCES sdis.facilities(id) ON DELETE RESTRICT,
    patient_id      UUID REFERENCES sdis.patients(id) ON DELETE RESTRICT,
    order_item_id   UUID REFERENCES sdis.order_items(id) ON DELETE RESTRICT,
    -- Safe display name only: no paths, no directory structure, no client
    -- storage layout hints. The storage location (provider + opaque ref +
    -- encryption flag) follows the domain `DocumentLocation` contract.
    display_name    TEXT NOT NULL,
    mime_type       TEXT NOT NULL,
    size_bytes      BIGINT NOT NULL CHECK (size_bytes > 0),
    -- Content identity: SHA-256 over the exact stored bytes. A retried or
    -- duplicated upload of identical content resolves through idempotency;
    -- a different document with identical bytes is permitted and distinct.
    sha256          TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    storage_provider TEXT NOT NULL CHECK (storage_provider IN ('LOCAL_FS', 'OBJECT_STORE')),
    storage_ref     TEXT NOT NULL,
    storage_encrypted BOOLEAN NOT NULL DEFAULT FALSE,
    version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Retention window is recorded when governance provides one; deletion is
    -- NOT implemented (no DELETE path in the application layer).
    retention_until TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_documents_facility ON sdis.documents(facility_id);
CREATE INDEX idx_documents_patient ON sdis.documents(patient_id);
CREATE INDEX idx_documents_order_item ON sdis.documents(order_item_id);

COMMENT ON TABLE sdis.documents IS
    'Document metadata; bytes live behind the DocumentContentStore port (never in PostgreSQL)';

-- ============================================================
-- RLS Policies (mirror migration 006/009 conventions)
-- ============================================================
ALTER TABLE sdis.documents ENABLE ROW LEVEL SECURITY;

CREATE POLICY pol_documents_tenant ON sdis.documents
    FOR ALL TO sdis_app
    USING (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()))
    WITH CHECK (facility_id IN (SELECT id FROM sdis.facilities WHERE organization_id = sdis.current_organization_id()));

CREATE POLICY pol_documents_facility ON sdis.documents
    FOR ALL TO sdis_app
    USING (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id())
    WITH CHECK (sdis.current_facility_id() IS NULL OR facility_id = sdis.current_facility_id());

GRANT SELECT, INSERT, UPDATE ON sdis.documents TO sdis_app;

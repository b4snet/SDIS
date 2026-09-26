/**
 * SDIS patient registration application service — the intake boundary.
 *
 * Wraps the EXISTING single patient identity contract
 * (`src/domain/patient/patient.ts`) with application semantics: session-derived
 * scope, idempotent creation, audited mutations, DTO responses. There is NO
 * second patient system: the service composes the domain `PatientIdentityService`
 * (identity rules, duplicate-reference rejection) with an injected
 * `PatientRepository` persistence port.
 *
 * Scope rules (docs/TENANCY.md):
 * - `registeredAtFacilityId` is ALWAYS the session facility — a client can
 *   never register a patient into another organization or facility;
 * - external identifier `facilityId` is always the session facility (or the
 *   patient's registered facility) — never client-chosen;
 * - lookup is scope-constrained: a valid patient id is not sufficient to read
 *   outside the caller's facility (IDOR resistance).
 *
 * Identity safety (docs/CLINICAL_SAFETY.md): no fuzzy matching, no
 * probabilistic matching, no automatic merging. Duplicate EXACT references
 * (system+facility+value) are rejected by the domain and surfaced as CONFLICT.
 */

import { randomUUID } from 'node:crypto';
import { PatientIdentityService, type Patient } from '../../domain/patient/patient';
import type { ExternalPatientReference } from '../../types/external-reference';
import type { PatientId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  assertResourceInFacilityScope,
  requireSession,
  type ApplicationSession,
} from '../context';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import type { AuditPort, IdempotencyStore } from '../ports';

/**
 * Persistence port for patient registration (identity + external references).
 * Extends the existing read-only `PatientDirectory` — it does not replace it.
 */
export interface PatientRegistrationRepository {
  /** Persists a new patient with its external references atomically. */
  save(patient: Patient): Promise<Patient>;
  /** Persists one attached external reference for an existing patient. */
  saveExternalReference(
    patientId: PatientId,
    ref: ExternalPatientReference,
  ): Promise<void>;
  /** Loads the patient with its external references (write-path read view). */
  findWithReferences(patientId: PatientId): Promise<Patient | undefined>;
  /** Exact-reference conflict probe (system+facility+value → patient). */
  findPatientIdByExternalReference(
    ref: ExternalPatientReference,
  ): Promise<PatientId | undefined>;
}

/** Registration request — DTO-shaped input, re-validated at the boundary. */
export interface RegisterPatientInput {
  readonly fullName: string;
  readonly sex: Patient['sex'];
  /** ISO-8601 calendar date (YYYY-MM-DD) when known. */
  readonly birthDate?: string;
  /** External references to claim at registration (HMS MRN, enterprise id...). */
  readonly externalReferences?: readonly {
    readonly system: string;
    readonly value: string;
  }[];
  /**
   * Optional provenance source for the registration action (HUMAN entry
   * default). Integration callers pass the existing `INTEGRATION` kind so
   * external-system actions are never recorded as human entry.
   */
  readonly source?: DataSource;
  readonly idempotencyKey?: string;
}

export interface AttachExternalIdentifierInput {
  readonly patientId: PatientId;
  readonly system: string;
  readonly value: string;
  /** Optional provenance source (HUMAN entry default; INTEGRATION for gateways). */
  readonly source?: DataSource;
  readonly idempotencyKey?: string;
}

export interface PatientDTO {
  readonly id: string;
  readonly registeredAtFacilityId: string;
  readonly fullName: string;
  readonly sex: Patient['sex'];
  readonly birthDate?: string;
  readonly externalReferences: readonly {
    readonly system: string;
    readonly value: string;
    readonly facilityId: string;
  }[];
}

export interface PatientServiceDependencies {
  readonly patients: PatientRegistrationRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

const REGISTRATION_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'application patient registration',
};

const VALID_SEX: readonly Patient['sex'][] = ['F', 'M', 'OTHER', 'UNKNOWN'];

/** Calendar-date shape check (YYYY-MM-DD); no semantics are attached to age. */
function isCalendarDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(value).getTime());
}

function toDTO(patient: Patient): PatientDTO {
  return {
    id: patient.id,
    registeredAtFacilityId: patient.registeredAtFacilityId,
    fullName: patient.fullName,
    sex: patient.sex,
    ...(patient.birthDate ? { birthDate: patient.birthDate } : {}),
    externalReferences: patient.externalReferences.map((ref) => ({
      system: ref.system,
      value: ref.value,
      facilityId: ref.facilityId,
    })),
  };
}

export class PatientService {
  private readonly audit: AuditRecorder;

  /** In-memory identity rules engine backing the service (domain contract). */
  private readonly identity: PatientIdentityService;

  constructor(private readonly deps: PatientServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
    this.identity = new PatientIdentityService();
  }

  /**
   * Registers a patient in the session facility through the domain identity
   * contract. Duplicate EXACT external references (system+facility+value)
   * surface as CONFLICT — identity is never silently merged.
   */
  async registerPatient(
    session: ApplicationSession | undefined,
    input: RegisterPatientInput,
  ): Promise<PatientDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.PATIENT_CREATE);
    await assertSessionFacility(session, this.deps.facilities);
    if (!input.fullName || !input.fullName.trim()) {
      throw new ValidationError('A patient requires a full name');
    }
    if (!VALID_SEX.includes(input.sex)) {
      throw new ValidationError(`Field "sex" must be one of ${VALID_SEX.join(', ')}`);
    }
    if (input.birthDate !== undefined && !isCalendarDate(input.birthDate)) {
      throw new ValidationError('Field "birthDate" must be a YYYY-MM-DD calendar date');
    }

    const refs: ExternalPatientReference[] = (input.externalReferences ?? []).map(
      (ref) => ({
        system: ref.system,
        value: ref.value,
        facilityId: session.facilityId,
      }),
    );

    const patient = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.PATIENT_CREATE,
      input.idempotencyKey,
      () => this.registerWithAudit(session, input, refs),
      session,
    );
    return toDTO(patient);
  }

  private async registerWithAudit(
    session: ApplicationSession,
    input: RegisterPatientInput,
    refs: ExternalPatientReference[],
  ): Promise<Patient> {
    // Duplicate-reference check against the AUTHORITATIVE store: a patient
    // claiming an already-registered reference in this facility is a conflict.
    for (const ref of refs) {
      const existing = await this.deps.patients.findPatientIdByExternalReference(ref);
      if (existing !== undefined) {
        throw new ConflictError(
          'An external identifier with this system and value is already registered in this facility',
        );
      }
    }

    const id = randomUUID() as PatientId;
    // Domain contract performs the identity rules (duplicate rejection,
    // immutable reference list) — the service never bypasses it.
    const patient = this.identity.createPatient({
      id,
      registeredAtFacilityId: session.facilityId,
      fullName: input.fullName,
      sex: input.sex,
      ...(input.birthDate ? { birthDate: input.birthDate } : {}),
      externalReferences: refs,
    });
    const persisted = await this.deps.patients.save(patient);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'patient',
      objectId: id,
      at: new Date().toISOString(),
      // Caller-supplied source (integration) or the HUMAN registration default.
      source: input.source ?? REGISTRATION_SOURCE,
    });
    return persisted;
  }

  /**
   * Attaches an external identifier to an existing patient. The patient must
   * exist and be inside the session facility scope; the reference is claimed
   * at the patient's registered facility. Audited and idempotent.
   */
  async attachExternalIdentifier(
    session: ApplicationSession | undefined,
    input: AttachExternalIdentifierInput,
  ): Promise<PatientDTO> {
    requireSession(session);
    // Attaching an identifier mutates the registration record — the same
    // operator-tier registration capability as creating the patient.
    await this.deps.authz?.assertPermission(session, PERMISSIONS.PATIENT_CREATE);
    if (!input.system || !input.value) {
      throw new ValidationError('An external identifier requires a system and a value');
    }
    const patient = await this.requireScopedPatient(session, input.patientId);

    const ref: ExternalPatientReference = {
      system: input.system,
      value: input.value,
      facilityId: patient.registeredAtFacilityId,
    };
    const updated = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.PATIENT_IDENTIFIER_ATTACH,
      input.idempotencyKey,
      () =>
        this.attachWithAudit(session, patient, ref, input.source ?? REGISTRATION_SOURCE),
      session,
    );
    return toDTO(updated);
  }

  private async attachWithAudit(
    session: ApplicationSession,
    patient: Patient,
    ref: ExternalPatientReference,
    source: DataSource,
  ): Promise<Patient> {
    const existing = await this.deps.patients.findPatientIdByExternalReference(ref);
    if (existing !== undefined && existing !== patient.id) {
      throw new ConflictError(
        'An external identifier with this system and value is already registered in this facility',
      );
    }
    const claimed = this.identity.attachExternalReference(patient.id, ref);
    await this.deps.patients.saveExternalReference(patient.id, ref);
    // Audit convention: objectId is the UUID of the affected object (the
    // patient — migration 005 requires a UUID). The raw identifier VALUE is
    // deliberately excluded from detail: an MRN/external value is PHI-adjacent
    // and audit detail is non-PHI by contract (src/app/audit.ts).
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'patient-external-identifier',
      objectId: patient.id,
      at: new Date().toISOString(),
      source: source,
      detail: `external identifier attached (system: ${ref.system})`,
    });
    return claimed;
  }

  /** Scope-constrained lookup (IDOR-resistant): valid id ≠ access. */
  async getPatient(
    session: ApplicationSession | undefined,
    patientId: PatientId,
  ): Promise<PatientDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.PATIENT_READ);
    return toDTO(await this.requireScopedPatient(session, patientId));
  }

  /** Patient must exist and be registered inside the session facility scope. */
  async requireScopedPatient(
    session: ApplicationSession,
    patientId: PatientId,
  ): Promise<Patient> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    const patient = await this.deps.patients.findWithReferences(patientId);
    if (!patient) throw new NotFoundError('Patient not found');
    assertResourceInFacilityScope(session, {
      facilityId: patient.registeredAtFacilityId,
    });
    return patient;
  }
}

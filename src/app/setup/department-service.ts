/**
 * SDIS department master-data application service (Step 24).
 *
 * Departments already exist as canonical master data
 * (`sdis.departments`, migration 001: facility-owned, unique code per
 * facility) and are referenced by the Step-15 DEPARTMENT configuration
 * family. This service exposes the MISSING application administration
 * boundary — create / list / deactivate — WITHOUT creating a second master
 * store or altering existing references:
 *
 * - Scope is always server-derived from the session facility; codes are
 *   unique per facility (schema-enforced) and never recycled as identity.
 * - Deactivation is a status transition, NEVER deletion: departments may be
 *   referenced by configuration, orders, and historical records. An
 *   inactive department remains resolvable for history but cannot receive
 *   new department-scoped configuration.
 * - Every mutation is audited through the ONE append-only audit path with
 *   session-derived provenance; client-supplied identity is never accepted.
 * - RBAC reuses the existing `setup.manage` permission (administration is
 *   already the manager tier) — no second permission system.
 */

import { randomUUID } from 'node:crypto';
import type { DepartmentId, FacilityId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';

/** Department lifecycle: deactivation is one-way; no physical delete. */
export type DepartmentStatus = 'ACTIVE' | 'INACTIVE';

export interface DepartmentRecord {
  readonly id: DepartmentId;
  readonly facilityId: FacilityId;
  readonly name: string;
  readonly code: string;
  readonly modalities: readonly string[];
  readonly status: DepartmentStatus;
}

/** Persistence port over the EXISTING sdis.departments table (Step 24). */
export interface DepartmentRepository {
  save(department: DepartmentRecord): Promise<DepartmentRecord>;
  findById(id: DepartmentId): Promise<DepartmentRecord | undefined>;
  /** Facility-scoped listing (server-derived scope; deterministic order). */
  listByFacility(facilityId: FacilityId): Promise<readonly DepartmentRecord[]>;
  /** Uniqueness probe: which facility owns this code, if any. */
  findByCode(facilityId: FacilityId, code: string): Promise<DepartmentRecord | undefined>;
}

export interface CreateDepartmentInput {
  readonly name: string;
  readonly code: string;
  readonly modalities?: readonly string[];
  readonly idempotencyKey?: string;
}

export interface DepartmentDTO {
  readonly id: string;
  readonly facilityId: string;
  readonly name: string;
  readonly code: string;
  readonly modalities: readonly string[];
  readonly status: DepartmentStatus;
}

/** Codes are stable operational identifiers, not free text. */
const CODE_PATTERN = /^[A-Z][A-Z0-9]{1,15}$/;
const MAX_NAME_LENGTH = 160;
/** Modality names ride the existing modality vocabulary contract. */
const MODALITY_PATTERN = /^[A-Z][A-Z0-9_]{1,19}$/;
const MAX_MODALITIES = 12;

const DEPARTMENT_SOURCE: DataSource = {
  kind: 'SYSTEM',
  label: 'department master data administration',
};

function toDTO(record: DepartmentRecord): DepartmentDTO {
  return {
    id: record.id,
    facilityId: record.facilityId,
    name: record.name,
    code: record.code,
    modalities: record.modalities,
    status: record.status,
  };
}

export interface DepartmentServiceDependencies {
  readonly departments: DepartmentRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  readonly authz?: AuthorizationService;
}

export class DepartmentService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: DepartmentServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /** Registers one department in the session facility (idempotent-keyed). */
  async createDepartment(
    session: ApplicationSession | undefined,
    input: CreateDepartmentInput,
  ): Promise<DepartmentDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH) {
      throw new ValidationError(
        `Department name must be 1-${MAX_NAME_LENGTH} characters`,
      );
    }
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!CODE_PATTERN.test(code)) {
      throw new ValidationError(
        'Department code must be 2-16 characters: uppercase letters/digits, starting with a letter',
      );
    }
    const modalities = (input.modalities ?? []).map((modality) => {
      if (typeof modality !== 'string' || !MODALITY_PATTERN.test(modality)) {
        throw new ValidationError('Department modalities must be valid modality names');
      }
      return modality;
    });
    if (modalities.length > MAX_MODALITIES) {
      throw new ValidationError(`At most ${MAX_MODALITIES} modalities are allowed`);
    }

    return toDTO(
      await runIdempotent(
        this.deps.idempotency,
        IDEMPOTENCY_SCOPES.SETUP_CONFIG_CREATE,
        input.idempotencyKey,
        async () => {
          const existing = await this.deps.departments.findByCode(facilityId, code);
          if (existing) {
            // The code is a stable identifier: never silently reused, even
            // for a previously deactivated department.
            throw new ConflictError('Department code already exists in this facility');
          }
          const record: DepartmentRecord = {
            id: randomUUID() as DepartmentId,
            facilityId,
            name,
            code,
            modalities,
            status: 'ACTIVE',
          };
          const saved = await this.deps.departments.save(record);
          await this.audit.record(session, {
            action: 'CREATED',
            objectType: 'department',
            objectId: saved.id,
            at: new Date().toISOString(),
            source: DEPARTMENT_SOURCE,
            detail: `department ${saved.code}`,
          });
          return saved;
        },
        session,
      ),
    );
  }

  /** One department by id, scope-checked (IDOR-resistant 404 semantics). */
  async getDepartment(
    session: ApplicationSession | undefined,
    departmentId: DepartmentId,
  ): Promise<DepartmentDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const record = await this.deps.departments.findById(departmentId);
    if (!record || record.facilityId !== session.facilityId) {
      throw new NotFoundError('Department not found');
    }
    return toDTO(record);
  }

  /** All departments of the session facility, deterministic order. */
  async listDepartments(
    session: ApplicationSession | undefined,
  ): Promise<readonly DepartmentDTO[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const records = await this.deps.departments.listByFacility(session.facilityId);
    return records.map(toDTO);
  }

  /**
   * Deactivates one department (one-way; never deletion). Idempotent:
   * deactivating an inactive department returns current state with no
   * duplicate audit. Historical references remain resolvable.
   */
  async deactivateDepartment(
    session: ApplicationSession | undefined,
    departmentId: DepartmentId,
    options: { readonly idempotencyKey?: string } = {},
  ): Promise<DepartmentDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const record = await this.deps.departments.findById(departmentId);
    if (!record || record.facilityId !== session.facilityId) {
      throw new NotFoundError('Department not found');
    }
    if (record.status === 'INACTIVE') {
      return toDTO(record);
    }
    return toDTO(
      await runIdempotent(
        this.deps.idempotency,
        IDEMPOTENCY_SCOPES.SETUP_CONFIG_UPDATE,
        options.idempotencyKey,
        async () => {
          const updated = await this.deps.departments.save({
            ...record,
            status: 'INACTIVE',
          });
          await this.audit.record(session, {
            action: 'UPDATED',
            objectType: 'department',
            objectId: record.id,
            at: new Date().toISOString(),
            source: DEPARTMENT_SOURCE,
            detail: 'department deactivated (references preserved)',
          });
          return updated;
        },
        session,
      ),
    );
  }
}

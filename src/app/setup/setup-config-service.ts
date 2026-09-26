/**
 * SDIS master-setup configuration application service (Step 15).
 *
 * Makes the EXISTING master-setup contract
 * (`src/domain/master-setup/master-setup.ts`) a real capability for the
 * configuration families this phase supports. The domain rule is preserved
 * exactly: **every configuration record is scoped and versioned** — an update
 * APPENDS version N+1 in the same scope instead of overwriting, so history
 * always shows which configuration was in effect at a given time.
 *
 * Supported families (the smallest operational slice — see
 * `docs/PROJECT_STATUS.md`):
 * - `FACILITY`   — facility-scoped operational settings (no department scope).
 * - `DEPARTMENT` — department-scoped operational settings; the department must
 *                  exist inside the session facility (validated reference).
 *
 * NOT implemented, deliberately: families with clinical-consequence semantics
 * (`REFERENCE_RANGE`, `TEST_CATALOG`, `UNIT`, `REPORT_TEMPLATE`, ...), financial
 * families (`PRICING`, `BILLING_CONFIG`, `PACKAGE`), administration families
 * (`USER`, `ROLE`, `PERMISSION`), and families whose authoritative source of
 * truth already exists elsewhere (`MODALITY`, `DEVICE`, `ANALYZER`,
 * `DOCUMENT_TYPE`, `SPECIMEN_TYPE`). No clinical semantics are invented here.
 *
 * Scope is ALWAYS server-derived from the session; a facility configuration
 * never becomes organization-global configuration.
 */

import { randomUUID } from 'node:crypto';
import type { DepartmentId, FacilityId, SetupConfigId } from '../../types/ids';
import type { ConfigFamily, ConfigRecord } from '../../domain/master-setup/master-setup';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  facilityContextOf,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';
import type { AuditPort, IdempotencyStore } from '../ports';

/** Configuration families supported by this phase (domain families only). */
export const SUPPORTED_CONFIG_FAMILIES: readonly ConfigFamily[] = [
  'FACILITY',
  'DEPARTMENT',
];

/**
 * Bounded key registry (Step 24): every key WITH OPERATIONAL BEHAVIOR has a
 * defined type, validator, and safe default here. Registered keys are
 * validated strictly (type + range) at write time; adding a behavior means
 * adding a registry entry, a default, and a consumer test.
 *
 * Unregistered keys keep the pre-Step-24 generic validation (identifier
 * pattern, secret refusal, JSON-scalar shape) and are OPERATIONALLY INERT:
 * no subsystem may consult them, and they carry no default. Clinical
 * semantics can therefore never ride configuration — there is no consumer
 * path from an unregistered key to any clinical behavior (proven by tests).
 *
 * Defaults are deterministic and documented: absent configuration must never
 * silently change existing behavior, so every default equals the behavior
 * the consuming subsystem exhibited before the key existed.
 */
export const CONFIG_KEY_REGISTRY = {
  /**
   * Worklist page size (Step 24 consumer: WorklistService). Operational
   * queue paging only — never ordering semantics, never clinical triage.
   */
  'worklist.defaultPageSize': {
    type: 'integer',
    min: 1,
    max: 200,
    default: 50,
    description: 'Maximum worklist entries returned per read (1-200).',
  },
  /**
   * Whether the worklist includes cancelled/reported history (Step 24
   * consumer: WorklistService). Pure filtering; ordering is unaffected.
   */
  'worklist.includeHistory': {
    type: 'boolean',
    default: false,
    description:
      'When true, the worklist also includes REPORTED history for the facility.',
  },
} as const;

export type ConfigKey = keyof typeof CONFIG_KEY_REGISTRY;

/** The validated, typed form of a registry key's value. */
export type ConfigValueOf<K extends ConfigKey> = (typeof CONFIG_KEY_REGISTRY)[K] extends {
  readonly type: 'integer';
}
  ? number
  : (typeof CONFIG_KEY_REGISTRY)[K] extends { readonly type: 'boolean' }
    ? boolean
    : string;

/** Validates one value against a registry entry; throws ValidationError. */
function validateValueForKey(
  key: ConfigKey,
  entry: (typeof CONFIG_KEY_REGISTRY)[ConfigKey],
  value: unknown,
): void {
  if (entry.type === 'integer') {
    if (
      typeof value !== 'number' ||
      !Number.isInteger(value) ||
      value < entry.min ||
      value > entry.max
    ) {
      throw new ValidationError(
        `Configuration "${key}" must be an integer between ${entry.min} and ${entry.max}`,
      );
    }
    return;
  }
  if (entry.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new ValidationError(`Configuration "${key}" must be a boolean`);
    }
    return;
  }
  // string (no enum keys registered yet — reserved for future bounded keys)
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new ValidationError(`Configuration "${key}" must be a 1-256 character string`);
  }
}

/** A stored configuration version: the domain record plus its stable id. */
export interface SetupConfigRecord extends ConfigRecord {
  readonly id: SetupConfigId;
}

export interface SetupConfigRepository {
  /** Appends one version row; duplicates (same scope/family/key/version) conflict. */
  save(record: SetupConfigRecord): Promise<SetupConfigRecord>;
  findById(id: SetupConfigId): Promise<SetupConfigRecord | undefined>;
  /** Latest version for one scope/family/key (scope = facility + department?). */
  findLatest(
    facilityId: FacilityId,
    departmentId: DepartmentId | undefined,
    family: ConfigFamily,
    key: string,
  ): Promise<SetupConfigRecord | undefined>;
  /** Latest version of every configuration in the facility (history excluded). */
  listLatest(facilityId: FacilityId): Promise<readonly SetupConfigRecord[]>;
  /** Validates a department reference: which facility owns it (or undefined). */
  findDepartmentFacility(departmentId: DepartmentId): Promise<FacilityId | undefined>;
}

export interface CreateConfigInput {
  readonly family: ConfigFamily;
  readonly key: string;
  readonly value: unknown;
  /** Date-effective from (the domain's `effectiveFrom`). */
  readonly effectiveFrom: string;
  /** Source of the value (e.g. a regulatory version) when statutory. */
  readonly sourceVersion?: string;
  /** Required for the DEPARTMENT family, forbidden for FACILITY. */
  readonly departmentId?: DepartmentId;
  readonly idempotencyKey?: string;
}

export interface UpdateConfigInput {
  readonly family: ConfigFamily;
  readonly key: string;
  readonly value: unknown;
  readonly effectiveFrom: string;
  readonly sourceVersion?: string;
  readonly departmentId?: DepartmentId;
  /**
   * The version the caller believes is current. A stale value is rejected
   * (CONFLICT) so a concurrent change is never silently overwritten.
   */
  readonly expectedVersion: number;
  readonly idempotencyKey?: string;
}

export interface SetupConfigDTO {
  readonly id: string;
  readonly family: ConfigFamily;
  readonly organizationId: string;
  readonly facilityId: string;
  readonly departmentId?: string;
  readonly key: string;
  readonly value: unknown;
  readonly version: number;
  readonly sourceVersion?: string;
  readonly effectiveFrom: string;
}

export interface SetupConfigServiceDependencies {
  readonly config: SetupConfigRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** The ONE authorization engine (fail-closed when absent). */
  readonly authz?: AuthorizationService;
}

const SETUP_SOURCE = {
  kind: 'SYSTEM',
  label: 'application master setup',
} as const;

/** Setting keys are operational identifiers — never free-form text. */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

/**
 * Conservative guard: configuration must never become a secret store. Values
 * are operational settings and are returned to clients, so obviously
 * secret-bearing keys are refused outright.
 */
const SECRET_KEY_PATTERN =
  /(^|[._-])(secret|password|passwd|token|credential|api[._-]?key|private[._-]?key|salt)([._-]|$)/i;

const MAX_VALUE_BYTES = 8192;
const MAX_KEY_LENGTH = 128;
const MAX_SOURCE_VERSION_LENGTH = 64;

function toDTO(record: SetupConfigRecord): SetupConfigDTO {
  return {
    id: record.id,
    family: record.family,
    organizationId: record.context.organizationId,
    facilityId: record.context.facilityId,
    ...(record.context.departmentId ? { departmentId: record.context.departmentId } : {}),
    key: record.key,
    value: record.value,
    version: record.version,
    ...(record.sourceVersion ? { sourceVersion: record.sourceVersion } : {}),
    effectiveFrom: record.effectiveFrom,
  };
}

export class SetupConfigService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: SetupConfigServiceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /** Creates version 1 of a configuration in the session scope. */
  async createConfig(
    session: ApplicationSession | undefined,
    input: CreateConfigInput,
  ): Promise<SetupConfigDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    const validated = await this.validateInput(session, facilityId, input);
    return toDTO(
      await runIdempotent(
        this.deps.idempotency,
        IDEMPOTENCY_SCOPES.SETUP_CONFIG_CREATE,
        input.idempotencyKey,
        // The duplicate check belongs INSIDE the idempotent unit: a keyed
        // retry returns the stored result instead of conflicting with the
        // record the first attempt already created.
        async () => {
          const existing = await this.deps.config.findLatest(
            facilityId,
            validated.departmentId,
            input.family,
            validated.key,
          );
          if (existing) {
            throw new ConflictError('This configuration already exists in this scope');
          }
          return this.createVersion(session, facilityId, input, validated, 1, undefined);
        },
        session,
      ),
    );
  }

  /**
   * Appends a new version of an existing configuration. History is preserved:
   * no version row is ever overwritten or removed.
   */
  async updateConfig(
    session: ApplicationSession | undefined,
    input: UpdateConfigInput,
  ): Promise<SetupConfigDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    const facilityId = session.facilityId;
    const validated = await this.validateInput(session, facilityId, input);
    return toDTO(
      await runIdempotent(
        this.deps.idempotency,
        IDEMPOTENCY_SCOPES.SETUP_CONFIG_UPDATE,
        input.idempotencyKey,
        // Inside the idempotent unit: a keyed retry returns the version the
        // first attempt appended rather than failing the staleness guard.
        async () => {
          const latest = await this.deps.config.findLatest(
            facilityId,
            validated.departmentId,
            input.family,
            validated.key,
          );
          if (!latest) {
            throw new NotFoundError('Configuration not found');
          }
          if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
            throw new ValidationError('expectedVersion must be a positive integer');
          }
          if (input.expectedVersion !== latest.version) {
            // No lost updates: the caller must read the current version first.
            throw new ConflictError('Configuration was changed by another operation');
          }
          return this.createVersion(
            session,
            facilityId,
            input,
            validated,
            latest.version + 1,
            latest.version,
          );
        },
        // SEC-32: configuration replays are scoped like every other operation —
        // the session's server-derived facility is part of the key namespace.
        session,
      ),
    );
  }

  /** Retrieves the latest version of one configuration in the session scope. */
  async getConfig(
    session: ApplicationSession | undefined,
    params: {
      readonly family: ConfigFamily;
      readonly key: string;
      readonly departmentId?: DepartmentId;
    },
  ): Promise<SetupConfigDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    this.assertFamily(params.family);
    const departmentId = await this.resolveDepartmentScope(
      session.facilityId,
      params.family,
      params.departmentId,
    );
    const record = await this.deps.config.findLatest(
      session.facilityId,
      departmentId,
      params.family,
      params.key,
    );
    if (!record) throw new NotFoundError('Configuration not found');
    return toDTO(record);
  }

  /** Retrieves one configuration version by id, scope-checked (IDOR-resistant). */
  async getConfigById(
    session: ApplicationSession | undefined,
    id: SetupConfigId,
  ): Promise<SetupConfigDTO> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const record = await this.deps.config.findById(id);
    if (!record || record.context.facilityId !== session.facilityId) {
      // Scope-unaware 404: no existence leak across facilities.
      throw new NotFoundError('Configuration not found');
    }
    return toDTO(record);
  }

  /**
   * Lists the configuration APPLICABLE to the session: facility-scoped
   * settings for the session facility, plus department-scoped settings for the
   * session's own department. A facility setting never becomes global.
   */
  async listApplicable(
    session: ApplicationSession | undefined,
  ): Promise<readonly SetupConfigDTO[]> {
    requireSession(session);
    await this.deps.authz?.assertPermission(session, PERMISSIONS.SETUP_READ);
    await assertSessionFacility(session, this.deps.facilities);
    const records = await this.deps.config.listLatest(session.facilityId);
    return records
      .filter(
        (record) =>
          record.family === 'FACILITY' ||
          (record.family === 'DEPARTMENT' &&
            record.context.departmentId === session.departmentId),
      )
      .map(toDTO)
      .sort((a, b) =>
        a.family === b.family
          ? a.key.localeCompare(b.key)
          : a.family.localeCompare(b.family),
      );
  }

  private async createVersion(
    session: ApplicationSession,
    facilityId: FacilityId,
    input: CreateConfigInput | UpdateConfigInput,
    validated: {
      readonly key: string;
      readonly value: unknown;
      readonly departmentId?: DepartmentId;
      readonly sourceVersion?: string;
    },
    version: number,
    previousVersion: number | undefined,
  ): Promise<SetupConfigRecord> {
    const context = facilityContextOf(session);
    const record: SetupConfigRecord = {
      id: randomUUID() as SetupConfigId,
      family: input.family,
      context: {
        organizationId: context.organizationId,
        facilityId,
        ...(validated.departmentId ? { departmentId: validated.departmentId } : {}),
      },
      key: validated.key,
      value: validated.value,
      version,
      ...(validated.sourceVersion ? { sourceVersion: validated.sourceVersion } : {}),
      effectiveFrom: input.effectiveFrom,
    };
    const persisted = await this.deps.config.save(record);
    await this.audit.record(session, {
      action: previousVersion === undefined ? 'CREATED' : 'UPDATED',
      objectType: 'setup-config',
      objectId: persisted.id,
      at: new Date().toISOString(),
      source: SETUP_SOURCE,
      // Non-sensitive metadata only — configuration VALUES are never audited.
      detail:
        previousVersion === undefined
          ? `${persisted.family} key=${persisted.key} version=${persisted.version} created`
          : // ASCII only: the audit trail must be writable by any client
            // encoding (a non-ASCII separator breaks WIN1252 databases).
            `${persisted.family} key=${persisted.key} version=${previousVersion} -> ${persisted.version}`,
    });
    return persisted;
  }

  /** Server-side validation: family, key, value, dates, and department scope. */
  private async validateInput(
    session: ApplicationSession,
    facilityId: FacilityId,
    input: CreateConfigInput | UpdateConfigInput,
  ): Promise<{
    readonly key: string;
    readonly value: unknown;
    readonly departmentId?: DepartmentId;
    readonly sourceVersion?: string;
  }> {
    this.assertFamily(input.family);
    const key = typeof input.key === 'string' ? input.key.trim() : '';
    if (key.length === 0 || key.length > MAX_KEY_LENGTH || !KEY_PATTERN.test(key)) {
      throw new ValidationError(
        'Configuration key must be a 1-128 character identifier (letters, digits, . _ -)',
      );
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new ValidationError('Secret material must not be stored as configuration');
    }
    this.assertValue(input.value);
    // Bounded registry (Step 24): registered keys are typed + range-validated
    // strictly; unregistered keys are inert (never consulted by any consumer)
    // but still pass the common shape/scope validation below.
    const registryEntry = CONFIG_KEY_REGISTRY[key as ConfigKey] as
      (typeof CONFIG_KEY_REGISTRY)[ConfigKey] | undefined;
    if (registryEntry) {
      validateValueForKey(key as ConfigKey, registryEntry, input.value);
    }
    if (
      typeof input.effectiveFrom !== 'string' ||
      Number.isNaN(new Date(input.effectiveFrom).getTime())
    ) {
      throw new ValidationError('effectiveFrom must be a valid timestamp');
    }
    if (
      input.sourceVersion !== undefined &&
      (typeof input.sourceVersion !== 'string' ||
        input.sourceVersion.length === 0 ||
        input.sourceVersion.length > MAX_SOURCE_VERSION_LENGTH)
    ) {
      throw new ValidationError('sourceVersion must be 1-64 characters when provided');
    }
    const departmentId = await this.resolveDepartmentScope(
      facilityId,
      input.family,
      input.departmentId,
    );
    // A department-scoped setting must never be created by a session outside
    // that department — scope is server-derived, never client-asserted.
    if (
      departmentId !== undefined &&
      session.departmentId !== undefined &&
      session.departmentId !== departmentId
    ) {
      throw new NotFoundError('Department not found');
    }
    return {
      key,
      value: input.value,
      ...(departmentId ? { departmentId } : {}),
      ...(input.sourceVersion ? { sourceVersion: input.sourceVersion } : {}),
    };
  }

  private assertFamily(family: ConfigFamily): void {
    if (!SUPPORTED_CONFIG_FAMILIES.includes(family)) {
      throw new ValidationError('Unsupported configuration family');
    }
  }

  /** Configuration values are opaque JSON — never clinical semantics. */
  private assertValue(value: unknown): void {
    if (value === undefined || value === null) {
      throw new ValidationError('Configuration value is required');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ValidationError('Configuration value must be finite');
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new ValidationError('Configuration value must be JSON-serializable');
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      throw new ValidationError('Configuration value must be JSON-serializable');
    }
    if (serialized === undefined) {
      throw new ValidationError('Configuration value must be JSON-serializable');
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_VALUE_BYTES) {
      throw new ValidationError('Configuration value exceeds the 8 KiB limit');
    }
  }

  /**
   * Resolves the owning scope of a configuration: FACILITY settings carry no
   * department, DEPARTMENT settings require a department INSIDE the session
   * facility (a cross-facility department reference is rejected).
   */
  private async resolveDepartmentScope(
    facilityId: FacilityId,
    family: ConfigFamily,
    departmentId: DepartmentId | undefined,
  ): Promise<DepartmentId | undefined> {
    if (family === 'FACILITY') {
      if (departmentId !== undefined) {
        throw new ValidationError('Facility configuration must not carry a department');
      }
      return undefined;
    }
    if (departmentId === undefined) {
      throw new ValidationError('Department configuration requires a department');
    }
    const owningFacility = await this.deps.config.findDepartmentFacility(departmentId);
    if (!owningFacility || owningFacility !== facilityId) {
      throw new NotFoundError('Department not found');
    }
    return departmentId;
  }
}

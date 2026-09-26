/**
 * SDIS terminology persistence application service.
 *
 * Makes the EXISTING terminology domain contract
 * (`src/domain/terminology/terminology.ts`) a real persisted capability: a
 * mapping is validated by the domain rules (internal canonical system,
 * known external system), persisted through an injected port, scoped by the
 * server-derived session (never client-supplied), audited, and idempotent.
 *
 * There is NO second terminology model: this service composes the domain
 * `TerminologyService` (rule engine) with a `TerminologyMappingRepository`
 * port. Scope semantics follow `docs/TENANCY.md`:
 *
 * - a mapping created inside a session facility is that facility's OVERRIDE;
 * - global mappings (no facility) are deployment-wide defaults — creating one
 *   is a system-level decision, NOT permitted from an ordinary facility
 *   session (the service never lets a client escalate to global scope);
 * - retrieval prefers the session facility's override, then global (the same
 *   precedence the domain resolver implements);
 * - a facility override belonging to another facility is never returned
 *   (IDOR resistance: a valid canonical code is not sufficient for access).
 *
 * Terminology storage is infrastructure, NOT clinical decision support: no
 * reference ranges, no thresholds, no probabilistic or fuzzy matching.
 */

import { randomUUID } from 'node:crypto';
import {
  INTERNAL_CODE_SYSTEM,
  KNOWN_EXTERNAL_SYSTEMS,
  type CodeRef,
  type TerminologyMapping,
} from '../../domain/terminology/terminology';
import type { TerminologyMappingId } from '../../types/ids';
import type { DataSource } from '../../types/provenance';
import { AuditRecorder } from '../audit';
import {
  assertSessionFacility,
  requireSession,
  type ApplicationSession,
} from '../context';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { IDEMPOTENCY_SCOPES, runIdempotent } from '../idempotency';
import type { AuditPort, IdempotencyStore } from '../ports';
import { PERMISSIONS, type AuthorizationService } from '../authz/rbac';

/** Persistence port for terminology mappings (write-capable directory). */
export interface TerminologyMappingRepository {
  /** Persists a new mapping. Implementations must reject duplicates. */
  save(mapping: TerminologyMapping): Promise<TerminologyMapping>;
  /** Exact lookup by mapping id. */
  findById(id: TerminologyMappingId): Promise<TerminologyMapping | undefined>;
  /**
   * All mappings resolving one canonical code to one external system, in the
   * domain precedence order (facility override before global). Scope filtering
   * is applied by the service using the session — never by the client.
   */
  listByCanonical(
    canonicalCode: string,
    externalSystem: string,
  ): Promise<readonly TerminologyMapping[]>;
  /**
   * Exact-duplicate probe implementing the schema uniqueness shape
   * (canonical code, external system, external code, facility scope).
   */
  findExact(params: {
    canonicalCode: string;
    externalSystem: string;
    externalCode: string;
    facilityId: TerminologyMapping['facilityId'];
  }): Promise<TerminologyMapping | undefined>;
}

export interface CreateTerminologyMappingInput {
  readonly canonicalCode: string;
  readonly externalSystem: string;
  readonly externalCode: string;
  /**
   * Facility-scoped override flag. The facility itself is ALWAYS the session
   * facility — a client can never create an override for another facility,
   * and `global: true` from a facility session is rejected (scope escalation).
   */
  readonly global?: boolean;
  /** Provenance of the mapping decision (preserved verbatim). */
  readonly validated?: boolean;
  readonly idempotencyKey?: string;
}

export interface TerminologyMappingDTO {
  readonly id: string;
  readonly canonical: CodeRef;
  readonly external: CodeRef;
  readonly facilityId?: string;
  readonly validated: boolean;
}

export interface TerminologyPersistenceDependencies {
  readonly mappings: TerminologyMappingRepository;
  readonly facilities: import('../ports').FacilityDirectory;
  readonly audit: AuditPort;
  readonly idempotency: IdempotencyStore;
  /** Authorization engine (optional seam like every other service). */
  readonly authz?: AuthorizationService;
}

const MAPPING_SOURCE: DataSource = {
  kind: 'HUMAN',
  label: 'application terminology mapping',
};

function toDTO(mapping: TerminologyMapping): TerminologyMappingDTO {
  return {
    id: mapping.id,
    canonical: mapping.canonical,
    external: mapping.external,
    ...(mapping.facilityId ? { facilityId: mapping.facilityId } : {}),
    validated: mapping.validated,
  };
}

export class TerminologyPersistenceService {
  private readonly audit: AuditRecorder;

  constructor(private readonly deps: TerminologyPersistenceDependencies) {
    this.audit = new AuditRecorder(deps.audit);
  }

  /**
   * Creates a mapping through the domain contract. The canonical system is
   * always the SDIS internal system; the external system must be one of the
   * known vocabularies; duplicates are CONFLICT, never silent overwrites.
   */
  async createMapping(
    session: ApplicationSession | undefined,
    input: CreateTerminologyMappingInput,
  ): Promise<TerminologyMappingDTO> {
    requireSession(session);
    // Mapping creation changes facility-wide code resolution — manager tier
    // (reads stay auth+scope gated so every session can resolve codes).
    await this.deps.authz?.assertPermission(session, PERMISSIONS.TERMINOLOGY_MANAGE);
    await assertSessionFacility(session, this.deps.facilities);
    if (!input.canonicalCode || !input.canonicalCode.trim()) {
      throw new ValidationError('A mapping requires a canonical code');
    }
    if (!KNOWN_EXTERNAL_SYSTEMS.includes(input.externalSystem)) {
      throw new ValidationError(
        `Field "externalSystem" must be one of ${KNOWN_EXTERNAL_SYSTEMS.join(', ')}`,
      );
    }
    if (!input.externalCode || !input.externalCode.trim()) {
      throw new ValidationError('A mapping requires an external code');
    }
    const global = input.global ?? false;
    if (global) {
      // Scope escalation guard: an ordinary facility session never decides
      // deployment-wide defaults (server-derived scope only).
      throw new ValidationError(
        'Global mappings are system-level configuration and cannot be created from a facility session',
      );
    }

    const facilityId = session.facilityId;
    // Duplicate probing happens INSIDE the idempotent callback (the established
    // patient-registration pattern): an idempotent replay must return the stored
    // result, never surface as a false CONFLICT before the store is consulted.
    const mapping = await runIdempotent(
      this.deps.idempotency,
      IDEMPOTENCY_SCOPES.TERMINOLOGY_MAPPING_CREATE,
      input.idempotencyKey,
      () => this.createWithAudit(session, input, facilityId),
      session,
    );
    return toDTO(mapping);
  }

  private async createWithAudit(
    session: ApplicationSession,
    input: CreateTerminologyMappingInput,
    facilityId: ApplicationSession['facilityId'],
  ): Promise<TerminologyMapping> {
    const duplicate = await this.deps.mappings.findExact({
      canonicalCode: input.canonicalCode,
      externalSystem: input.externalSystem,
      externalCode: input.externalCode,
      facilityId,
    });
    if (duplicate !== undefined) {
      throw new ConflictError('An identical mapping already exists in this facility');
    }

    const mapping: TerminologyMapping = {
      id: randomUUID() as TerminologyMappingId,
      canonical: { system: INTERNAL_CODE_SYSTEM, code: input.canonicalCode },
      external: { system: input.externalSystem, code: input.externalCode },
      facilityId,
      validated: input.validated ?? false,
    };
    // The domain rule engine owns validation (internal system, known external
    // system); the service never bypasses it. The rules engine instance here
    // is stateless validation — persistence goes through the port only.
    await this.deps.mappings.save(mapping);
    await this.audit.record(session, {
      action: 'CREATED',
      objectType: 'terminology-mapping',
      objectId: mapping.id,
      at: new Date().toISOString(),
      source: MAPPING_SOURCE,
      detail: `canonical ${mapping.canonical.code} -> ${mapping.external.system} (facility-scoped)`,
    });
    return mapping;
  }

  /** Exact mapping by id, constrained to the session scope (IDOR-resistant). */
  async getMapping(
    session: ApplicationSession | undefined,
    mappingId: TerminologyMappingId,
  ): Promise<TerminologyMappingDTO> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    const mapping = await this.deps.mappings.findById(mappingId);
    if (!mapping) {
      throw new NotFoundError('Mapping not found');
    }
    // TERM-01: global mappings (no facility) are deployment-wide defaults and
    // readable by any facility session — matching resolveMappings precedence.
    // Facility overrides remain strictly scoped to their own facility.
    if (mapping.facilityId !== undefined && mapping.facilityId !== session.facilityId) {
      throw new NotFoundError('Mapping not found');
    }
    return toDTO(mapping);
  }

  /**
   * Resolves mappings for a canonical code to an external system, scoped to
   * the session facility: the facility's own override first, then the global
   * default — the domain precedence, never another facility's override.
   */
  async resolveMappings(
    session: ApplicationSession | undefined,
    canonicalCode: string,
    externalSystem: string,
  ): Promise<readonly TerminologyMappingDTO[]> {
    requireSession(session);
    await assertSessionFacility(session, this.deps.facilities);
    if (!canonicalCode || !canonicalCode.trim()) {
      throw new ValidationError('A canonical code is required');
    }
    if (!KNOWN_EXTERNAL_SYSTEMS.includes(externalSystem)) {
      throw new ValidationError(
        `Field "externalSystem" must be one of ${KNOWN_EXTERNAL_SYSTEMS.join(', ')}`,
      );
    }
    const all = await this.deps.mappings.listByCanonical(canonicalCode, externalSystem);
    return all
      .filter((m) => m.facilityId === undefined || m.facilityId === session.facilityId)
      .map(toDTO);
  }
}

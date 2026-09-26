/**
 * In-memory terminology mapping repository (test/development adapter).
 *
 * Mirrors the PostgreSQL semantics: UNIQUE (canonical code, external system,
 * external code, facility scope) and domain precedence on canonical listing
 * (facility overrides before global). Kept separate from `in-memory.ts` only
 * to keep that module's laboratory focus intact; same adapter conventions.
 */

import type { TerminologyMapping } from '../domain/terminology/terminology';
import type { TerminologyMappingId } from '../types/ids';
import type { TerminologyMappingRepository } from './terminology/terminology-service';

export class InMemoryTerminologyMappingRepository implements TerminologyMappingRepository {
  private readonly mappings = new Map<TerminologyMappingId, TerminologyMapping>();

  async save(mapping: TerminologyMapping): Promise<TerminologyMapping> {
    this.mappings.set(mapping.id, mapping);
    return mapping;
  }

  async findById(id: TerminologyMappingId): Promise<TerminologyMapping | undefined> {
    return this.mappings.get(id);
  }

  async listByCanonical(
    canonicalCode: string,
    externalSystem: string,
  ): Promise<readonly TerminologyMapping[]> {
    // Domain precedence: facility overrides before global defaults.
    return [...this.mappings.values()]
      .filter(
        (m) => m.canonical.code === canonicalCode && m.external.system === externalSystem,
      )
      .sort((a, b) => {
        if (a.facilityId === undefined && b.facilityId !== undefined) return 1;
        if (b.facilityId === undefined && a.facilityId !== undefined) return -1;
        return 0;
      });
  }

  async findExact(params: {
    canonicalCode: string;
    externalSystem: string;
    externalCode: string;
    facilityId: TerminologyMapping['facilityId'];
  }): Promise<TerminologyMapping | undefined> {
    return [...this.mappings.values()].find(
      (m) =>
        m.canonical.code === params.canonicalCode &&
        m.external.system === params.externalSystem &&
        m.external.code === params.externalCode &&
        m.facilityId === params.facilityId,
    );
  }
}

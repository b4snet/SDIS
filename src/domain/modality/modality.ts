/**
 * SDIS modality registry — the single extension point for diagnostic disciplines.
 *
 * The registry lives in the domain layer; the vocabulary types it manages live in
 * the shared types layer. The core domain never branches on modality identity.
 */

import type { ModalityDescriptor, ModalityName } from '../../types/modality';

export type {
  ModalityCapability,
  ModalityDescriptor,
  ModalityName,
} from '../../types/modality';
export { KNOWN_MODALITIES } from '../../types/modality';

export class ModalityRegistry {
  private readonly descriptors = new Map<ModalityName, ModalityDescriptor>();

  register(descriptor: ModalityDescriptor): void {
    if (this.descriptors.has(descriptor.name)) {
      throw new Error(`Modality "${descriptor.name}" is already registered`);
    }
    this.descriptors.set(descriptor.name, descriptor);
  }

  get(name: ModalityName): ModalityDescriptor | undefined {
    return this.descriptors.get(name);
  }

  has(name: ModalityName): boolean {
    return this.descriptors.has(name);
  }

  all(): readonly ModalityDescriptor[] {
    return [...this.descriptors.values()];
  }
}

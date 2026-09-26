/**
 * In-memory billing adapters (test/development) mirroring migration 009
 * semantics: charge idempotency key UNIQUE and order-item/service linkage.
 */

import type { Charge } from '../domain/billing/billing';
import type { BillableServiceId, ChargeId, FacilityId, OrderItemId } from '../types/ids';
import type { ChargeRepository } from './billing/billing-service';
import { ConflictError } from './errors';

interface ServiceEntry {
  readonly id: BillableServiceId;
  readonly facilityId: FacilityId;
  readonly name: string;
  readonly modality: string;
  readonly priceCurrency: string;
  readonly priceAmount: number;
}

export class InMemoryChargeRepository implements ChargeRepository {
  private readonly charges = new Map<ChargeId, Charge>();
  private readonly byKey = new Map<string, ChargeId>();
  private readonly services = new Map<BillableServiceId, ServiceEntry>();

  registerService(service: ServiceEntry): void {
    this.services.set(service.id, service);
  }

  async save(charge: Charge): Promise<Charge> {
    if (this.byKey.has(charge.idempotencyKey)) {
      throw new ConflictError('A charge with this idempotency key already exists');
    }
    this.charges.set(charge.id, charge);
    this.byKey.set(charge.idempotencyKey, charge.id);
    return charge;
  }

  async findById(id: ChargeId): Promise<Charge | undefined> {
    return this.charges.get(id);
  }

  async listByOrderItem(orderItemId: OrderItemId): Promise<readonly Charge[]> {
    return [...this.charges.values()].filter((c) => c.orderItemId === orderItemId);
  }

  async findByIdempotencyKey(key: string): Promise<Charge | undefined> {
    const id = this.byKey.get(key);
    return id ? this.charges.get(id) : undefined;
  }

  async findService(serviceId: BillableServiceId) {
    const service = this.services.get(serviceId);
    return service
      ? {
          id: service.id,
          name: service.name,
          modality: service.modality,
          priceCurrency: service.priceCurrency,
          priceAmount: service.priceAmount,
          facilityId: service.facilityId,
        }
      : undefined;
  }
}

/**
 * SDIS organization / facility / department contracts.
 *
 * Scoping rules:
 * - An Organization owns Facilities.
 * - A Facility owns Departments (diagnostic units) and resources.
 * - Facility-local configuration and organization-wide policy are distinct scopes.
 */

import type { DepartmentId, FacilityId, OrganizationId } from '../../types/ids';
import type { ModalityName } from '../../types/modality';

export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly code: string;
}

export interface Facility {
  readonly id: FacilityId;
  readonly organizationId: OrganizationId;
  readonly name: string;
  readonly code: string;
  readonly timezone: string;
}

export interface DiagnosticDepartment {
  readonly id: DepartmentId;
  readonly facilityId: FacilityId;
  readonly name: string;
  readonly modalities: readonly ModalityName[];
}

/** A facility must belong to the organization that claims it. */
export function assertFacilityBelongsToOrganization(
  facility: Facility,
  organizationId: OrganizationId,
): void {
  if (facility.organizationId !== organizationId) {
    throw new Error('Facility does not belong to the given organization');
  }
}

/** A department must belong to the facility that claims it. */
export function assertDepartmentBelongsToFacility(
  department: DiagnosticDepartment,
  facilityId: FacilityId,
): void {
  if (department.facilityId !== facilityId) {
    throw new Error('Department does not belong to the given facility');
  }
}

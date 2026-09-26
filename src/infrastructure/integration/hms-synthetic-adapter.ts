/**
 * Reference integration adapter — `HMS-SYNTHETIC` (Step 17).
 *
 * This is a SYNTHETIC reference connector used to prove the gateway boundary.
 * It talks to nothing: it maps the field names of a plausible hospital-system
 * payload onto canonical SDIS commands and maps canonical responses onto
 * acknowledgements. There is NO live SWASTHYA/HMS connection, no production
 * endpoint, no credential, and no interoperability standard (FHIR/HL7/DICOM/
 * IHE/ATNA) is implemented or claimed.
 *
 * Adapters belong at the infrastructure edge (`docs/ARCHITECTURE.md`): they
 * normalize formats and hold no business rules, and they never touch a
 * repository or the database.
 */

import type {
  CanonicalCommand,
  IntegrationAdapter,
  IntegrationEnvelope,
  IntegrationOperation,
  IntegrationPayload,
} from '../../app/integration/integration-gateway';
import { ValidationError } from '../../app/errors';
import type { EncounterId, OrderItemId, PatientId, ReportId } from '../../types/ids';

export const HMS_SYNTHETIC_SYSTEM = 'HMS-SYNTHETIC';

/** External MRN system name used by the synthetic connector. */
export const HMS_SYNTHETIC_MRN_SYSTEM = 'HOSPITAL_MRN';

function requireString(payload: IntegrationPayload, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(
      `Field "${field}" is required and must be a non-empty string`,
    );
  }
  return value.trim();
}

function optionalString(payload: IntegrationPayload, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`Field "${field}" must be a string when provided`);
  }
  return value;
}

/** Facility-agnostic MRN reference — scope is always derived from the session. */
function mrnReference(value: string) {
  return { system: HMS_SYNTHETIC_MRN_SYSTEM, value };
}

export class HmsSyntheticAdapter implements IntegrationAdapter {
  readonly system = HMS_SYNTHETIC_SYSTEM;
  readonly label = 'synthetic HMS integration adapter';
  readonly sourceKind = 'INTEGRATION' as const;

  normalize(
    operation: IntegrationOperation,
    payload: IntegrationPayload,
  ): CanonicalCommand {
    switch (operation) {
      case 'RESOLVE_PATIENT':
        return {
          command: 'RESOLVE_PATIENT',
          reference: mrnReference(requireString(payload, 'mrn')),
        };
      case 'REGISTER_PATIENT': {
        const mrn = optionalString(payload, 'mrn');
        const birthDate = optionalString(payload, 'birthDate');
        const sex = requireString(payload, 'sex');
        return {
          command: 'REGISTER_PATIENT',
          fullName: requireString(payload, 'fullName'),
          sex,
          ...(birthDate ? { birthDate } : {}),
          externalReferences: mrn
            ? [{ system: HMS_SYNTHETIC_MRN_SYSTEM, value: mrn }]
            : [],
        };
      }
      case 'ATTACH_PATIENT_REFERENCE':
        return {
          command: 'ATTACH_PATIENT_REFERENCE',
          patientId: requireString(payload, 'patientId') as PatientId,
          reference: mrnReference(requireString(payload, 'mrn')),
        };
      case 'SUBMIT_ORDER': {
        const rawItems = payload['testCodes'];
        if (!Array.isArray(rawItems) || rawItems.length === 0) {
          throw new ValidationError('Field "testCodes" must be a non-empty array');
        }
        const items = rawItems.map((entry) => {
          if (!entry || typeof entry !== 'object') {
            throw new ValidationError('Each testCodes entry must be an object');
          }
          const record = entry as Record<string, unknown>;
          const code = record['code'];
          const system = record['system'];
          if (typeof code !== 'string' || typeof system !== 'string') {
            throw new ValidationError(
              'Each testCodes entry requires "code" and "system"',
            );
          }
          return { testCode: code, codeSystem: system };
        });
        const externalOrderRef = optionalString(payload, 'hmsOrderId');
        const priority = optionalString(payload, 'priority');
        return {
          command: 'SUBMIT_ORDER',
          patientId: requireString(payload, 'patientId') as PatientId,
          encounterId: requireString(payload, 'encounterId') as EncounterId,
          modality: requireString(payload, 'modality'),
          items,
          orderedAt: requireString(payload, 'orderedAt'),
          ...(priority ? { priority } : {}),
          ...(externalOrderRef ? { externalOrderRef } : {}),
        };
      }
      case 'ORDER_STATUS':
        return {
          command: 'ORDER_STATUS',
          orderId: requireString(payload, 'orderId'),
        };
      case 'CHANGE_ORDER_PRIORITY':
        return {
          command: 'CHANGE_ORDER_PRIORITY',
          orderId: requireString(payload, 'orderId'),
          priority: requireString(payload, 'priority'),
          at: requireString(payload, 'at'),
        };
      case 'FETCH_REPORT':
        return {
          command: 'FETCH_REPORT',
          reportId: requireString(payload, 'reportId') as ReportId,
        };
      case 'INBOUND_RESULT': {
        // A plausible external result payload mapped onto the canonical
        // INBOUND_RESULT command. Value is taken verbatim (the observation
        // service owns clinical value semantics); the caller's own result id
        // is ECHOED for correlation and never persisted as an SDIS identity.
        const value = payload['value'];
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new ValidationError('Field "value" must be a JSON object');
        }
        const valueRecord = value as Record<string, unknown>;
        if (typeof valueRecord['kind'] !== 'string') {
          throw new ValidationError('Field "value.kind" is required');
        }
        const unit = optionalString(payload, 'unit');
        const specimenId = optionalString(payload, 'specimenId');
        const externalResultRef = optionalString(payload, 'hmsResultId');
        if (externalResultRef !== undefined && externalResultRef.length > 160) {
          throw new ValidationError('Field "hmsResultId" must be at most 160 characters');
        }
        return {
          command: 'INBOUND_RESULT',
          orderItemId: requireString(payload, 'orderItemId') as OrderItemId,
          patientId: requireString(payload, 'patientId') as PatientId,
          ...(specimenId ? { specimenId } : {}),
          code: requireString(payload, 'code'),
          codeSystem: requireString(payload, 'codeSystem'),
          value: valueRecord as never,
          ...(unit ? { unit } : {}),
          at: requireString(payload, 'at'),
        };
      }
      case 'ORDER_EXISTS':
        return {
          command: 'ORDER_EXISTS',
          externalOrderRef: requireString(payload, 'hmsOrderId'),
        };
    }
  }

  acknowledge(params: {
    readonly operation: IntegrationOperation;
    readonly outcome: 'RESOLVED' | 'CREATED' | 'RETRIEVED';
    readonly command: CanonicalCommand;
    readonly resource: unknown;
    readonly correlationId?: string;
  }): ReturnType<IntegrationAdapter['acknowledge']> {
    const externalReference = externalReferenceOf(params.command);
    return {
      system: this.system,
      operation: params.operation,
      outcome: params.outcome,
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
      ...(externalReference ? { externalReference } : {}),
      resource: params.resource,
    };
  }
}

/** The caller's own identifier, echoed back (never a second SDIS identity). */
function externalReferenceOf(command: CanonicalCommand): string | undefined {
  if (command.command === 'SUBMIT_ORDER') return command.externalOrderRef;
  if (command.command === 'ORDER_EXISTS') return command.externalOrderRef;
  if (
    command.command === 'RESOLVE_PATIENT' ||
    command.command === 'ATTACH_PATIENT_REFERENCE'
  ) {
    return command.reference.value;
  }
  return undefined;
}

/**
 * Re-exported for connectors: the registry implementation itself lives in the
 * application layer (composition must be able to wire the gateway without
 * importing a concrete connector).
 */
export {
  StaticIntegrationRegistry,
  emptyIntegrationRegistry,
} from '../../app/integration/integration-gateway';

/** Unused import guard for payload typing used by callers. */
export type { IntegrationEnvelope };
export type { OrderItemId };

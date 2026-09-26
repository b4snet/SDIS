/**
 * SDIS modality vocabulary — shared platform types.
 *
 * Modality is layer-0 vocabulary (like identifiers and provenance): every domain
 * may reference it, but the CORE never branches on modality identity. Laboratory
 * (LAB) is the first modality; ECG, EEG, PFT, TMT, ECHO, ULTRASOUND and future
 * modalities share the same platform model.
 */

export type ModalityName =
  | 'LAB'
  | 'ECG'
  | 'EEG'
  | 'PFT'
  | 'TMT'
  | 'ECHO'
  | 'ULTRASOUND'
  | 'RADIOLOGY'
  | (string & {});

export type ModalityCapability =
  'ORDERING' | 'SPECIMEN' | 'ACQUISITION' | 'OBSERVATIONS' | 'INTERPRETATION' | 'REPORT';

export const KNOWN_MODALITIES: readonly ModalityName[] = [
  'LAB',
  'ECG',
  'EEG',
  'PFT',
  'TMT',
  'ECHO',
  'ULTRASOUND',
  'RADIOLOGY',
] as const;

export interface ModalityDescriptor {
  readonly name: ModalityName;
  readonly displayName: string;
  readonly capabilities: readonly ModalityCapability[];
}

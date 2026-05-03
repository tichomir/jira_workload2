export type DetectorId = 'email' | 'api_key' | 'credit_card' | 'phone';
export type RegulationTag = 'GDPR' | 'PCI_DSS';

export interface ScanContext {
  backupPointId: string;
  fileRef: string;
  filename: string;
  mimeType: string;
  chunkOrigin?: string;
}

export interface FindingLocation {
  lineNumber: number | null;
  columnOffset: number | null;
  columnName?: string;
  xmlPath?: string;
}

export interface Finding {
  detectorId: DetectorId;
  regulationTags: RegulationTag[];
  sampleEvidence: string;
  fileRef: string;
  location: FindingLocation;
}

export interface Detector {
  readonly id: DetectorId;
  detect(content: string | Buffer, context: ScanContext): Finding[];
}

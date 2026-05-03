/**
 * TextChunk — a discrete piece of text extracted from a file by a FileHandler.
 * Carries location metadata so detectors can report precise finding locations.
 */
export interface TextChunk {
  /** The text content to scan */
  text: string;
  /** Source line number (1-based), or null when not line-oriented */
  lineNumber: number | null;
  /** Column header name for tabular data */
  columnName?: string;
  /** XPath-style element path for XML data */
  xmlPath?: string;
  /** Brief label describing how this chunk was extracted (e.g. 'xml_element_text', 'yaml_value') */
  chunkOrigin?: string;
}

/**
 * FileHandler — extracts TextChunks from a file for SDI scanning.
 * Each handler covers one or more file extensions / MIME types.
 */
export interface FileHandler {
  readonly supportedExtensions: readonly string[];
  /**
   * Reads filePath and yields TextChunks covering all text content
   * (element values, attribute values, cell values, config values, lines, etc.).
   * MUST NOT throw — return [] on unrecoverable parse errors.
   */
  extract(filePath: string, mimeType: string): Promise<TextChunk[]>;
}

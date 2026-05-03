import * as fs from 'fs';
import { FileHandler, TextChunk } from './types';

/**
 * XmlEntitiesHandler — extracts text content and attribute values from XML files
 * (entities.xml and generic .xml).
 *
 * Uses regex-based extraction to avoid adding an XML parser dependency:
 *   - Element text content: text between > and < delimiters
 *   - Double-quoted attribute values: attr="value"
 *   - Single-quoted attribute values: attr='value'
 *
 * Each extracted value becomes one TextChunk carrying its source line number.
 */
export class XmlEntitiesHandler implements FileHandler {
  readonly supportedExtensions = ['.xml'] as const;

  async extract(filePath: string, _mimeType: string): Promise<TextChunk[]> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    return this.extractFromXml(content);
  }

  private extractFromXml(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];

    // Pre-compute cumulative line offsets for fast line-number lookup
    const lineOffsets = this.buildLineOffsets(content);

    // Element text content: >text<
    const elementTextRe = />([^<>]+)</g;
    let match: RegExpExecArray | null;
    while ((match = elementTextRe.exec(content)) !== null) {
      const text = match[1].trim();
      if (text) {
        chunks.push({
          text,
          lineNumber: this.offsetToLine(match.index, lineOffsets),
          chunkOrigin: 'xml_element_text',
        });
      }
    }

    // Double-quoted attribute values
    const attrDoubleRe = /\w[\w.-]*\s*=\s*"([^"]*)"/g;
    while ((match = attrDoubleRe.exec(content)) !== null) {
      const text = match[1].trim();
      if (text) {
        chunks.push({
          text,
          lineNumber: this.offsetToLine(match.index, lineOffsets),
          chunkOrigin: 'xml_attribute_value',
        });
      }
    }

    // Single-quoted attribute values
    const attrSingleRe = /\w[\w.-]*\s*=\s*'([^']*)'/g;
    while ((match = attrSingleRe.exec(content)) !== null) {
      const text = match[1].trim();
      if (text) {
        chunks.push({
          text,
          lineNumber: this.offsetToLine(match.index, lineOffsets),
          chunkOrigin: 'xml_attribute_value',
        });
      }
    }

    return chunks;
  }

  /** Returns an array where lineOffsets[i] = char offset of line i+1 start. */
  private buildLineOffsets(content: string): number[] {
    const offsets: number[] = [0];
    for (let i = 0; i < content.length; i++) {
      if (content[i] === '\n') offsets.push(i + 1);
    }
    return offsets;
  }

  /** Returns 1-based line number for a given character offset. */
  private offsetToLine(offset: number, lineOffsets: number[]): number {
    let lo = 0;
    let hi = lineOffsets.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineOffsets[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}

import * as fs from 'fs';
import { FileHandler, TextChunk } from './types';

/**
 * PlainTextHandler — line-based extraction for .txt, .log, .md files.
 * Each non-empty line becomes one TextChunk with its 1-based line number.
 */
export class PlainTextHandler implements FileHandler {
  readonly supportedExtensions = ['.txt', '.log', '.md'] as const;

  async extract(filePath: string, _mimeType: string): Promise<TextChunk[]> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }
    return content.split('\n').map((line, i) => ({
      text: line,
      lineNumber: i + 1,
      chunkOrigin: 'plain_text',
    }));
  }
}

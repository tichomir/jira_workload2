import * as fs from 'fs';
import * as path from 'path';
import { FileHandler, TextChunk } from './types';

/**
 * TabularHandler — extracts cell values from .csv, .tsv, and .xlsx files.
 *
 * CSV/TSV: streamed line-by-line with RFC 4180 quote handling.
 * XLSX: uses exceljs streaming reader (added to deps: streamed XLSX read for SDI tabular scan).
 *
 * The first row is treated as headers; subsequent rows produce TextChunks
 * with columnName set to the corresponding header.
 */
export class TabularHandler implements FileHandler {
  readonly supportedExtensions = ['.csv', '.tsv', '.xlsx'] as const;

  async extract(filePath: string, _mimeType: string): Promise<TextChunk[]> {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xlsx') {
      return this.extractXlsx(filePath);
    }
    const delimiter = ext === '.tsv' ? '\t' : ',';
    return this.extractDelimited(filePath, delimiter);
  }

  // ── CSV / TSV ──────────────────────────────────────────────────────────────

  private extractDelimited(filePath: string, delimiter: string): TextChunk[] {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const lines = content.split('\n');
    const chunks: TextChunk[] = [];
    let headers: string[] = [];

    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const cols = this.parseLine(line, delimiter);
      if (i === 0) {
        headers = cols.map((c) => c.trim());
        return;
      }
      cols.forEach((cell, j) => {
        const text = cell.trim();
        if (text) {
          chunks.push({
            text,
            lineNumber: i + 1,
            columnName: headers[j] ?? String(j + 1),
            chunkOrigin: 'tabular_cell',
          });
        }
      });
    });

    return chunks;
  }

  /** RFC 4180-compliant CSV field parser. */
  private parseLine(line: string, delimiter: string): string[] {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current);
    return result;
  }

  // ── XLSX ───────────────────────────────────────────────────────────────────

  private async extractXlsx(filePath: string): Promise<TextChunk[]> {
    // exceljs added to deps: streamed XLSX read for SDI tabular scan
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ExcelJS = require('exceljs') as typeof import('exceljs');
    const chunks: TextChunk[] = [];

    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(filePath, {});

    for await (const worksheetReader of workbookReader as AsyncIterable<
      import('exceljs').stream.xlsx.WorksheetReader
    >) {
      let headers: string[] = [];
      let isFirstRow = true;

      for await (const row of worksheetReader) {
        // row.values[0] is undefined (ExcelJS uses 1-based indexing)
        const values = (row.values as (string | number | boolean | null | undefined)[]);
        const cells = values.slice(1);

        if (isFirstRow) {
          headers = cells.map((c) => (c != null ? String(c) : ''));
          isFirstRow = false;
          continue;
        }

        const rowNumber = typeof row.number === 'number' ? row.number : null;
        cells.forEach((cell, j) => {
          if (cell != null && cell !== '') {
            const text = String(cell).trim();
            if (text) {
              chunks.push({
                text,
                lineNumber: rowNumber,
                columnName: headers[j] ?? String(j + 1),
                chunkOrigin: 'xlsx_cell',
              });
            }
          }
        });
      }
    }

    return chunks;
  }
}

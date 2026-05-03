import * as fs from 'fs';
import * as path from 'path';
import { FileHandler, TextChunk } from './types';

/**
 * ConfigHandler — parses developer configuration files to flat key-value pairs
 * and yields each value as a TextChunk.
 *
 * Supported extensions: .env, .yaml, .yml, .json, .toml, .properties, .config
 *
 * Strategy per format:
 *   .json         → JSON.parse → flatten all leaf string/number/boolean values
 *   .yaml / .yml  → regex extraction of "key: value" and list items (no extra dep)
 *   .toml         → regex extraction of "key = value" pairs
 *   .env / .properties / .config → line-by-line "key=value" or "key: value"
 */
export class ConfigHandler implements FileHandler {
  readonly supportedExtensions = [
    '.env',
    '.yaml',
    '.yml',
    '.json',
    '.toml',
    '.properties',
    '.config',
  ] as const;

  async extract(filePath: string, _mimeType: string): Promise<TextChunk[]> {
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return [];
    }

    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
      case '.json':
        return this.extractJson(content);
      case '.yaml':
      case '.yml':
        return this.extractYaml(content);
      case '.toml':
        return this.extractToml(content);
      default:
        // .env, .properties, .config
        return this.extractKeyValue(content);
    }
  }

  // ── JSON ───────────────────────────────────────────────────────────────────

  private extractJson(content: string): TextChunk[] {
    try {
      const obj: unknown = JSON.parse(content);
      const chunks: TextChunk[] = [];
      this.flattenJsonValue(obj, '', chunks);
      return chunks;
    } catch {
      return this.extractLines(content);
    }
  }

  private flattenJsonValue(value: unknown, keyPath: string, chunks: TextChunk[]): void {
    if (typeof value === 'string') {
      if (value) {
        chunks.push({ text: value, lineNumber: null, chunkOrigin: keyPath || 'json_value' });
      }
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      chunks.push({ text: String(value), lineNumber: null, chunkOrigin: keyPath || 'json_value' });
    } else if (Array.isArray(value)) {
      value.forEach((item, i) =>
        this.flattenJsonValue(item, `${keyPath}[${i}]`, chunks),
      );
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        this.flattenJsonValue(v, keyPath ? `${keyPath}.${k}` : k, chunks);
      }
    }
  }

  // ── YAML ───────────────────────────────────────────────────────────────────

  private extractYaml(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const lineNum = i + 1;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;

      // key: value  (simple scalar or quoted)
      const kvMatch = /^[^:]+:\s+(.+)$/.exec(trimmed);
      if (kvMatch) {
        const raw = kvMatch[1].trim();
        // Strip surrounding quotes if present
        const value = raw.replace(/^(['"])(.*)\1$/, '$2');
        if (value) {
          chunks.push({ text: value, lineNumber: lineNum, chunkOrigin: 'yaml_value' });
        }
        return;
      }

      // List item: - value
      const listMatch = /^-\s+(.+)$/.exec(trimmed);
      if (listMatch) {
        const raw = listMatch[1].trim();
        const value = raw.replace(/^(['"])(.*)\1$/, '$2');
        if (value) {
          chunks.push({ text: value, lineNumber: lineNum, chunkOrigin: 'yaml_list_item' });
        }
      }
    });
    return chunks;
  }

  // ── TOML ───────────────────────────────────────────────────────────────────

  private extractToml(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) return;

      // key = "value" or key = 'value' or key = value
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 0) return;
      const rawVal = trimmed.slice(eqIdx + 1).trim();
      const value = rawVal.replace(/^(['"])(.*)\1$/, '$2');
      if (value && value !== 'true' && value !== 'false') {
        chunks.push({ text: value, lineNumber: i + 1, chunkOrigin: 'toml_value' });
      }
    });
    return chunks;
  }

  // ── .env / .properties / .config ──────────────────────────────────────────

  private extractKeyValue(content: string): TextChunk[] {
    const chunks: TextChunk[] = [];
    const lines = content.split('\n');
    lines.forEach((line, i) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return;

      const eqIdx = trimmed.indexOf('=');
      const colonIdx = trimmed.indexOf(':');
      let sepIdx: number;
      if (eqIdx >= 0 && (colonIdx < 0 || eqIdx < colonIdx)) {
        sepIdx = eqIdx;
      } else if (colonIdx >= 0) {
        sepIdx = colonIdx;
      } else {
        return;
      }

      const rawVal = trimmed.slice(sepIdx + 1).trim();
      const value = rawVal.replace(/^(['"])(.*)\1$/, '$2');
      if (value) {
        chunks.push({ text: value, lineNumber: i + 1, chunkOrigin: 'config_value' });
      }
    });
    return chunks;
  }

  // ── fallback ───────────────────────────────────────────────────────────────

  private extractLines(content: string): TextChunk[] {
    return content.split('\n').map((line, i) => ({
      text: line,
      lineNumber: i + 1,
      chunkOrigin: 'config_line',
    }));
  }
}

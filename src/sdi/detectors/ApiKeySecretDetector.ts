import { Detector, DetectorId, Finding, ScanContext } from './types';

/**
 * Matches known vendor key prefixes and generic high-entropy tokens.
 *
 * Vendor prefixes (T7 §3):
 *   AKIA...        — AWS Access Key ID (20 uppercase alphanumeric)
 *   ghp_...        — GitHub personal access token
 *   xoxb-...       — Slack bot token
 *   sk_live_...    — Stripe live secret key
 *   sk-...         — OpenAI / generic sk- pattern (32+ chars)
 *
 * Generic high-entropy: 32+ char hex or base64-alphabet string appearing
 * adjacent to a key/secret/token context word on the same line.
 */

interface PatternEntry {
  re: RegExp;
  /** How many chars of the match to show before masking */
  showPrefixLen: number;
}

const VENDOR_PATTERNS: PatternEntry[] = [
  // AWS AKIA key: AKIA followed by 16 uppercase alphanumeric chars
  { re: /\bAKIA[A-Z0-9]{16}\b/g, showPrefixLen: 4 },
  // GitHub PAT
  { re: /\bghp_[A-Za-z0-9]{36}\b/g, showPrefixLen: 4 },
  // Slack bot token
  { re: /\bxoxb-[A-Za-z0-9\-]{20,}\b/g, showPrefixLen: 5 },
  // Stripe live secret key
  { re: /\bsk_live_[A-Za-z0-9]{24,}\b/g, showPrefixLen: 8 },
  // Generic sk- pattern (OpenAI and others) — require at least 32 chars total
  { re: /\bsk-[A-Za-z0-9]{29,}\b/g, showPrefixLen: 4 },
];

// Generic: 32+ chars of hex or base64 alphabet — only when paired with a
// key/secret/token context keyword on the same line (case-insensitive)
const GENERIC_ENTROPY_RE = /\b([A-Za-z0-9+/]{32,}={0,2})\b/g;
const CONTEXT_KEYWORD_RE = /\b(key|secret|token|password|passwd|api[_\-]?key|auth)\b/i;

// UUID pattern to exclude (not a secret)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function redact(match: string, showPrefixLen: number): string {
  const prefix = match.slice(0, showPrefixLen);
  return `${prefix}****`;
}

export class ApiKeySecretDetector implements Detector {
  readonly id: DetectorId = 'api_key';

  detect(content: string | Buffer, context: ScanContext): Finding[] {
    if (Buffer.isBuffer(content)) return [];

    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const seen = new Set<string>();

      // Vendor-specific patterns
      for (const { re, showPrefixLen } of VENDOR_PATTERNS) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(line)) !== null) {
          const raw = match[0];
          if (seen.has(raw)) continue;
          seen.add(raw);
          findings.push({
            detectorId: this.id,
            regulationTags: [],
            sampleEvidence: redact(raw, showPrefixLen),
            fileRef: context.fileRef,
            location: { lineNumber: lineIdx + 1, columnOffset: match.index },
          });
        }
      }

      // Generic high-entropy — only if a context keyword appears on the same line
      if (CONTEXT_KEYWORD_RE.test(line)) {
        GENERIC_ENTROPY_RE.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = GENERIC_ENTROPY_RE.exec(line)) !== null) {
          const raw = match[0];
          if (seen.has(raw)) continue;
          if (isUuid(raw)) continue;
          // Skip if it looks like plain English words (no digits at all for short tokens)
          if (raw.length < 32) continue;
          seen.add(raw);
          findings.push({
            detectorId: this.id,
            regulationTags: [],
            sampleEvidence: redact(raw, 4),
            fileRef: context.fileRef,
            location: { lineNumber: lineIdx + 1, columnOffset: match.index },
          });
        }
      }
    }

    return findings;
  }
}

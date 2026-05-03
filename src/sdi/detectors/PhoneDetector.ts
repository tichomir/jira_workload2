import { Detector, DetectorId, Finding, RegulationTag, ScanContext } from './types';

/**
 * Detects phone numbers in E.164 and common national formats.
 *
 * Patterns covered:
 *   E.164:      +[1-9]\d{6,14}   (7–15 digits total per ITU-T E.164)
 *   US/CA:      (NXX) NXX-XXXX, NXX-NXX-XXXX, NXX.NXX.XXXX
 *   UK:         +44 XXXX XXXXXX, 0XXXX XXXXXX
 *   EU generic: +[2-9]\d{7,13}
 *
 * A candidate must contain 7–15 digits (after stripping formatting).
 * Redaction: show last 4 digits only → ****XXXX
 */

// Broad patterns; digit-count validation applied after extraction
const PHONE_PATTERNS: RegExp[] = [
  // E.164: +CC followed by subscriber number
  /\+[1-9]\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{1,4}[\s\-.]?\d{1,9}/g,
  // North American: (NXX) NXX-XXXX or NXX-NXX-XXXX or NXX.NXX.XXXX
  /(?:\(\d{3}\)[\s\-.]|\b\d{3}[\-.])\d{3}[\-. ]\d{4}\b/g,
  // UK: 01xxx xxxxxx, 07xxx xxxxxx, 020 xxxx xxxx
  /\b0\d{3,4}[\s\-]\d{3,4}[\s\-]?\d{3,4}\b/g,
];

function extractDigits(s: string): string {
  return s.replace(/[^\d]/g, '');
}

function redact(digits: string): string {
  return `****${digits.slice(-4)}`;
}

export class PhoneDetector implements Detector {
  readonly id: DetectorId = 'phone';

  detect(content: string | Buffer, context: ScanContext): Finding[] {
    if (Buffer.isBuffer(content)) return [];

    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      const seenMatches = new Set<string>();

      for (const pattern of PHONE_PATTERNS) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = pattern.exec(line)) !== null) {
          const raw = match[0];
          if (seenMatches.has(raw)) continue;

          const digits = extractDigits(raw);
          if (digits.length < 7 || digits.length > 15) continue;

          seenMatches.add(raw);
          findings.push({
            detectorId: this.id,
            regulationTags: ['GDPR'] as RegulationTag[],
            sampleEvidence: redact(digits),
            fileRef: context.fileRef,
            location: { lineNumber: lineIdx + 1, columnOffset: match.index },
          });
        }
      }
    }

    return findings;
  }
}

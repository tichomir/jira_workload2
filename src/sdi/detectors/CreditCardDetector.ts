import { Detector, DetectorId, Finding, RegulationTag, ScanContext } from './types';

/**
 * Detects credit card Primary Account Numbers (PANs).
 *
 * Approach:
 *   1. Extract 13–19 digit candidates (spaces and dashes between groups allowed).
 *   2. Strip formatting; verify digit count is 13–19.
 *   3. Reject all-same-digit sequences (e.g. 1111111111111111).
 *   4. Validate via Luhn algorithm.
 *   5. Redact to last-4 only: ****XXXX
 */

// Matches digit groups separated by optional spaces or dashes
// Total digits must be 13–19 after stripping separators
const PAN_CANDIDATE_RE = /\b(\d[\d \-]{11,21}\d)\b/g;

function luhn(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function isAllSameDigit(digits: string): boolean {
  return /^(.)\1+$/.test(digits);
}

function redact(digits: string): string {
  return `****${digits.slice(-4)}`;
}

export class CreditCardDetector implements Detector {
  readonly id: DetectorId = 'credit_card';

  detect(content: string | Buffer, context: ScanContext): Finding[] {
    if (Buffer.isBuffer(content)) return [];

    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      PAN_CANDIDATE_RE.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = PAN_CANDIDATE_RE.exec(line)) !== null) {
        const raw = match[0];
        const digits = raw.replace(/[ \-]/g, '');

        if (digits.length < 13 || digits.length > 19) continue;
        if (isAllSameDigit(digits)) continue;
        if (!luhn(digits)) continue;

        findings.push({
          detectorId: this.id,
          regulationTags: ['PCI_DSS'] as RegulationTag[],
          sampleEvidence: redact(digits),
          fileRef: context.fileRef,
          location: { lineNumber: lineIdx + 1, columnOffset: match.index },
        });
      }
    }

    return findings;
  }
}

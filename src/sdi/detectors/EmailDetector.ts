import { Detector, DetectorId, Finding, RegulationTag, ScanContext } from './types';

// RFC-5322-pragmatic: local-part@domain.tld
// Allows most printable chars in local-part, standard domain with at least one dot
const EMAIL_RE = /\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g;

function redact(match: string): string {
  const atIdx = match.indexOf('@');
  if (atIdx === -1) return '****';
  const domain = match.slice(atIdx); // includes '@'
  return `****${domain}`;
}

export class EmailDetector implements Detector {
  readonly id: DetectorId = 'email';

  detect(content: string | Buffer, context: ScanContext): Finding[] {
    if (Buffer.isBuffer(content)) return [];

    const findings: Finding[] = [];
    const lines = content.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const line = lines[lineIdx];
      let match: RegExpExecArray | null;
      EMAIL_RE.lastIndex = 0;

      while ((match = EMAIL_RE.exec(line)) !== null) {
        findings.push({
          detectorId: this.id,
          regulationTags: ['GDPR'] as RegulationTag[],
          sampleEvidence: redact(match[0]),
          fileRef: context.fileRef,
          location: {
            lineNumber: lineIdx + 1,
            columnOffset: match.index,
          },
        });
      }
    }

    return findings;
  }
}

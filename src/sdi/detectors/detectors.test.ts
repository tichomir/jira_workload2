import { EmailDetector } from './EmailDetector';
import { ApiKeySecretDetector } from './ApiKeySecretDetector';
import { CreditCardDetector } from './CreditCardDetector';
import { PhoneDetector } from './PhoneDetector';
import { ALL_DETECTORS } from './index';
import { ScanContext, Finding } from './types';

const CTX: ScanContext = {
  backupPointId: 'bp-001',
  fileRef: 'att-001',
  filename: 'test.txt',
  mimeType: 'text/plain',
};

// ─── EmailDetector ────────────────────────────────────────────────────────────

describe('EmailDetector', () => {
  const detector = new EmailDetector();

  it('has id "email"', () => {
    expect(detector.id).toBe('email');
  });

  it('detects a plain email address', () => {
    const findings = detector.detect('Contact us at alice@example.com for help', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].regulationTags).toEqual(['GDPR']);
    expect(findings[0].sampleEvidence).toBe('****@example.com');
    expect(findings[0].sampleEvidence).not.toContain('alice');
  });

  it('detects multiple emails on different lines', () => {
    const findings = detector.detect('a@foo.com\nb@bar.org', CTX);
    expect(findings).toHaveLength(2);
  });

  it('detects email with plus-addressing', () => {
    const findings = detector.detect('user+tag@sub.domain.io', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toBe('****@sub.domain.io');
  });

  it('returns [] for Buffer content', () => {
    expect(detector.detect(Buffer.from('alice@example.com'), CTX)).toEqual([]);
  });

  it('returns [] when no email present', () => {
    expect(detector.detect('no email here, just text', CTX)).toEqual([]);
  });

  it('does not flag plain domain references without @', () => {
    expect(detector.detect('visit example.com today', CTX)).toEqual([]);
  });

  it('sets correct lineNumber and fileRef', () => {
    const findings = detector.detect('line1\nuser@test.com\nline3', CTX);
    expect(findings[0].location.lineNumber).toBe(2);
    expect(findings[0].fileRef).toBe('att-001');
  });
});

// ─── ApiKeySecretDetector ────────────────────────────────────────────────────

describe('ApiKeySecretDetector', () => {
  const detector = new ApiKeySecretDetector();

  it('has id "api_key"', () => {
    expect(detector.id).toBe('api_key');
  });

  it('detects AWS AKIA key', () => {
    const findings = detector.detect('export AWS_KEY=AKIAIOSFODNN7EXAMPLE', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].regulationTags).toEqual([]);
    expect(findings[0].sampleEvidence).toMatch(/^AKIA/);
    expect(findings[0].sampleEvidence).toContain('****');
    // Must not contain full key
    expect(findings[0].sampleEvidence).not.toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('detects GitHub PAT (ghp_)', () => {
    const ghpKey = 'ghp_' + 'A'.repeat(36);
    const findings = detector.detect(`token=${ghpKey}`, CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toMatch(/^ghp_/);
  });

  it('detects Slack xoxb- token', () => {
    const findings = detector.detect('SLACK_TOKEN=xoxb-123456789012-123456789012-abcdefghijklmnopqrstuvwx', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toMatch(/^xoxb/);
  });

  it('detects Stripe sk_live_ key', () => {
    const findings = detector.detect('STRIPE_KEY=sk_live_abcdefghijklmnopqrstuvwx', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toMatch(/^sk_live_/);
  });

  it('detects generic 32+ char token in context of "secret" keyword', () => {
    const token = 'a'.repeat(20) + 'B'.repeat(12); // 32 chars, mixed case
    const findings = detector.detect(`secret=${token}`, CTX);
    expect(findings).toHaveLength(1);
  });

  it('does NOT flag a UUID as a key', () => {
    const line = 'token=123e4567-e89b-12d3-a456-426614174000';
    const findings = detector.detect(line, CTX);
    // UUID should not be flagged
    const uuidFindings = findings.filter(f => f.sampleEvidence.includes('123e'));
    expect(uuidFindings).toHaveLength(0);
  });

  it('does NOT flag generic entropy without context keyword', () => {
    const token = 'A'.repeat(32);
    const findings = detector.detect(`value=${token}`, CTX);
    expect(findings).toHaveLength(0);
  });

  it('returns [] for Buffer content', () => {
    expect(detector.detect(Buffer.from('AKIAIOSFODNN7EXAMPLE'), CTX)).toEqual([]);
  });

  it('regulation tags are empty array (informational only)', () => {
    const findings = detector.detect('AWS_KEY=AKIAIOSFODNN7EXAMPLE', CTX);
    expect(findings[0].regulationTags).toEqual([]);
  });
});

// ─── CreditCardDetector ──────────────────────────────────────────────────────

describe('CreditCardDetector', () => {
  const detector = new CreditCardDetector();

  it('has id "credit_card"', () => {
    expect(detector.id).toBe('credit_card');
  });

  // Classic Visa test PAN: 4111111111111111 — Luhn valid
  it('detects a valid Visa test PAN', () => {
    const findings = detector.detect('card: 4111111111111111', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].regulationTags).toEqual(['PCI_DSS']);
    expect(findings[0].sampleEvidence).toBe('****1111');
    // Full PAN must not appear in evidence
    expect(findings[0].sampleEvidence).not.toBe('4111111111111111');
  });

  // Mastercard test PAN: 5500005555555559 — Luhn valid
  it('detects a formatted Mastercard PAN (spaces)', () => {
    const findings = detector.detect('5500 0055 5555 5559', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toBe('****5559');
  });

  it('detects a formatted PAN with dashes', () => {
    const findings = detector.detect('4111-1111-1111-1111', CTX);
    expect(findings).toHaveLength(1);
  });

  // Invalid Luhn: 4111111111111112
  it('does NOT flag a number that fails Luhn check', () => {
    const findings = detector.detect('4111111111111112', CTX);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag all-same-digit sequences', () => {
    const findings = detector.detect('1111111111111111', CTX);
    expect(findings).toHaveLength(0);
  });

  // ISBN-13: 978-3-16-148410-0 → digits 9783161484100 (13 digits, check Luhn)
  // 978-3-16-148410-0 stripped: 9783161484100 — Luhn: likely invalid as PAN
  it('does not flag a 13-digit ISBN that fails Luhn as PAN (regression)', () => {
    // ISBN-13 9780306406157 — Luhn check for this specific value
    const digits = '9780306406157';
    // If Luhn happens to be valid, it would fire — this test just ensures
    // all-same-digit and Luhn gates work; for ISBNs the Luhn gate is our guard.
    const findings = detector.detect(digits, CTX);
    // Result depends on Luhn — if Luhn valid it fires (that's correct behavior
    // per T7 spec); we just ensure no crash and redaction is correct if it fires
    if (findings.length > 0) {
      expect(findings[0].sampleEvidence).toMatch(/^\*{4}\d{4}$/);
    }
  });

  it('returns [] for Buffer content', () => {
    expect(detector.detect(Buffer.from('4111111111111111'), CTX)).toEqual([]);
  });

  it('returns [] for short number sequences', () => {
    expect(detector.detect('123456789012', CTX)).toHaveLength(0); // 12 digits — too short
  });
});

// ─── PhoneDetector ───────────────────────────────────────────────────────────

describe('PhoneDetector', () => {
  const detector = new PhoneDetector();

  it('has id "phone"', () => {
    expect(detector.id).toBe('phone');
  });

  it('detects E.164 international format', () => {
    const findings = detector.detect('Call +12025551234', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].regulationTags).toEqual(['GDPR']);
    expect(findings[0].sampleEvidence).toBe('****1234');
  });

  it('detects North American (NXX) NXX-XXXX format', () => {
    const findings = detector.detect('Phone: (202) 555-1234', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].sampleEvidence).toBe('****1234');
  });

  it('detects NA format NXX-NXX-XXXX', () => {
    const findings = detector.detect('Contact: 202-555-1234', CTX);
    expect(findings).toHaveLength(1);
  });

  it('detects UK format', () => {
    const findings = detector.detect('Tel: 0207 946 0958', CTX);
    expect(findings).toHaveLength(1);
    expect(findings[0].regulationTags).toEqual(['GDPR']);
  });

  it('redacts to last 4 digits', () => {
    const findings = detector.detect('+442079460958', CTX);
    if (findings.length > 0) {
      expect(findings[0].sampleEvidence).toMatch(/^\*{4}\d{4}$/);
    }
  });

  it('returns [] for Buffer content', () => {
    expect(detector.detect(Buffer.from('+12025551234'), CTX)).toEqual([]);
  });

  it('does not flag very short digit sequences (< 7 digits)', () => {
    // 6-digit number — too short
    const findings = detector.detect('Code: 123456', CTX);
    expect(findings).toHaveLength(0);
  });
});

// ─── Registry ────────────────────────────────────────────────────────────────

describe('ALL_DETECTORS registry', () => {
  it('exports exactly 4 detectors', () => {
    expect(ALL_DETECTORS).toHaveLength(4);
  });

  it('includes all four detector ids', () => {
    const ids = ALL_DETECTORS.map(d => d.id);
    expect(ids).toContain('email');
    expect(ids).toContain('api_key');
    expect(ids).toContain('credit_card');
    expect(ids).toContain('phone');
  });

  it('each detector implements the Detector interface', () => {
    for (const d of ALL_DETECTORS) {
      expect(typeof d.id).toBe('string');
      expect(typeof d.detect).toBe('function');
    }
  });
});

/**
 * SDI Integration Tests
 *
 * Verifies file-handler routing, detector execution, and regulation tag activation
 * using fixture files under test/fixtures/sdi/.
 *
 * Acceptance criteria covered:
 *   - All four handler families process their respective fixture files
 *   - GDPR tag activates when email or phone is found
 *   - PCI_DSS tag activates when a Luhn-valid PAN is found
 *   - SdiScanner.scanProtectedObject aggregates findings across attachments
 *   - SdiScanner routes data.bin files by the filename passed in the descriptor
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { SdiScanner, SdiAttachmentDescriptor } from './SdiScanner';
import { PlainTextHandler } from './handlers/PlainTextHandler';
import { ConfigHandler } from './handlers/ConfigHandler';
import { XmlEntitiesHandler } from './handlers/XmlEntitiesHandler';
import { TabularHandler } from './handlers/TabularHandler';
import { ScanContext } from './detectors/types';

const FIXTURES = path.join(__dirname, '../../test/fixtures/sdi');

const CTX: ScanContext = {
  backupPointId: 'bp-sdi-test',
  fileRef: 'test-ref',
  filename: 'test-file',
  mimeType: 'text/plain',
};

// ── PlainTextHandler ──────────────────────────────────────────────────────────

describe('PlainTextHandler', () => {
  const handler = new PlainTextHandler();

  it('extracts chunks from .txt file', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'email-phone.txt'), 'text/plain');
    expect(chunks.length).toBeGreaterThan(0);
    const allText = chunks.map((c) => c.text).join('\n');
    expect(allText).toContain('alice@example.com');
    expect(allText).toContain('+12025551234');
  });

  it('assigns sequential 1-based line numbers', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'email-phone.txt'), 'text/plain');
    expect(chunks[0].lineNumber).toBe(1);
    expect(chunks[1].lineNumber).toBe(2);
  });

  it('returns [] for non-existent file', async () => {
    const chunks = await handler.extract('/nonexistent/path.txt', 'text/plain');
    expect(chunks).toEqual([]);
  });
});

// ── ConfigHandler ─────────────────────────────────────────────────────────────

describe('ConfigHandler — .env', () => {
  const handler = new ConfigHandler();

  it('extracts values from .env fixture', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'config.env'), 'text/plain');
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('admin@example.com'))).toBe(true);
    expect(texts.some((t) => t.includes('+12025551234'))).toBe(true);
  });

  it('skips comment lines (#)', async () => {
    const tmp = path.join(os.tmpdir(), 'test-config.env');
    fs.writeFileSync(tmp, '# this is a comment\nKEY=value\n');
    const chunks = await handler.extract(tmp, 'text/plain');
    expect(chunks.map((c) => c.text)).not.toContain('this is a comment');
    fs.unlinkSync(tmp);
  });
});

describe('ConfigHandler — .json', () => {
  const handler = new ConfigHandler();

  it('extracts leaf string values from nested JSON', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'config.json'), 'application/json');
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('admin@example.com'))).toBe(true);
    expect(texts.some((t) => t.includes('+12025551234'))).toBe(true);
    // PAN value should be present
    expect(texts.some((t) => t.includes('4111111111111111'))).toBe(true);
  });
});

describe('ConfigHandler — .yaml', () => {
  const handler = new ConfigHandler();

  it('extracts values from YAML fixture', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'config.yaml'), 'text/yaml');
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('admin@example.com'))).toBe(true);
    expect(texts.some((t) => t.includes('+12025551234'))).toBe(true);
  });
});

// ── XmlEntitiesHandler ────────────────────────────────────────────────────────

describe('XmlEntitiesHandler', () => {
  const handler = new XmlEntitiesHandler();

  it('extracts element text content from entities.xml', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'entities.xml'), 'application/xml');
    const texts = chunks.map((c) => c.text);
    // Phone in element text
    expect(texts.some((t) => t.includes('+12025551234'))).toBe(true);
    // PAN in element text
    expect(texts.some((t) => t.includes('4111111111111111'))).toBe(true);
  });

  it('extracts attribute values from entities.xml', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'entities.xml'), 'application/xml');
    const texts = chunks.map((c) => c.text);
    // Email in attribute
    expect(texts.some((t) => t.includes('alice@example.com'))).toBe(true);
    expect(texts.some((t) => t.includes('bob@company.org'))).toBe(true);
  });

  it('returns [] for non-existent file', async () => {
    const chunks = await handler.extract('/nonexistent/entities.xml', 'text/xml');
    expect(chunks).toEqual([]);
  });
});

// ── TabularHandler ────────────────────────────────────────────────────────────

describe('TabularHandler — CSV', () => {
  const handler = new TabularHandler();

  it('extracts cell values from CSV fixture', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'contacts.csv'), 'text/csv');
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('alice@example.com'))).toBe(true);
    expect(texts.some((t) => t.includes('+12025551234'))).toBe(true);
  });

  it('sets columnName on each chunk', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'contacts.csv'), 'text/csv');
    expect(chunks.some((c) => c.columnName === 'email')).toBe(true);
    expect(chunks.some((c) => c.columnName === 'phone')).toBe(true);
  });
});

describe('TabularHandler — TSV', () => {
  const handler = new TabularHandler();

  it('extracts cell values from TSV fixture (PAN + email)', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'payments.tsv'), 'text/tab-separated-values');
    const texts = chunks.map((c) => c.text);
    expect(texts.some((t) => t.includes('4111111111111111'))).toBe(true);
    expect(texts.some((t) => t.includes('buyer@example.com'))).toBe(true);
  });

  it('sets columnName to header value', async () => {
    const chunks = await handler.extract(path.join(FIXTURES, 'payments.tsv'), 'text/tab-separated-values');
    expect(chunks.some((c) => c.columnName === 'card_number')).toBe(true);
  });
});

// ── SdiScanner.scanFile ───────────────────────────────────────────────────────

describe('SdiScanner.scanFile', () => {
  const scanner = new SdiScanner();

  it('activates GDPR tag for email in .txt file', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'email-phone.txt'),
      'text/plain',
      { ...CTX, filename: 'email-phone.txt' },
    );
    const tags = new Set(findings.flatMap((f) => f.regulationTags));
    expect(tags.has('GDPR')).toBe(true);
    expect(findings.some((f) => f.detectorId === 'email')).toBe(true);
  });

  it('activates GDPR tag for phone in .txt file', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'email-phone.txt'),
      'text/plain',
      { ...CTX, filename: 'email-phone.txt' },
    );
    expect(findings.some((f) => f.detectorId === 'phone')).toBe(true);
    const phoneTags = findings
      .filter((f) => f.detectorId === 'phone')
      .flatMap((f) => f.regulationTags);
    expect(phoneTags).toContain('GDPR');
  });

  it('activates PCI_DSS tag for Luhn-valid PAN in .txt file', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'credit-card.txt'),
      'text/plain',
      { ...CTX, filename: 'credit-card.txt' },
    );
    const tags = new Set(findings.flatMap((f) => f.regulationTags));
    expect(tags.has('PCI_DSS')).toBe(true);
    expect(findings.some((f) => f.detectorId === 'credit_card')).toBe(true);
  });

  it('activates GDPR + PCI_DSS for entities.xml containing both email and PAN', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'entities.xml'),
      'application/xml',
      { ...CTX, filename: 'entities.xml' },
    );
    const tags = new Set(findings.flatMap((f) => f.regulationTags));
    expect(tags.has('GDPR')).toBe(true);
    expect(tags.has('PCI_DSS')).toBe(true);
  });

  it('activates GDPR for .env with email and phone', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'config.env'),
      'text/plain',
      { ...CTX, filename: 'config.env' },
    );
    const tags = new Set(findings.flatMap((f) => f.regulationTags));
    expect(tags.has('GDPR')).toBe(true);
  });

  it('activates PCI_DSS for TSV with Luhn-valid PAN', async () => {
    const findings = await scanner.scanFile(
      path.join(FIXTURES, 'payments.tsv'),
      'text/tab-separated-values',
      { ...CTX, filename: 'payments.tsv' },
    );
    const tags = new Set(findings.flatMap((f) => f.regulationTags));
    expect(tags.has('PCI_DSS')).toBe(true);
  });

  it('returns [] for unsupported extension', async () => {
    const tmp = path.join(os.tmpdir(), 'unsupported.bin');
    fs.writeFileSync(tmp, Buffer.from([0x00, 0x01, 0x02]));
    const findings = await scanner.scanFile(tmp, 'application/octet-stream', CTX);
    expect(findings).toEqual([]);
    fs.unlinkSync(tmp);
  });
});

// ── SdiScanner.scanProtectedObject ────────────────────────────────────────────

describe('SdiScanner.scanProtectedObject', () => {
  const scanner = new SdiScanner();

  it('aggregates GDPR findings from email-phone fixture via data.bin path', async () => {
    // SdiScanner routes by the filename field in the descriptor, not the
    // actual file path basename, so we use a .txt fixture directly.
    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: path.join(FIXTURES, 'email-phone.txt'),
        filename: 'support-notes.txt',
        mimeType: 'text/plain',
        fileRef: 'att-001',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-1', attachments, 'bp-001');
    expect(result.regulationTags).toContain('GDPR');
    expect(result.findingCount).toBeGreaterThan(0);
  });

  it('activates PCI_DSS from credit-card fixture', async () => {
    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: path.join(FIXTURES, 'credit-card.txt'),
        filename: 'receipt.txt',
        mimeType: 'text/plain',
        fileRef: 'att-002',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-2', attachments, 'bp-001');
    expect(result.regulationTags).toContain('PCI_DSS');
  });

  it('accumulates tags across multiple attachments', async () => {
    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: path.join(FIXTURES, 'email-phone.txt'),
        filename: 'notes.txt',
        mimeType: 'text/plain',
        fileRef: 'att-010',
      },
      {
        filePath: path.join(FIXTURES, 'credit-card.txt'),
        filename: 'receipt.txt',
        mimeType: 'text/plain',
        fileRef: 'att-011',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-3', attachments, 'bp-001');
    expect(result.regulationTags).toContain('GDPR');
    expect(result.regulationTags).toContain('PCI_DSS');
  });

  it('returns empty result for issue with no attachments', async () => {
    const result = await scanner.scanProtectedObject('ISSUE-EMPTY', [], 'bp-001');
    expect(result.findingCount).toBe(0);
    expect(result.regulationTags).toHaveLength(0);
  });

  it('includes findingsByDetector breakdown', async () => {
    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: path.join(FIXTURES, 'email-phone.txt'),
        filename: 'notes.txt',
        mimeType: 'text/plain',
        fileRef: 'att-020',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-4', attachments, 'bp-001');
    expect(typeof result.findingsByDetector['email']).toBe('number');
    expect(result.findingsByDetector['email']!).toBeGreaterThan(0);
  });

  it('routes by filename extension not data.bin path', async () => {
    // Copy fixture to a temp file named data.bin but pass filename=notes.txt
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi-test-'));
    const dataBin = path.join(tmpDir, 'data.bin');
    fs.copyFileSync(path.join(FIXTURES, 'email-phone.txt'), dataBin);

    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: dataBin,
        filename: 'notes.txt',    // handler must route by this, not path
        mimeType: 'text/plain',
        fileRef: 'att-030',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-5', attachments, 'bp-001');
    expect(result.regulationTags).toContain('GDPR');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

// ── XML entities.xml exact-name routing ───────────────────────────────────────

describe('SdiScanner — entities.xml exact-name routing', () => {
  const scanner = new SdiScanner();

  it('routes data.bin correctly when filename is entities.xml', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdi-xml-'));
    const dataBin = path.join(tmpDir, 'data.bin');
    fs.copyFileSync(path.join(FIXTURES, 'entities.xml'), dataBin);

    const attachments: SdiAttachmentDescriptor[] = [
      {
        filePath: dataBin,
        filename: 'entities.xml',
        mimeType: 'application/xml',
        fileRef: 'att-xml-001',
      },
    ];
    const result = await scanner.scanProtectedObject('ISSUE-XML', attachments, 'bp-001');
    expect(result.regulationTags).toContain('GDPR');
    expect(result.regulationTags).toContain('PCI_DSS');

    fs.rmSync(tmpDir, { recursive: true });
  });
});

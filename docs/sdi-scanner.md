# Jira Cloud — SDI Teaser Scanner Architecture

_Author: Software Architect | Date: 2026-05-03 | Status: Approved for Sprint 8_
_References: T7 §2, §3, §4 · PRD Goal #10_

---

## 1. Overview

The Sensitive Data Intelligence (SDI) teaser scanner runs as a post-processing step after attachment download and before manifest finalisation in every backup job. It scans file content for regulated data patterns (email addresses, API keys/secret tokens, credit card numbers, phone numbers), activates the appropriate regulation tags (GDPR, PCI DSS), and surfaces findings on Protected Object cards without requiring operator action.

---

## 2. Core Interfaces

### 2.1 `Detector`

A `Detector` is responsible for a single pattern category (e.g. email, credit card). Each detector is stateless and operates on a `TextChunk` produced by a `FileHandler`.

```typescript
/**
 * Context passed to every detector call.
 * Provides source location metadata for the Finding.
 */
interface ScanContext {
  /** Backup-point this scan is part of */
  backupPointId: string;
  /** Jira attachment ID (or 'entities.xml' for the XML export) */
  fileRef: string;
  /** Original filename as stored in the backup manifest */
  filename: string;
  /** MIME type of the source file */
  mimeType: string;
  /** Human-readable description of the chunk's origin (e.g. column name, XML path) */
  chunkOrigin?: string;
}

/**
 * Identifies what a detector found and where.
 */
interface Finding {
  /** Stable detector identifier (e.g. 'email', 'credit_card', 'api_key', 'phone') */
  detectorId: DetectorId;
  /** Regulation tags activated by this finding */
  regulationTags: RegulationTag[];
  /**
   * Redacted evidence string for display purposes only.
   * MUST be truncated/masked: show first 4 + last 4 chars at most,
   * with middle replaced by '****'. Example: 'john****@example.com', '4111****1111'.
   * Never store the raw matched value.
   */
  sampleEvidence: string;
  /** Reference to the file that contains this finding */
  fileRef: string;
  /** Location within the file */
  location: FindingLocation;
}

interface FindingLocation {
  /** 1-based line number within the text chunk (null if not applicable) */
  lineNumber: number | null;
  /** Column offset within the line (null if not applicable) */
  columnOffset: number | null;
  /** For tabular files: the column name or header */
  columnName?: string;
  /** For XML files: XPath-style element path */
  xmlPath?: string;
}

type DetectorId = 'email' | 'api_key' | 'credit_card' | 'phone';

type RegulationTag = 'GDPR' | 'PCI_DSS';

/**
 * Detector interface — one implementation per DetectorId.
 */
interface Detector {
  readonly id: DetectorId;

  /**
   * Scans `content` for sensitive data patterns.
   * Returns one Finding per distinct match.
   * Never throws — return [] on failure and log the error.
   *
   * @param content  Text content to scan (string) or binary buffer (Buffer).
   *                 Detectors MUST handle both; return [] if the content type
   *                 is not appropriate for this detector (e.g. binary content
   *                 for an email detector).
   * @param context  Source metadata for Finding construction.
   */
  detect(content: string | Buffer, context: ScanContext): Finding[];
}
```

### 2.2 `FileHandler`

A `FileHandler` knows how to decompose a specific file type into `TextChunk` instances suitable for detector input. One `FileHandler` implementation exists per file-type group.

```typescript
/**
 * A discrete unit of text extracted from a source file.
 * Passed verbatim to every registered Detector.
 */
interface TextChunk {
  /** The extracted text content */
  text: string;
  /** Human-readable origin description for ScanContext.chunkOrigin */
  origin: string;
  /** Supplemental location metadata forwarded into Finding.location */
  location: Partial<FindingLocation>;
}

/**
 * FileHandler interface — one implementation per file-type group.
 */
interface FileHandler {
  /**
   * Returns the file extensions this handler is responsible for.
   * Used by the router to select the correct handler at runtime.
   */
  readonly handledExtensions: readonly string[];

  /**
   * Extracts text chunks from the file at `filePath`.
   * Returns a (possibly lazy) iterable — callers iterate and feed each
   * chunk to all registered Detectors without loading the whole file.
   *
   * Implementations MUST:
   *   - Never throw; yield zero chunks on unreadable/corrupt files and log.
   *   - Honour MIME type when extension alone is ambiguous.
   *   - Not load the entire file into memory for large files if possible
   *     (use streaming / line-by-line reads where the format permits).
   *
   * @param filePath  Absolute path to the file on the backup storage layer.
   * @param mime      MIME type as stored in AttachmentSidecar.mimeType.
   */
  extract(filePath: string, mime: string): Iterable<TextChunk>;
}
```

---

## 3. Finding Type — Full Schema

```typescript
interface Finding {
  detectorId: DetectorId;       // 'email' | 'api_key' | 'credit_card' | 'phone'
  regulationTags: RegulationTag[];  // [] is valid if a detector fires with no tag
  sampleEvidence: string;       // masked; never the raw match
  fileRef: string;              // attachmentId or 'entities.xml'
  location: FindingLocation;    // line, column, columnName, xmlPath
}
```

### Redaction contract

The `sampleEvidence` field is stored and displayed but MUST NOT contain the full sensitive value. Implementation rule:

| Detector   | Redaction strategy                                            |
|------------|---------------------------------------------------------------|
| email      | Show domain only: `****@example.com`                         |
| api_key    | Show first 4 chars: `sk-l****` (rest masked)                 |
| credit_card| Show last 4 digits: `****1234`                               |
| phone      | Show last 4 digits: `****5678`                               |

---

## 4. Regulation-Tag Activation Rules

| Detected pattern        | Regulation tag activated | Source        |
|-------------------------|--------------------------|---------------|
| Email address           | `GDPR`                   | T7 §4         |
| Phone number            | `GDPR`                   | T7 §4         |
| Credit card number      | `PCI_DSS`                | T7 §4         |
| API key / secret token  | _(none in Phase 1)_      | T7 §2 — informational only; no regulatory mapping defined in Phase 1 |

**Rules:**

- A single file may activate both `GDPR` and `PCI_DSS` if it contains both email/phone data and credit card data.
- Tags are computed at the **backup-point level** per Protected Object (Issue, Project, Board, Sprint): a Protected Object's regulation tags are the union of all tags found across all of its associated attachments.
- Tag activation is additive — once activated for a backup point, a tag is never removed by a subsequent scan.
- Credit card numbers MUST pass the Luhn algorithm check before a `PCI_DSS` tag is emitted (T7 §3). Pattern match alone is insufficient.

---

## 5. File-Extension → Handler Routing Table

The `SdiScannerPipeline` selects a `FileHandler` by normalising the attachment filename to its lowercase extension and looking up the routing table below. If no handler matches, the file is skipped (logged at DEBUG level; no Finding emitted).

| Extension(s)                                                       | Handler class             | Notes                                                               |
|--------------------------------------------------------------------|---------------------------|---------------------------------------------------------------------|
| `.xml` (where filename is `entities.xml`)                          | `EntitiesXmlHandler`      | Parses Jira XML export; extracts text node values and attribute values |
| `.csv`, `.tsv`                                                     | `TabularHandler`          | Reads rows; emits one chunk per cell                                |
| `.xlsx`                                                            | `TabularHandler`          | Uses XLSX parser; same row/cell chunking as CSV                     |
| `.env`                                                             | `DevConfigHandler`        | Key=value lines; emits key and value as separate chunks             |
| `.yaml`, `.yml`                                                    | `DevConfigHandler`        | YAML scalar values; emits leaf node values                          |
| `.json`                                                            | `DevConfigHandler`        | JSON leaf string values                                             |
| `.toml`                                                            | `DevConfigHandler`        | TOML scalar values                                                  |
| `.properties`                                                      | `DevConfigHandler`        | Java-style key=value; same as `.env`                                |
| `.config`                                                          | `DevConfigHandler`        | Treated as key=value or INI; falls back to line-by-line text       |
| `.txt`, `.log`, `.md`                                              | `TextHandler`             | Line-by-line text; one chunk per line                               |

**Routing precedence:** When a file extension matches multiple handlers (not currently the case), the more specific handler wins. The `entities.xml` match is filename-exact, not extension-only.

---

## 6. Findings Roll-Up to Protected Object Cards

### 6.1 Aggregation model

After the per-attachment scan completes, findings are aggregated bottom-up:

```
Attachment finding
  └─► Issue-level SDI summary  (union of tags from all attachments on the issue)
        └─► Project-level SDI summary  (union of tags from all issues in the project)
              └─► Backup-point SDI summary  (union across all projects)
```

Each node in the hierarchy carries:

```typescript
interface SdiSummary {
  /** Union of all regulation tags found within this scope */
  regulationTags: RegulationTag[];
  /** Number of distinct findings (one per detector+file match, deduplicated) */
  findingCount: number;
  /** IDs of files that produced at least one finding */
  affectedFileRefs: string[];
}
```

### 6.2 Protected Object card rendering

The Protected Object Inventory view (T8 §2, §3) renders the SDI summary as a regulation-tag badge row on each card:

- A `GDPR` badge appears if `sdiSummary.regulationTags` includes `'GDPR'`.
- A `PCI_DSS` badge appears if `sdiSummary.regulationTags` includes `'PCI_DSS'`.
- Badges are rendered without operator action — they activate automatically from scan results.
- Clicking a badge opens a findings drawer listing affected attachments, detectorId, redacted evidence, and location metadata.

No operator configuration is required to activate scanning — it runs automatically in every backup post-processing pass.

---

## 7. Pipeline Integration Point

The SDI scanner hooks into the backup post-processing pipeline at the following position:

```
Backup job phases (context nodes):
  IssueType → CustomField + FieldConfiguration → Workflow + WorkflowScheme
  → Project → Board → Sprint

Protected Object capture:
  → Issue capture (IssueCaptureOrchestrator)
      → Attachment download (AttachmentBlobStore.save())   ← attachment bytes land on disk here

[SDI SCAN HOOK — runs here, per attachment, immediately after save()]
  → SdiScannerPipeline.scanAttachment(backupPointId, attachmentId, filePath, mime, filename)
      → FileHandler.extract(filePath, mime)  → TextChunk[]
      → for each chunk: Detector[].detect(chunk.text, context)  → Finding[]
      → aggregate findings → write SdiSummary to manifest entry

Manifest finalisation:
  → BackupPointManifestWriter.finalise()   ← SDI summaries included in manifest before this
```

**Invariants:**
- The scanner MUST complete before `BackupPointManifestWriter.finalise()` is called, so that regulation tags are present in the finalised manifest.
- Scanner failures (unreadable file, handler crash) MUST NOT halt the backup job. They are recorded as `sdiScanError` in the attachment's manifest entry and counted in the job's per-item error tally (contributing to `'Completed with N errors'` if present).
- The scanner does not re-download attachments — it operates on the already-stored bytes in `AttachmentBlobStore` (the `{backupPointId}/attachments/{attachmentId}/data.bin` path).

### Integration call site (pseudocode)

```typescript
// Inside IssueCaptureOrchestrator, after AttachmentBlobStore.save():

const sidecar = await blobStore.save(backupPointId, attachmentId, issueKey, bytes, meta);

// SDI scan — post-download, pre-manifest-finalisation
const findings = await sdiPipeline.scanAttachment({
  backupPointId,
  fileRef:   attachmentId,
  filename:  sidecar.filename,
  mimeType:  sidecar.mimeType,
  filePath:  blobStore.dataPath(backupPointId, attachmentId),
});

// Findings are stored in the job's SDI accumulator; written to manifest in finalise()
sdiAccumulator.addFindings(issueKey, attachmentId, findings);
```

---

## 8. Detector Specifications

| Detector ID  | Pattern description                                                              | Validation beyond regex         | Regulation tag |
|--------------|---------------------------------------------------------------------------------|----------------------------------|----------------|
| `email`      | RFC 5322-style local-part + `@` + domain                                        | None (pattern match sufficient)  | `GDPR`         |
| `phone`      | E.164 (`+CCNNNNNNNNN`) and common national formats (US, UK, EU)                  | Digit count 7–15                | `GDPR`         |
| `credit_card`| 13–19 consecutive digits (spaces/dashes stripped), common IIN prefix ranges     | Luhn algorithm check required    | `PCI_DSS`      |
| `api_key`    | High-entropy strings matching known vendor prefixes (`sk-`, `ghp_`, `AKIA`, etc.) and generic secret patterns (`[A-Za-z0-9+/]{32,}`) | Entropy threshold check recommended | _(none in Phase 1)_ |

---

## Appendix: Open Questions / Phase 2 Notes

| Item | Status |
|------|--------|
| Full JSM teaser profile (T7 OQ-3) | Phase 2 — separate T7 |
| Scan of Issue description/comment ADF bodies for inline sensitive text | Not in Phase 1 scope — file attachments only |
| XLSX parsing library selection | Backend Developer to specify at implementation time; must justify in task notes per coding standards |
| Streaming for large `.log` files (>100 MB) | Handler should implement line-by-line streaming; Backend Developer to confirm at implementation |

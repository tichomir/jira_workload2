/**
 * BrowserDownloadAssembler — assembles a restore payload as a downloadable ZIP archive.
 *
 * Archive layout:
 *   projects.json          — project entity records
 *   workflows.json         — workflow + workflow-scheme records
 *   custom-fields.json     — custom field + field-configuration records
 *   boards.json            — board records
 *   sprints.json           — sprint records
 *   issues.json            — issue records (with embedded links/comments references)
 *   attachments/{id}/      — one sub-directory per attachment, containing data.bin
 *
 * Heartbeats are emitted via the onHeartbeat callback as each entity type is
 * added to the archive so that the caller can relay progress to the UI.
 *
 * No Jira write API is invoked — this path is read+serialize only.
 *
 * Dependency note: uses jszip (bundled types included) for ZIP assembly.
 * jszip was added because Node.js 20 has no native ZIP creation API.
 *
 * Source: T5 §5.2 — Browser Download export destination.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
import JSZip = require('jszip');
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ── Input / output types ───────────────────────────────────────────────────────

export interface AttachmentEntry {
  id: string;
  filename: string;
  data: Buffer;
}

export interface BrowserDownloadInput {
  jobId: string;
  sourceBackupPointId: string;
  /** Entity collections to serialize into the archive. Defaults to empty arrays. */
  entities?: {
    projects?: unknown[];
    workflows?: unknown[];
    customFields?: unknown[];
    boards?: unknown[];
    sprints?: unknown[];
    issues?: unknown[];
  };
  /** Binary attachment entries to include in attachments/{id}/data.bin */
  attachments?: AttachmentEntry[];
  /**
   * Called after each entity-type file is appended (up to 6 times + once per
   * attachment). Use to emit heartbeat progress events.
   */
  onHeartbeat?: () => void;
}

export interface BrowserDownloadResult {
  /** Absolute path to the assembled ZIP file. */
  zipPath: string;
  /** SHA-256 hex digest of each attachment keyed by attachment ID. */
  attachmentSha256: Record<string, string>;
}

// ── Assembler ──────────────────────────────────────────────────────────────────

export class BrowserDownloadAssembler {
  /**
   * Assembles the archive and writes it to a temp file.
   * Resolves with the path and per-attachment sha256 digests.
   */
  async assemble(input: BrowserDownloadInput): Promise<BrowserDownloadResult> {
    const zip = new JSZip();
    const { entities = {}, attachments = [], onHeartbeat } = input;

    // ── Entity JSON files ───────────────────────────────────────────────────

    const entityFiles: Array<[string, unknown[]]> = [
      ['projects.json',      entities.projects      ?? []],
      ['workflows.json',     entities.workflows     ?? []],
      ['custom-fields.json', entities.customFields  ?? []],
      ['boards.json',        entities.boards        ?? []],
      ['sprints.json',       entities.sprints       ?? []],
      ['issues.json',        entities.issues        ?? []],
    ];

    for (const [filename, records] of entityFiles) {
      zip.file(filename, JSON.stringify(records, null, 2));
      onHeartbeat?.();
    }

    // ── Attachment binaries ─────────────────────────────────────────────────

    const attachmentSha256: Record<string, string> = {};

    for (const att of attachments) {
      const dir = zip.folder(`attachments/${att.id}`);
      if (dir) {
        dir.file('data.bin', att.data);
      }
      attachmentSha256[att.id] = crypto
        .createHash('sha256')
        .update(att.data)
        .digest('hex');
      onHeartbeat?.();
    }

    // ── Write to temp file ──────────────────────────────────────────────────

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    const zipPath = path.join(os.tmpdir(), `jira-restore-${input.jobId}.zip`);
    fs.writeFileSync(zipPath, zipBuffer);

    console.log(
      `[jira-restore] browser-download assembled jobId=${input.jobId} ` +
        `sizeBytes=${zipBuffer.length} attachments=${attachments.length}`,
    );

    return { zipPath, attachmentSha256 };
  }
}

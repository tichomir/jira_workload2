/**
 * AttachmentBlobStore — binary-faithful attachment storage.
 *
 * Stores each attachment as:
 *   {backupDir}/{backupPointId}/attachments/{attachmentId}/data.bin  — raw bytes
 *   {backupDir}/{backupPointId}/attachments/{attachmentId}/meta.json — sidecar
 *
 * The sidecar JSON contains:
 *   attachmentId, issueKey, filename, mimeType, sha256, sizeBytes, capturedAt,
 *   backupPointId
 *
 * NO transcoding, NO recompression, NO encoding transformation.
 * The sha256 field is computed from the stored bytes and must match the
 * source bytes byte-for-byte.
 *
 * Filename is taken from the issue's attachment metadata (fields.attachment[]),
 * NOT from Content-Disposition headers, which may differ from the original name.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ── Sidecar schema ─────────────────────────────────────────────────────────────

export interface AttachmentSidecar {
  attachmentId: string;
  issueKey: string;
  filename: string;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
  capturedAt: string; // ISO 8601
  backupPointId: string;
}

// ── Store ──────────────────────────────────────────────────────────────────────

export class AttachmentBlobStore {
  constructor(private readonly backupDir: string) {}

  /**
   * Writes attachment bytes + sidecar to disk.
   * Computes sha256 of the provided bytes (no re-read).
   * Returns the sidecar for the caller to record in the manifest.
   */
  save(
    backupPointId: string,
    attachmentId: string,
    issueKey: string,
    filename: string,
    mimeType: string,
    data: Buffer,
    capturedAt?: string,
  ): AttachmentSidecar {
    const dir = path.join(
      this.backupDir,
      backupPointId,
      'attachments',
      attachmentId,
    );
    fs.mkdirSync(dir, { recursive: true });

    // Binary write — no encoding, no transform
    fs.writeFileSync(path.join(dir, 'data.bin'), data);

    const sha256 = crypto.createHash('sha256').update(data).digest('hex');
    const sidecar: AttachmentSidecar = {
      attachmentId,
      issueKey,
      filename,
      mimeType,
      sha256,
      sizeBytes: data.length,
      capturedAt: capturedAt ?? new Date().toISOString(),
      backupPointId,
    };

    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(sidecar, null, 2),
      'utf-8',
    );

    console.log(
      `[jira-attachment] saved attachmentId=${attachmentId} issueKey=${issueKey} ` +
        `filename=${filename} sizeBytes=${data.length} sha256=${sha256.slice(0, 16)}...`,
    );

    return sidecar;
  }

  /**
   * Reads back the raw bytes for an attachment.
   */
  readBytes(backupPointId: string, attachmentId: string): Buffer {
    const filePath = path.join(
      this.backupDir,
      backupPointId,
      'attachments',
      attachmentId,
      'data.bin',
    );
    return fs.readFileSync(filePath);
  }

  /**
   * Reads back the sidecar metadata for an attachment.
   */
  readSidecar(backupPointId: string, attachmentId: string): AttachmentSidecar {
    const filePath = path.join(
      this.backupDir,
      backupPointId,
      'attachments',
      attachmentId,
      'meta.json',
    );
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as AttachmentSidecar;
  }
}

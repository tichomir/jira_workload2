/**
 * SdiScanner — Sensitive Data Intelligence scanner.
 *
 * Routes files to the correct FileHandler by extension, runs all registered
 * detectors over each TextChunk, and aggregates Findings.
 *
 * Integration point: called in the backup post-processing pipeline after
 * each attachment is persisted and before manifest finalisation.
 *
 * Failure contract: scan errors MUST NOT halt the backup job.
 * On handler or detector failure the error is logged and an empty finding
 * set is returned for the affected file.
 */

import * as path from 'path';
import { ALL_DETECTORS, Finding, ScanContext, RegulationTag, DetectorId } from './detectors';
import { FileHandler, TextChunk } from './handlers/types';
import { XmlEntitiesHandler } from './handlers/XmlEntitiesHandler';
import { TabularHandler } from './handlers/TabularHandler';
import { ConfigHandler } from './handlers/ConfigHandler';
import { PlainTextHandler } from './handlers/PlainTextHandler';

// ── Handler registry ──────────────────────────────────────────────────────────

const EXT_HANDLER_MAP: Record<string, FileHandler> = {};

function registerHandler(handler: FileHandler): void {
  for (const ext of handler.supportedExtensions) {
    EXT_HANDLER_MAP[ext.toLowerCase()] = handler;
  }
}

registerHandler(new XmlEntitiesHandler());
registerHandler(new TabularHandler());
registerHandler(new ConfigHandler());
registerHandler(new PlainTextHandler());

// ── Result types ──────────────────────────────────────────────────────────────

export interface SdiScanSummary {
  regulationTags: RegulationTag[];
  findingCount: number;
  findingsByDetector: Partial<Record<DetectorId, number>>;
}

export interface SdiProtectedObjectResult extends SdiScanSummary {
  findings: Finding[];
}

// ── Attachment descriptor ─────────────────────────────────────────────────────

export interface SdiAttachmentDescriptor {
  /** Absolute path to the stored data.bin */
  filePath: string;
  /** Original filename from issue metadata */
  filename: string;
  /** MIME type from issue metadata */
  mimeType: string;
  /** Attachment ID used as fileRef in findings */
  fileRef: string;
}

// ── Scanner ───────────────────────────────────────────────────────────────────

export class SdiScanner {
  /**
   * Scans a single file by routing to the correct handler based on filename/extension,
   * running all registered detectors over every extracted TextChunk, and returning
   * the aggregated Findings.
   *
   * Returns [] if no handler matches the extension or the handler fails.
   */
  async scanFile(
    filePath: string,
    mimeType: string,
    context: ScanContext,
  ): Promise<Finding[]> {
    // Use context.filename (original filename from issue metadata) for handler routing
    // when available — the stored path may be data.bin which has no registered handler.
    const routingName = (context.filename || path.basename(filePath)).toLowerCase();
    const ext = path.extname(routingName).toLowerCase();

    // entities.xml exact-name match takes priority; then generic extension lookup
    let handler: FileHandler | undefined;
    if (routingName === 'entities.xml') {
      handler = EXT_HANDLER_MAP['.xml'];
    } else {
      handler = EXT_HANDLER_MAP[ext];
    }

    if (!handler) {
      return [];
    }

    let chunks: TextChunk[];
    try {
      chunks = await handler.extract(filePath, mimeType);
    } catch (err) {
      console.error(
        `[sdi-scan] handler_error file=${filePath} ext=${ext} ` +
          `error="${err instanceof Error ? err.message : String(err)}"`,
      );
      return [];
    }

    const findings: Finding[] = [];
    for (const chunk of chunks) {
      const chunkContext: ScanContext = { ...context, chunkOrigin: chunk.chunkOrigin };
      for (const detector of ALL_DETECTORS) {
        let detected: Finding[];
        try {
          detected = detector.detect(chunk.text, chunkContext);
        } catch {
          continue;
        }
        for (const finding of detected) {
          findings.push({
            ...finding,
            location: {
              ...finding.location,
              lineNumber: finding.location.lineNumber ?? chunk.lineNumber,
              columnName: chunk.columnName,
              xmlPath: chunk.xmlPath,
            },
          });
        }
      }
    }

    return findings;
  }

  /**
   * Scans all attachments for a Protected Object (Issue) and aggregates findings
   * across them. Scan errors on individual attachments are logged and skipped.
   *
   * Emits a structured log line per scanned object:
   *   [sdi-scan] object={id} files={n} findings={k} tags=[GDPR,PCI_DSS]
   */
  async scanProtectedObject(
    objectId: string,
    attachments: SdiAttachmentDescriptor[],
    backupPointId: string,
  ): Promise<SdiProtectedObjectResult> {
    const allFindings: Finding[] = [];

    for (const att of attachments) {
      const context: ScanContext = {
        backupPointId,
        fileRef: att.fileRef,
        filename: att.filename,
        mimeType: att.mimeType,
      };
      try {
        const findings = await this.scanFile(att.filePath, att.mimeType, context);
        allFindings.push(...findings);
      } catch (err) {
        console.error(
          `[sdi-scan] attachment_scan_error objectId=${objectId} ` +
            `fileRef=${att.fileRef} ` +
            `error="${err instanceof Error ? err.message : String(err)}"`,
        );
      }
    }

    const result = this.buildSummary(allFindings);

    // Structured log line per scanned object
    const tagList = result.regulationTags.length > 0
      ? `[${result.regulationTags.join(',')}]`
      : '[]';
    console.log(
      `[sdi-scan] object=${objectId} files=${attachments.length} ` +
        `findings=${result.findingCount} tags=${tagList}`,
    );

    return result;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private buildSummary(findings: Finding[]): SdiProtectedObjectResult {
    const regulationTagSet = new Set<RegulationTag>();
    const findingsByDetector: Partial<Record<DetectorId, number>> = {};

    for (const finding of findings) {
      for (const tag of finding.regulationTags) {
        regulationTagSet.add(tag);
      }
      findingsByDetector[finding.detectorId] =
        (findingsByDetector[finding.detectorId] ?? 0) + 1;
    }

    return {
      findings,
      regulationTags: Array.from(regulationTagSet),
      findingCount: findings.length,
      findingsByDetector,
    };
  }
}

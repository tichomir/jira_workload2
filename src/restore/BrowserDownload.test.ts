/**
 * Browser Download export destination — tests
 *
 * Covers:
 *   - Archive structure: 6 JSON entity files + attachments/ directory
 *   - Attachment byte-fidelity: sha256 of archived bytes matches source
 *   - GET /restore/jobs/:id/download streams archive with Content-Disposition header
 *   - No Jira write API called when destination=browser_download (export)
 *   - Progress heartbeat fires during archive assembly
 *   - Error path: missing manifest entity (assembler handles empty entities gracefully)
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import request from 'supertest';
import express from 'express';
import { BrowserDownloadAssembler } from './BrowserDownloadAssembler';
import { RestoreJobStore } from './RestoreJobStore';
import { RestoreEventBus } from './RestoreEventBus';
import { RestoreWorker } from './RestoreWorker';
import { createRestoreJobRouter } from './RestoreJobRouter';
import { NullJiraWriteClient } from './RestoreEngine';
import { JiraCredentialRepository } from '../db/JiraCredentialRepository';

// ── BrowserDownloadAssembler unit tests ────────────────────────────────────────

describe('BrowserDownloadAssembler — archive structure', () => {
  it('produces a ZIP containing all 6 entity JSON files', async () => {
    const assembler = new BrowserDownloadAssembler();

    const result = await assembler.assemble({
      jobId: 'test-structure',
      sourceBackupPointId: 'bp-001',
      entities: {
        projects: [{ key: 'PROJ', name: 'My Project' }],
        workflows: [{ id: 'wf-1', name: 'Default Workflow' }],
        customFields: [{ id: 'cf-1', name: 'Story Points' }],
        boards: [{ id: 1, name: 'PROJ board' }],
        sprints: [{ id: 10, name: 'Sprint 1' }],
        issues: [{ key: 'PROJ-1', summary: 'First issue' }],
      },
    });

    const zipBuffer = fs.readFileSync(result.zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files);

    expect(names).toContain('projects.json');
    expect(names).toContain('workflows.json');
    expect(names).toContain('custom-fields.json');
    expect(names).toContain('boards.json');
    expect(names).toContain('sprints.json');
    expect(names).toContain('issues.json');

    // Verify JSON content round-trips
    const projectsRaw = await zip.file('projects.json')!.async('string');
    const projects = JSON.parse(projectsRaw) as unknown[];
    expect(projects).toHaveLength(1);
    expect((projects[0] as Record<string, unknown>)['key']).toBe('PROJ');

    // Cleanup
    fs.unlinkSync(result.zipPath);
  });

  it('includes attachments/ directory entries for each attachment', async () => {
    const assembler = new BrowserDownloadAssembler();
    const attachmentData = Buffer.from('binary attachment content');

    const result = await assembler.assemble({
      jobId: 'test-attachments',
      sourceBackupPointId: 'bp-002',
      attachments: [
        { id: 'att-001', filename: 'report.pdf', data: attachmentData },
      ],
    });

    const zipBuffer = fs.readFileSync(result.zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const names = Object.keys(zip.files);

    // Attachment directory should be present
    expect(names.some((n) => n.startsWith('attachments/att-001'))).toBe(true);

    // Verify data.bin content
    const dataBin = zip.file('attachments/att-001/data.bin');
    expect(dataBin).not.toBeNull();
    const binBuffer = await dataBin!.async('nodebuffer');
    expect(binBuffer).toEqual(attachmentData);

    fs.unlinkSync(result.zipPath);
  });

  it('attachment bytes in archive are identical to source (sha256 match)', async () => {
    const assembler = new BrowserDownloadAssembler();
    const originalData = Buffer.from('exact binary content for sha256 test 🚀');
    const expectedSha256 = crypto
      .createHash('sha256')
      .update(originalData)
      .digest('hex');

    const result = await assembler.assemble({
      jobId: 'test-sha256',
      sourceBackupPointId: 'bp-003',
      attachments: [
        { id: 'att-sha', filename: 'data.bin', data: originalData },
      ],
    });

    // sha256 returned by assembler matches expected
    expect(result.attachmentSha256['att-sha']).toBe(expectedSha256);

    // also verify from ZIP bytes
    const zipBuffer = fs.readFileSync(result.zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);
    const archivedBuffer = await zip.file('attachments/att-sha/data.bin')!.async('nodebuffer');
    const archivedSha256 = crypto
      .createHash('sha256')
      .update(archivedBuffer)
      .digest('hex');
    expect(archivedSha256).toBe(expectedSha256);

    fs.unlinkSync(result.zipPath);
  });

  it('handles empty entities gracefully (no crash, 6 empty JSON arrays)', async () => {
    const assembler = new BrowserDownloadAssembler();

    const result = await assembler.assemble({
      jobId: 'test-empty',
      sourceBackupPointId: 'bp-empty',
      // entities omitted — should default to empty arrays
    });

    const zipBuffer = fs.readFileSync(result.zipPath);
    const zip = await JSZip.loadAsync(zipBuffer);

    for (const filename of [
      'projects.json',
      'workflows.json',
      'custom-fields.json',
      'boards.json',
      'sprints.json',
      'issues.json',
    ]) {
      const content = await zip.file(filename)!.async('string');
      expect(JSON.parse(content)).toEqual([]);
    }

    fs.unlinkSync(result.zipPath);
  });

  it('calls onHeartbeat for each entity file added (6 calls minimum)', async () => {
    const assembler = new BrowserDownloadAssembler();
    const heartbeats: number[] = [];

    await assembler.assemble({
      jobId: 'test-heartbeats',
      sourceBackupPointId: 'bp-hb',
      onHeartbeat: () => heartbeats.push(Date.now()),
    });

    // 6 entity files → at least 6 heartbeat calls
    expect(heartbeats.length).toBeGreaterThanOrEqual(6);

    // Cleanup
    const zipPath = `/tmp/jira-restore-test-heartbeats.zip`;
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  });
});

// ── RestoreWorker — export destination path ────────────────────────────────────

describe('RestoreWorker — browser_download (export) destination', () => {
  function buildFixture() {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();
    return { store, bus };
  }

  it('completes the job without calling any Jira write methods', async () => {
    const { store, bus } = buildFixture();

    const job = store.createJob({
      jobId: 'worker-export-test',
      sourceBackupPointId: 'bp-export',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });

    // Spy on NullJiraWriteClient to ensure no write calls
    const writeClient = new NullJiraWriteClient();
    const writeProjectSpy = jest.spyOn(writeClient, 'writeProject');
    const writeIssueSpy = jest.spyOn(writeClient, 'writeIssue');

    const worker = new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
      writeClient,
    );

    await worker.run();

    // No write calls
    expect(writeProjectSpy).not.toHaveBeenCalled();
    expect(writeIssueSpy).not.toHaveBeenCalled();

    // Job completed
    const updated = store.getJob(job.jobId);
    expect(updated?.status).toBe('completed');
  });

  it('stores the download path after assembly', async () => {
    const { store, bus } = buildFixture();

    const job = store.createJob({
      jobId: 'worker-export-path',
      sourceBackupPointId: 'bp-path',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });

    await new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    ).run();

    const downloadPath = store.getDownloadPath(job.jobId);
    expect(downloadPath).not.toBeNull();
    expect(downloadPath!.endsWith('.zip')).toBe(true);
  });

  it('emits heartbeats during archive assembly (via onHeartbeat callback)', async () => {
    const { store, bus } = buildFixture();

    const job = store.createJob({
      jobId: 'worker-export-hb',
      sourceBackupPointId: 'bp-hb2',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });

    const heartbeatEvents: unknown[] = [];
    bus.subscribe(job.jobId, (e) => {
      if (e.type === 'heartbeat') heartbeatEvents.push(e);
    });

    await new RestoreWorker(
      { jobId: job.jobId, heartbeatIntervalMs: 9000 },
      store,
      bus,
    ).run();

    // At least 6 heartbeats (one per entity file)
    expect(heartbeatEvents.length).toBeGreaterThanOrEqual(6);
  });
});

// ── GET /restore/jobs/:id/download ─────────────────────────────────────────────

describe('GET /restore/jobs/:id/download', () => {
  function buildApp() {
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    JiraCredentialRepository.runMigration(db);
    const restoreStore = new RestoreJobStore(db);
    const eventBus = new RestoreEventBus();
    const credRepo = new JiraCredentialRepository(db);

    const app = express();
    app.use(express.json());
    app.use(
      '/restore/jobs',
      createRestoreJobRouter(restoreStore, eventBus, credRepo, {
        allowUnauthenticated: true,
      }),
    );

    return { app, restoreStore };
  }

  it('returns 404 for unknown job', async () => {
    const { app } = buildApp();

    const res = await request(app).get('/restore/jobs/no-such-job/download');
    expect(res.status).toBe(404);
  });

  it('returns 400 when job is not an export job', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'non-export-dl',
      sourceBackupPointId: 'bp-x',
      scope: { type: 'all' },
      destination: { type: 'original' },
      conflictMode: 'skip',
    });
    restoreStore.complete(job.jobId, 'completed');

    const res = await request(app).get(`/restore/jobs/${job.jobId}/download`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_EXPORT_JOB');
  });

  it('returns 409 when export job is not yet complete', async () => {
    const { app, restoreStore } = buildApp();

    const job = restoreStore.createJob({
      jobId: 'pending-export-dl',
      sourceBackupPointId: 'bp-pend',
      scope: { type: 'all' },
      destination: { type: 'export' },
      conflictMode: 'skip',
    });
    // job stays in 'pending'

    const res = await request(app).get(`/restore/jobs/${job.jobId}/download`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('JOB_NOT_COMPLETE');
  });

  it('streams the ZIP with Content-Disposition: attachment header when ready', async () => {
    const { app, restoreStore } = buildApp();

    // Run an export job through the worker so the ZIP is assembled
    const db = new Database(':memory:');
    RestoreJobStore.migrate(db);
    const store = new RestoreJobStore(db);
    const bus = new RestoreEventBus();

    const app2 = express();
    app2.use(express.json());
    app2.use(
      '/restore/jobs',
      createRestoreJobRouter(store, bus, new JiraCredentialRepository(db), {
        allowUnauthenticated: true,
      }),
    );

    // Create job via router (fire-and-forget worker)
    const createRes = await request(app2)
      .post('/restore/jobs')
      .send({
        sourceBackupPointId: 'bp-dl-test',
        scope: { type: 'all' },
        destination: { type: 'export' },
        conflictMode: 'skip',
      });

    expect(createRes.status).toBe(201);
    const jobId = createRes.body.jobId as string;

    // Wait for export job to complete (poll status)
    let status = 'pending';
    for (let i = 0; i < 50 && status !== 'completed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const pollRes = await request(app2).get(`/restore/jobs/${jobId}`);
      status = pollRes.body.status as string;
    }
    expect(status).toBe('completed');

    // Download
    const dlRes = await request(app2).get(`/restore/jobs/${jobId}/download`);
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-disposition']).toContain('attachment');
    expect(dlRes.headers['content-type']).toContain('application/zip');
    expect((dlRes.body as Buffer).length ?? dlRes.text.length).toBeGreaterThan(0);
  });
});

/**
 * server.ts — Production entry point for the Jira Cloud backup connector.
 *
 * Responsibilities:
 *   - Open the SQLite database and run all migrations
 *   - Wire all feature routers under /api
 *   - Expose GET /health for container health checks
 *   - Listen on PORT (default 3000)
 *
 * Environment variables consumed (see .env.example for full list):
 *   PORT                     — HTTP listen port (default: 3000)
 *   DATABASE_URL             — Path to SQLite database file (default: data/jira.db)
 *   BACKUP_DIR               — Directory for backup blobs (default: data/backups)
 *   JIRA_OAUTH_CLIENT_ID     — Atlassian OAuth app Client ID
 *   JIRA_OAUTH_CLIENT_SECRET — Atlassian OAuth app Client Secret
 *   OAUTH_REDIRECT_URI       — OAuth callback URL
 *   NODE_ENV                 — Runtime environment; 'production' disables fault injection
 *   LOG_LEVEL                — Log verbosity (default: info)
 *   HEARTBEAT_INTERVAL_MS    — Heartbeat emit interval ms (default: 8000)
 *   STALL_THRESHOLD_MS       — Stall detection threshold ms (default: 20000)
 */

import * as fs from 'fs';
import * as path from 'path';
import express from 'express';
import Database from 'better-sqlite3';

import { JiraCredentialRepository } from './db/JiraCredentialRepository';
import { OAuthStateStore } from './auth/OAuthStateStore';
import { createJiraOAuthRouter } from './auth/JiraOAuthHandler';
import { createJiraConnectionsRouter } from './connections/JiraConnectionsRouter';
import { createManualAuthRouter } from './connections/ManualAuthRouter';
import { WorkloadConfigRepository } from './workload/WorkloadConfigRepository';
import { createWorkloadConfigRouter } from './workload/WorkloadConfigRouter';
import { createDiscoveryPreviewRouter } from './discovery/DiscoveryPreviewRouter';
import { BackupPointRepository } from './manifest/BackupPointRepository';
import { createInventoryRouter } from './inventory/InventoryRouter';
import { JobStore } from './jobs/JobStore';
import { JobEventBus } from './jobs/JobEventBus';
import { createJobRouter } from './jobs/JobRouter';
import { RestoreJobStore } from './restore/RestoreJobStore';
import { RestoreEventBus } from './restore/RestoreEventBus';
import { createRestoreJobRouter } from './restore/RestoreJobRouter';

// ── Config ─────────────────────────────────────────────────────────────────────

const port = parseInt(process.env.PORT ?? '3000', 10);
const dbPath = process.env.DATABASE_URL ?? path.join('data', 'jira.db');
const backupDir = process.env.BACKUP_DIR ?? path.join('data', 'backups');

// Ensure the data directory exists before opening SQLite
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// ── Database + migrations ──────────────────────────────────────────────────────

const db = new Database(dbPath);

// Run all schema migrations (all are idempotent — safe to re-run)
JiraCredentialRepository.runMigration(db);
BackupPointRepository.migrate(db);
JobStore.migrate(db);
WorkloadConfigRepository.runMigration(db);
RestoreJobStore.migrate(db);

// ── Repository and store instances ────────────────────────────────────────────

const credRepo = new JiraCredentialRepository(db);
const backupPointRepo = new BackupPointRepository(db);
const jobStore = new JobStore(db);
const workloadConfigRepo = new WorkloadConfigRepository(db);
const restoreJobStore = new RestoreJobStore(db);

// ── Shared singletons ──────────────────────────────────────────────────────────

const oauthStateStore = new OAuthStateStore();
const jobEventBus = new JobEventBus();
const restoreEventBus = new RestoreEventBus();

const oauthConfig = {
  clientId: process.env.JIRA_OAUTH_CLIENT_ID ?? '',
  clientSecret: process.env.JIRA_OAUTH_CLIENT_SECRET ?? '',
  redirectUri:
    process.env.OAUTH_REDIRECT_URI ??
    `http://localhost:${port}/api/auth/jira/callback`,
};

// ── Express app ────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

/**
 * GET /health
 * Container health probe. Returns HTTP 200 with { status: 'ok' }.
 * No auth required — must be reachable from the orchestrator without credentials.
 */
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// OAuth 3LO flow: GET /api/auth/jira/start, GET /api/auth/jira/callback
app.use('/api/auth/jira', createJiraOAuthRouter(oauthStateStore, credRepo, oauthConfig));

// Site selection after OAuth: POST /api/jira/connections/select
app.use('/api/jira/connections', createJiraConnectionsRouter(credRepo));

// Manual API Token auth: POST /api/connections/manual
app.use('/api/connections/manual', createManualAuthRouter(credRepo));

// Workload configuration: GET/POST /api/workload/config
app.use('/api/workload', createWorkloadConfigRouter(workloadConfigRepo));

// Discovery preview: project scope preview endpoints
app.use('/api', createDiscoveryPreviewRouter(credRepo));

// Protected Object Inventory + global search
app.use('/api', createInventoryRouter(backupPointRepo, { backupDir }));

// Backup job progress (SSE + polling): GET /api/jobs/:jobId[/events]
app.use('/api/jobs', createJobRouter(jobStore, jobEventBus, credRepo));

// Restore jobs: POST/GET /api/restore/jobs[/:id]
app.use('/api', createRestoreJobRouter(restoreJobStore, restoreEventBus, credRepo));

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`[jira-backup] server listening on port ${port}`);
  console.log(`[jira-backup] database: ${dbPath}`);
  console.log(
    `[jira-backup] environment: ${process.env.NODE_ENV ?? 'development'}`,
  );
});

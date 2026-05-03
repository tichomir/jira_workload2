/**
 * Sprint 10 Playwright E2E tests — Project Inventory Search & Filters
 *
 * Run mode: API-only (no browser binary required). Uses Playwright's
 * `request` fixture (APIRequestContext) against a real Express server that
 * wires together the InventoryRouter with a seeded BackupPointRepository
 * and a tempdir-backed issue JSON store providing rich fields.
 *
 * Seed fixture — project SEARCH, 5 issues:
 *   SEARCH-1 summary="Login bug on mobile"         status=Open         issueType=Bug   priority=High   assignee=acc-alice labels=[urgent,frontend] updated=2026-03-01
 *   SEARCH-2 summary="Mobile dashboard layout fix" status=In Progress  issueType=Task  priority=Medium assignee=acc-bob   labels=[frontend]        updated=2026-03-10
 *   SEARCH-3 summary="Login page redesign story"   status=Done         issueType=Story priority=Low    assignee=acc-alice labels=[ui]              updated=2026-03-15
 *   SEARCH-4 summary="Fix payment gateway timeout" status=Open         issueType=Bug   priority=High   assignee=acc-charlie labels=[payment,urgent] updated=2026-03-20
 *   SEARCH-5 summary="Update API documentation"    status=Done         issueType=Task  priority=Low    assignee=acc-bob   labels=[docs]            updated=2026-03-25
 *
 * Coverage:
 *   Scenario 1 — Exact-match search
 *     Querying a valid issueKey pattern (SEARCH-1) returns exactly that row.
 *
 *   Scenario 2 — Tokenised search
 *     Query "login bug" returns issues whose summary contains BOTH tokens
 *     (case-insensitive AND). Only SEARCH-1 qualifies.
 *
 *   Scenario 3 — Each filter dimension narrows results correctly
 *     (3a) status=Open → SEARCH-1, SEARCH-4
 *     (3b) issueType=Bug → SEARCH-1, SEARCH-4
 *     (3c) priority=High → SEARCH-1, SEARCH-4
 *     (3d) assigneeAccountId=acc-alice → SEARCH-1, SEARCH-3
 *     (3e) labels=urgent → SEARCH-1, SEARCH-4; labels=urgent&payment → SEARCH-4 only
 *     (3f) updatedFrom=2026-03-12 + updatedTo=2026-03-22 → SEARCH-3, SEARCH-4
 *
 *   Scenario 4 — Combined filters AND together
 *     status=Open + issueType=Bug → only issues matching BOTH (SEARCH-1, SEARCH-4).
 *
 *   Scenario 5 — Invalid date range
 *     updatedFrom=not-a-date → API returns HTTP 400 (UI would surface error state).
 *
 *   Scenario 6 — Clear-all resets to unfiltered state
 *     A request without filters after filtering returns full 5-issue set.
 *
 *   Scenario 7 — [inventory-search] log line emitted per query
 *     console.log capture confirms the structured log line is emitted with
 *     project=, mode=, filters=, and hits= fields on every search request.
 *
 * Evidence files written to tests/integration/project-inventory-search/evidence/
 *
 * Run: npx playwright test --project=api e2e/sprint10-project-inventory-search.spec.ts
 */

import { test, expect } from '@playwright/test';
import http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import Database from 'better-sqlite3';
import { BackupPointRepository } from '../src/manifest/BackupPointRepository';
import { BackupPointManifestWriter } from '../src/manifest/BackupPointManifestWriter';
import { createInventoryRouter } from '../src/inventory/InventoryRouter';
import type { SimpleManifestEntry } from '../src/manifest/types';

// ── Evidence helpers ──────────────────────────────────────────────────────────

const EVIDENCE_DIR = path.resolve(
  __dirname,
  '../tests/integration/project-inventory-search/evidence',
);

function saveEvidence(filename: string, data: unknown): void {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, filename),
    JSON.stringify(data, null, 2),
    'utf8',
  );
}

// ── Seed constants ────────────────────────────────────────────────────────────

const CLOUD_ID = 'cloud-sprint10-search';
const SITE_URL = 'https://sprint10test.atlassian.net';
const BP_ID = 'bp-sprint10-001';
const PROJECT_KEY = 'SEARCH';

/** Seed issues used across all tests */
const SEED_ISSUES = [
  {
    objectId: 'SEARCH-1',
    summary: 'Login bug on mobile',
    status: 'Open',
    issueType: 'Bug',
    priority: 'High',
    assignee: { displayName: 'Alice', accountId: 'acc-alice' },
    labels: ['urgent', 'frontend'],
    updated: '2026-03-01T00:00:00.000Z',
  },
  {
    objectId: 'SEARCH-2',
    summary: 'Mobile dashboard layout fix',
    status: 'In Progress',
    issueType: 'Task',
    priority: 'Medium',
    assignee: { displayName: 'Bob', accountId: 'acc-bob' },
    labels: ['frontend'],
    updated: '2026-03-10T00:00:00.000Z',
  },
  {
    objectId: 'SEARCH-3',
    summary: 'Login page redesign story',
    status: 'Done',
    issueType: 'Story',
    priority: 'Low',
    assignee: { displayName: 'Alice', accountId: 'acc-alice' },
    labels: ['ui'],
    updated: '2026-03-15T00:00:00.000Z',
  },
  {
    objectId: 'SEARCH-4',
    summary: 'Fix payment gateway timeout',
    status: 'Open',
    issueType: 'Bug',
    priority: 'High',
    assignee: { displayName: 'Charlie', accountId: 'acc-charlie' },
    labels: ['payment', 'urgent'],
    updated: '2026-03-20T00:00:00.000Z',
  },
  {
    objectId: 'SEARCH-5',
    summary: 'Update API documentation',
    status: 'Done',
    issueType: 'Task',
    priority: 'Low',
    assignee: { displayName: 'Bob', accountId: 'acc-bob' },
    labels: ['docs'],
    updated: '2026-03-25T00:00:00.000Z',
  },
] as const;

// ── Test server factory ───────────────────────────────────────────────────────

interface ServerHandle {
  stop: () => Promise<void>;
  baseUrl: string;
  backupDir: string;
}

function buildSearchTestServer(port: number): Promise<ServerHandle> {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  BackupPointRepository.migrate(db);

  const repo = new BackupPointRepository(db);

  // ── Write issue JSON files to a temp backupDir ─────────────────────────────
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint10-search-'));
  const issueDir = path.join(backupDir, BP_ID, 'issues');
  fs.mkdirSync(issueDir, { recursive: true });

  for (const issue of SEED_ISSUES) {
    fs.writeFileSync(
      path.join(issueDir, `${issue.objectId}.json`),
      JSON.stringify({
        fields: {
          summary: issue.summary,
          status: { name: issue.status },
          issuetype: { name: issue.issueType },
          priority: { name: issue.priority },
          assignee: issue.assignee,
          labels: issue.labels,
          updated: issue.updated,
        },
      }),
      'utf8',
    );
  }

  // ── Seed manifest_entries ──────────────────────────────────────────────────
  const writer = new BackupPointManifestWriter(repo, {
    backupPointId: BP_ID,
    cloudId: CLOUD_ID,
    siteUrl: SITE_URL,
    scopeMode: 'all',
  });

  function makeEntry(
    objectId: string,
    status: 'ok' | 'error' = 'ok',
  ): SimpleManifestEntry {
    return {
      id: `entry-${objectId.toLowerCase()}`,
      backupPointId: BP_ID,
      objectType: 'JiraIssue',
      objectId,
      capturedAt: Date.now(),
      sourceEndpoint: '/rest/api/3/search/jql',
      status,
    };
  }

  for (const issue of SEED_ISSUES) {
    writer.append(makeEntry(issue.objectId));
  }

  // ── Express app ─────────────────────────────────────────────────────────────
  const app = express();
  app.use(express.json());

  const inventoryRouter = createInventoryRouter(repo, {
    allowUnauthenticated: true,
    backupDir,
  });
  app.use('/api', inventoryRouter);

  const baseUrl = `http://localhost:${port}`;

  return new Promise((resolve) => {
    const srv = http.createServer(app);
    srv.listen(port, () => {
      resolve({
        baseUrl,
        backupDir,
        stop: () =>
          new Promise((res, rej) =>
            srv.close((err) => {
              db.close();
              fs.rmSync(backupDir, { recursive: true, force: true });
              err ? rej(err) : res();
            }),
          ),
      });
    });
  });
}

/** Build the project-issues URL for this test server */
function projectUrl(
  baseUrl: string,
  params: Record<string, string | string[]> = {},
): string {
  const url = new URL(
    `/api/inventory/projects/${PROJECT_KEY}/issues`,
    baseUrl,
  );
  url.searchParams.set('cloudId', CLOUD_ID);
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1 — Exact-match search
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 1: Exact-match search by issueKey', () => {
  const PORT = 16000;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(1a) exact issueKey SEARCH-1 returns exactly that single row', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'SEARCH-1' }));
    expect(res.ok()).toBe(true);
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string; summary: string | null }>; total: number };

    expect(body.total).toBe(1);
    expect(body.issues).toHaveLength(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-1');
    expect(body.issues[0].summary).toBe('Login bug on mobile');

    saveEvidence('scenario1a-exact-match.json', {
      description: 'Exact-match search: querying issueKey SEARCH-1 returns only that row',
      scenario: '1a',
      mode: 'exact',
      query: 'SEARCH-1',
      endpoint: `GET /api/inventory/projects/${PROJECT_KEY}/issues?q=SEARCH-1`,
      response: { status: res.status(), total: body.total, issues: body.issues },
      assertions: [
        'total === 1',
        'issues[0].issueKey === "SEARCH-1"',
        'issues[0].summary === "Login bug on mobile"',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  test('(1b) exact issueKey match is case-insensitive (search-1 finds SEARCH-1)', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'search-1' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };

    expect(body.total).toBe(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-1');

    saveEvidence('scenario1b-exact-match-case-insensitive.json', {
      description: 'Exact-match is case-insensitive: search-1 (lowercase) finds SEARCH-1',
      scenario: '1b',
      query: 'search-1',
      total: body.total,
      issueKey: body.issues[0].issueKey,
      timestamp: new Date().toISOString(),
    });
  });

  test('(1c) exact issueKey not in project returns empty', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'SEARCH-999' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.issues).toHaveLength(0);

    saveEvidence('scenario1c-exact-match-no-result.json', {
      description: 'Exact-match: issueKey not in project returns empty result set',
      scenario: '1c',
      query: 'SEARCH-999',
      total: body.total,
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2 — Tokenised search (AND semantics, case-insensitive)
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 2: Tokenised summary search', () => {
  const PORT = 16010;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(2a) "login bug" returns only SEARCH-1 (summary contains both tokens)', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'login bug' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as {
      issues: Array<{ issueKey: string; summary: string | null }>;
      total: number;
    };

    // SEARCH-1: "Login bug on mobile" — has "login" and "bug" ✓
    // SEARCH-2: "Mobile dashboard layout fix" — neither token ✗
    // SEARCH-3: "Login page redesign story" — has "login" but not "bug" ✗
    // SEARCH-4: "Fix payment gateway timeout" — neither ✗
    // SEARCH-5: "Update API documentation" — neither ✗
    expect(body.total).toBe(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-1');
    expect(body.issues[0].summary).toBe('Login bug on mobile');

    saveEvidence('scenario2a-tokenised-login-bug.json', {
      description: 'Tokenised search "login bug": AND semantics — only SEARCH-1 summary contains both tokens',
      scenario: '2a',
      mode: 'tokenised',
      query: 'login bug',
      tokens: ['login', 'bug'],
      seedSummaries: SEED_ISSUES.map((i) => ({ objectId: i.objectId, summary: i.summary })),
      response: { status: res.status(), total: body.total, issues: body.issues },
      assertions: [
        'total === 1',
        'SEARCH-1 returned — "Login bug on mobile" contains both "login" and "bug"',
        'SEARCH-3 excluded — "Login page redesign story" contains "login" but not "bug"',
        'SEARCH-2/4/5 excluded — contain neither token',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  test('(2b) single-token "login" returns all issues with "login" in summary', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'login' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };

    // SEARCH-1: "Login bug on mobile" ✓
    // SEARCH-3: "Login page redesign story" ✓
    const keys = body.issues.map((i) => i.issueKey).sort();
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-3']);

    saveEvidence('scenario2b-tokenised-single-login.json', {
      description: 'Tokenised single-token "login" returns both summaries containing "login"',
      scenario: '2b',
      query: 'login',
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(2c) tokenised search is case-insensitive — "LOGIN BUG" matches same as "login bug"', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { q: 'LOGIN BUG' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-1');

    saveEvidence('scenario2c-tokenised-case-insensitive.json', {
      description: 'Tokenised search is case-insensitive: "LOGIN BUG" (uppercase) matches same issue as "login bug"',
      scenario: '2c',
      query: 'LOGIN BUG',
      total: body.total,
      issueKey: body.issues[0].issueKey,
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3 — Each filter dimension narrows results
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 3: Filter dimensions', () => {
  const PORT = 16020;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(3a) status=Open returns only Open issues', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { status: 'Open' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // Open: SEARCH-1, SEARCH-4
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-4']);

    saveEvidence('scenario3a-filter-status.json', {
      description: 'Filter: status=Open narrows to SEARCH-1 and SEARCH-4',
      scenario: '3a',
      filter: { status: 'Open' },
      total: body.total,
      issueKeys: keys,
      assertions: ['total === 2', 'SEARCH-1 and SEARCH-4 returned (both Open)'],
      timestamp: new Date().toISOString(),
    });
  });

  test('(3b) issueType=Bug returns only Bug issues', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { issueType: 'Bug' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // Bug: SEARCH-1, SEARCH-4
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-4']);

    saveEvidence('scenario3b-filter-issue-type.json', {
      description: 'Filter: issueType=Bug narrows to SEARCH-1 and SEARCH-4',
      scenario: '3b',
      filter: { issueType: 'Bug' },
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(3c) priority=High returns only High priority issues', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { priority: 'High' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // High: SEARCH-1, SEARCH-4
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-4']);

    saveEvidence('scenario3c-filter-priority.json', {
      description: 'Filter: priority=High narrows to SEARCH-1 and SEARCH-4',
      scenario: '3c',
      filter: { priority: 'High' },
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(3d) assigneeAccountId=acc-alice returns SEARCH-1 and SEARCH-3', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { assigneeAccountId: 'acc-alice' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // acc-alice: SEARCH-1, SEARCH-3
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-3']);

    saveEvidence('scenario3d-filter-assignee.json', {
      description: 'Filter: assigneeAccountId=acc-alice returns SEARCH-1 and SEARCH-3',
      scenario: '3d',
      filter: { assigneeAccountId: 'acc-alice' },
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(3e-single) labels=urgent returns SEARCH-1 and SEARCH-4', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { labels: 'urgent' }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // urgent: SEARCH-1, SEARCH-4
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-4']);

    saveEvidence('scenario3e-single-label.json', {
      description: 'Filter: labels=urgent returns SEARCH-1 and SEARCH-4',
      scenario: '3e-single',
      filter: { labels: ['urgent'] },
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(3e-multi) labels=urgent&labels=payment AND-filters to only SEARCH-4', async ({ request }) => {
    const res = await request.get(projectUrl(handle.baseUrl, { labels: ['urgent', 'payment'] }));
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey);

    // SEARCH-4 has both "payment" and "urgent"; SEARCH-1 has "urgent" but not "payment"
    expect(body.total).toBe(1);
    expect(keys).toEqual(['SEARCH-4']);

    saveEvidence('scenario3e-multi-label.json', {
      description: 'Filter: labels=urgent + labels=payment (AND) returns only SEARCH-4 (has both)',
      scenario: '3e-multi',
      filter: { labels: ['urgent', 'payment'] },
      total: body.total,
      issueKeys: keys,
      assertions: [
        'SEARCH-4 returned — has both "urgent" and "payment"',
        'SEARCH-1 excluded — has "urgent" but NOT "payment"',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  test('(3f) updatedFrom + updatedTo date range returns only in-range issues', async ({ request }) => {
    // Range: 2026-03-12 to 2026-03-22
    // SEARCH-1: 2026-03-01 — before range ✗
    // SEARCH-2: 2026-03-10 — before range ✗
    // SEARCH-3: 2026-03-15 — in range ✓
    // SEARCH-4: 2026-03-20 — in range ✓
    // SEARCH-5: 2026-03-25 — after range ✗
    const res = await request.get(
      projectUrl(handle.baseUrl, {
        updatedFrom: '2026-03-12T00:00:00.000Z',
        updatedTo: '2026-03-22T00:00:00.000Z',
      }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-3', 'SEARCH-4']);

    saveEvidence('scenario3f-filter-date-range.json', {
      description: 'Filter: updatedFrom=2026-03-12 + updatedTo=2026-03-22 returns SEARCH-3 and SEARCH-4',
      scenario: '3f',
      filter: { updatedFrom: '2026-03-12T00:00:00.000Z', updatedTo: '2026-03-22T00:00:00.000Z' },
      total: body.total,
      issueKeys: keys,
      assertions: [
        'SEARCH-3 (2026-03-15) in range ✓',
        'SEARCH-4 (2026-03-20) in range ✓',
        'SEARCH-1 (2026-03-01) before range ✗',
        'SEARCH-5 (2026-03-25) after range ✗',
      ],
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4 — Combined filters AND together
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 4: Combined filters AND together', () => {
  const PORT = 16030;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(4a) status=Open + issueType=Bug ANDs to SEARCH-1 and SEARCH-4', async ({ request }) => {
    const res = await request.get(
      projectUrl(handle.baseUrl, { status: 'Open', issueType: 'Bug' }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };
    const keys = body.issues.map((i) => i.issueKey).sort();

    // Open: SEARCH-1, SEARCH-4; Bug: SEARCH-1, SEARCH-4 → intersection = SEARCH-1, SEARCH-4
    expect(body.total).toBe(2);
    expect(keys).toEqual(['SEARCH-1', 'SEARCH-4']);

    saveEvidence('scenario4a-combined-status-type.json', {
      description: 'Combined: status=Open + issueType=Bug → SEARCH-1 and SEARCH-4 (both Open Bugs)',
      scenario: '4a',
      filters: { status: 'Open', issueType: 'Bug' },
      total: body.total,
      issueKeys: keys,
      timestamp: new Date().toISOString(),
    });
  });

  test('(4b) priority=High + assigneeAccountId=acc-alice narrows to single issue', async ({ request }) => {
    // High: SEARCH-1, SEARCH-4; acc-alice: SEARCH-1, SEARCH-3 → intersection = SEARCH-1
    const res = await request.get(
      projectUrl(handle.baseUrl, { priority: 'High', assigneeAccountId: 'acc-alice' }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };

    expect(body.total).toBe(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-1');

    saveEvidence('scenario4b-combined-priority-assignee.json', {
      description: 'Combined: priority=High + assigneeAccountId=acc-alice → only SEARCH-1',
      scenario: '4b',
      filters: { priority: 'High', assigneeAccountId: 'acc-alice' },
      total: body.total,
      issueKeys: body.issues.map((i) => i.issueKey),
      timestamp: new Date().toISOString(),
    });
  });

  test('(4c) tokenised search + status filter + issueType filter combined', async ({ request }) => {
    // q=fix (matches SEARCH-4 "Fix payment gateway timeout")
    // + status=Open (SEARCH-1, SEARCH-4)
    // + issueType=Bug (SEARCH-1, SEARCH-4)
    // SEARCH-4 has "fix" + Open + Bug → matches all three
    // SEARCH-1 "Login bug on mobile" has no "fix" token → excluded by search
    const res = await request.get(
      projectUrl(handle.baseUrl, { q: 'fix', status: 'Open', issueType: 'Bug' }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: Array<{ issueKey: string }>; total: number };

    expect(body.total).toBe(1);
    expect(body.issues[0].issueKey).toBe('SEARCH-4');

    saveEvidence('scenario4c-combined-search-plus-filters.json', {
      description: 'Combined: q=fix + status=Open + issueType=Bug → only SEARCH-4',
      scenario: '4c',
      query: 'fix',
      filters: { status: 'Open', issueType: 'Bug' },
      total: body.total,
      issueKeys: body.issues.map((i) => i.issueKey),
      timestamp: new Date().toISOString(),
    });
  });

  test('(4d) triple-filter intersection yields empty when no issue matches all', async ({ request }) => {
    // status=Done + issueType=Bug — no Done Bug issues in seed → 0 results
    const res = await request.get(
      projectUrl(handle.baseUrl, { status: 'Done', issueType: 'Bug' }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { issues: unknown[]; total: number };

    expect(body.total).toBe(0);
    expect(body.issues).toHaveLength(0);

    saveEvidence('scenario4d-combined-empty-intersection.json', {
      description: 'Combined: status=Done + issueType=Bug → empty (no Done Bugs in seed)',
      scenario: '4d',
      filters: { status: 'Done', issueType: 'Bug' },
      total: body.total,
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 — Invalid date range: API returns 400
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 5: Invalid date range → 400 + UI error state', () => {
  const PORT = 16040;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(5a) updatedFrom=not-a-date returns HTTP 400 with error body', async ({ request }) => {
    const res = await request.get(
      projectUrl(handle.baseUrl, { updatedFrom: 'not-a-date' }),
    );
    expect(res.status()).toBe(400);

    const body = await res.json() as {
      error: string;
      field: string;
      message: string;
    };

    expect(body.error).toBe('invalid_date');
    expect(body.field).toBe('updatedFrom');
    expect(typeof body.message).toBe('string');

    saveEvidence('scenario5a-invalid-updated-from.json', {
      description: 'Invalid updatedFrom date: API returns 400 invalid_date (UI surfaces error state)',
      scenario: '5a',
      invalidParam: { updatedFrom: 'not-a-date' },
      response: { status: res.status(), body },
      uiErrorState: 'ProjectInventorySearch renders data-testid="project-search-error" row on HTTP error',
      assertions: [
        'status === 400',
        'body.error === "invalid_date"',
        'body.field === "updatedFrom"',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  test('(5b) updatedTo=bad-date-value returns HTTP 400 with error body', async ({ request }) => {
    const res = await request.get(
      projectUrl(handle.baseUrl, { updatedTo: 'bad-date-value' }),
    );
    expect(res.status()).toBe(400);

    const body = await res.json() as { error: string; field: string };

    expect(body.error).toBe('invalid_date');
    expect(body.field).toBe('updatedTo');

    saveEvidence('scenario5b-invalid-updated-to.json', {
      description: 'Invalid updatedTo date: API returns 400 invalid_date',
      scenario: '5b',
      invalidParam: { updatedTo: 'bad-date-value' },
      response: { status: res.status(), body },
      timestamp: new Date().toISOString(),
    });
  });

  test('(5c) both dates valid (ISO 8601) returns 200 OK', async ({ request }) => {
    // Verify the happy path is not accidentally blocked
    const res = await request.get(
      projectUrl(handle.baseUrl, {
        updatedFrom: '2026-03-01',
        updatedTo: '2026-03-31',
      }),
    );
    expect(res.status()).toBe(200);

    const body = await res.json() as { total: number };
    // All 5 issues fall within 2026-03-01 to 2026-03-31
    expect(body.total).toBe(5);

    saveEvidence('scenario5c-valid-date-range.json', {
      description: 'Valid ISO 8601 date range returns 200 and narrows results correctly',
      scenario: '5c',
      params: { updatedFrom: '2026-03-01', updatedTo: '2026-03-31' },
      total: body.total,
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6 — Clear-all resets to unfiltered state
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 6: Clear-all resets to unfiltered state', () => {
  const PORT = 16050;
  let handle: ServerHandle;

  test.beforeAll(async () => {
    handle = await buildSearchTestServer(PORT);
  });

  test.afterAll(async () => handle.stop());

  test('(6a) after filtered request, unfiltered request returns all 5 issues', async ({ request }) => {
    // Step 1: Apply a filter (simulate user applying filters)
    const filteredRes = await request.get(
      projectUrl(handle.baseUrl, { status: 'Open' }),
    );
    expect(filteredRes.status()).toBe(200);
    const filteredBody = await filteredRes.json() as { total: number };
    expect(filteredBody.total).toBe(2); // Only Open issues

    // Step 2: Clear all filters (simulate "Clear all" button — sends no filter params)
    const clearedRes = await request.get(projectUrl(handle.baseUrl));
    expect(clearedRes.status()).toBe(200);
    const clearedBody = await clearedRes.json() as {
      issues: Array<{ issueKey: string }>;
      total: number;
    };

    expect(clearedBody.total).toBe(5); // All issues returned
    expect(clearedBody.issues).toHaveLength(5);

    const allKeys = clearedBody.issues.map((i) => i.issueKey).sort();
    expect(allKeys).toEqual(['SEARCH-1', 'SEARCH-2', 'SEARCH-3', 'SEARCH-4', 'SEARCH-5']);

    saveEvidence('scenario6a-clear-all-resets-state.json', {
      description: 'Clear-all: removing all filter params resets table to full unfiltered 5-issue result set',
      scenario: '6a',
      steps: [
        { action: 'apply status=Open filter', total: filteredBody.total, expected: 2 },
        { action: 'clear all filters (no filter params)', total: clearedBody.total, expected: 5 },
      ],
      uiComponent: 'ProjectInventorySearch — "Clear all" button fires clearAllFilters() → setFilters(EMPTY_FILTERS) → re-fetch without filter params',
      clearedIssueKeys: allKeys,
      assertions: [
        'filtered total === 2 (only Open issues)',
        'cleared total === 5 (all issues returned)',
        'all 5 issue keys present after clear',
      ],
      timestamp: new Date().toISOString(),
    });
  });

  test('(6b) removing individual filter returns broader result set', async ({ request }) => {
    // Combined: status=Open + issueType=Bug = 2 results
    const combined = await request.get(
      projectUrl(handle.baseUrl, { status: 'Open', issueType: 'Bug' }),
    );
    const combinedBody = await combined.json() as { total: number };
    expect(combinedBody.total).toBe(2);

    // Remove issueType filter (keep status=Open only)
    const oneFilter = await request.get(projectUrl(handle.baseUrl, { status: 'Open' }));
    const oneBody = await oneFilter.json() as { total: number };
    // Still 2 — both Open issues are also Bugs in this seed
    expect(oneBody.total).toBe(2);

    // Remove status filter too (clear all)
    const noFilter = await request.get(projectUrl(handle.baseUrl));
    const noBody = await noFilter.json() as { total: number };
    expect(noBody.total).toBe(5);

    saveEvidence('scenario6b-incremental-filter-removal.json', {
      description: 'Incrementally removing filters broadens results back to full set',
      scenario: '6b',
      steps: [
        { filters: 'status=Open + issueType=Bug', total: combinedBody.total },
        { filters: 'status=Open only', total: oneBody.total },
        { filters: 'none (clear all)', total: noBody.total },
      ],
      timestamp: new Date().toISOString(),
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7 — [inventory-search] log line emitted per query
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 — Scenario 7: [inventory-search] log line capture', () => {
  const PORT = 16060;

  /**
   * This test creates its own server instance with log interception wired
   * directly into the Express app's lifecycle.  Because the server runs in
   * the same Node.js process as the Playwright runner we can temporarily
   * replace console.log to capture lines emitted by the router handler.
   */

  test('(7a) [inventory-search] log line emitted on every project-issues request', async ({ request }) => {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    BackupPointRepository.migrate(db);

    const repo = new BackupPointRepository(db);

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint10-log-'));
    const issueDir = path.join(backupDir, BP_ID, 'issues');
    fs.mkdirSync(issueDir, { recursive: true });

    // Write minimal issue JSON files
    for (const issue of SEED_ISSUES) {
      fs.writeFileSync(
        path.join(issueDir, `${issue.objectId}.json`),
        JSON.stringify({
          fields: {
            summary: issue.summary,
            status: { name: issue.status },
          },
        }),
        'utf8',
      );
    }

    const writer = new BackupPointManifestWriter(repo, {
      backupPointId: BP_ID,
      cloudId: CLOUD_ID,
      siteUrl: SITE_URL,
      scopeMode: 'all',
    });
    for (const issue of SEED_ISSUES) {
      writer.append({
        id: `entry-log-${issue.objectId.toLowerCase()}`,
        backupPointId: BP_ID,
        objectType: 'JiraIssue',
        objectId: issue.objectId,
        capturedAt: Date.now(),
        sourceEndpoint: '/rest/api/3/search/jql',
        status: 'ok',
      });
    }

    const app = express();
    app.use(express.json());
    const inventoryRouter = createInventoryRouter(repo, {
      allowUnauthenticated: true,
      backupDir,
    });
    app.use('/api', inventoryRouter);

    const capturedLines: string[] = [];
    const origLog = console.log;

    const srv = http.createServer(app);
    await new Promise<void>((resolve) => srv.listen(PORT, () => resolve()));

    const baseUrl = `http://localhost:${PORT}`;

    try {
      // ── Request 1: no-filter query (tokenised mode, 0 filters) ──────────────
      console.log = (...args: unknown[]) => {
        capturedLines.push(args.join(' '));
        origLog(...args);
      };

      await request.get(
        new URL(
          `/api/inventory/projects/${PROJECT_KEY}/issues?cloudId=${CLOUD_ID}`,
          baseUrl,
        ).toString(),
      );

      const noFilterLog = capturedLines.find((l) => l.includes('[inventory-search]'));
      expect(noFilterLog).toBeDefined();
      expect(noFilterLog).toContain(`project=${PROJECT_KEY}`);
      expect(noFilterLog).toContain('mode=');
      expect(noFilterLog).toContain('filters=0');
      expect(noFilterLog).toContain('hits=5');

      capturedLines.length = 0;

      // ── Request 2: exact-match query ─────────────────────────────────────────
      await request.get(
        new URL(
          `/api/inventory/projects/${PROJECT_KEY}/issues?cloudId=${CLOUD_ID}&q=SEARCH-1`,
          baseUrl,
        ).toString(),
      );

      const exactLog = capturedLines.find((l) => l.includes('[inventory-search]'));
      expect(exactLog).toBeDefined();
      expect(exactLog).toContain('mode=exact');
      expect(exactLog).toContain('hits=1');

      capturedLines.length = 0;

      // ── Request 3: tokenised query with filter ────────────────────────────────
      await request.get(
        new URL(
          `/api/inventory/projects/${PROJECT_KEY}/issues?cloudId=${CLOUD_ID}&q=login&status=Open`,
          baseUrl,
        ).toString(),
      );

      const tokenisedLog = capturedLines.find((l) => l.includes('[inventory-search]'));
      expect(tokenisedLog).toBeDefined();
      expect(tokenisedLog).toContain('mode=tokenised');
      expect(tokenisedLog).toContain('filters=1');
      // "login" in summary + status=Open → only SEARCH-1 ("Login bug on mobile", Open)
      expect(tokenisedLog).toContain('hits=1');

      saveEvidence('scenario7a-inventory-search-log-capture.json', {
        description: '[inventory-search] log line emitted on every project-issues request with correct fields',
        scenario: '7a',
        logLineFormat: '[inventory-search] project=<key> mode=<exact|tokenised> filters=<n> hits=<n>',
        capturedLogLines: {
          noFilter: noFilterLog,
          exactMatch: exactLog,
          tokenisedWithFilter: tokenisedLog,
        },
        assertions: [
          '[inventory-search] prefix present on every request',
          'project=SEARCH in all lines',
          'mode=tokenised for non-issueKey queries',
          'mode=exact for issueKey pattern queries',
          'filters=0 when no filter params supplied',
          'filters=1 when one filter param supplied',
          'hits=5 for unfiltered full set',
          'hits=1 for exact SEARCH-1 query',
        ],
        timestamp: new Date().toISOString(),
      });
    } finally {
      console.log = origLog;
      await new Promise<void>((res, rej) =>
        srv.close((err) => {
          db.close();
          fs.rmSync(backupDir, { recursive: true, force: true });
          err ? rej(err) : res();
        }),
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evidence manifest summary
// ─────────────────────────────────────────────────────────────────────────────

test.describe('Sprint 10 evidence manifest', () => {
  test('all evidence files were written to tests/integration/project-inventory-search/evidence/', async () => {
    const expectedFiles = [
      'scenario1a-exact-match.json',
      'scenario1b-exact-match-case-insensitive.json',
      'scenario1c-exact-match-no-result.json',
      'scenario2a-tokenised-login-bug.json',
      'scenario2b-tokenised-single-login.json',
      'scenario2c-tokenised-case-insensitive.json',
      'scenario3a-filter-status.json',
      'scenario3b-filter-issue-type.json',
      'scenario3c-filter-priority.json',
      'scenario3d-filter-assignee.json',
      'scenario3e-single-label.json',
      'scenario3e-multi-label.json',
      'scenario3f-filter-date-range.json',
      'scenario4a-combined-status-type.json',
      'scenario4b-combined-priority-assignee.json',
      'scenario4c-combined-search-plus-filters.json',
      'scenario4d-combined-empty-intersection.json',
      'scenario5a-invalid-updated-from.json',
      'scenario5b-invalid-updated-to.json',
      'scenario5c-valid-date-range.json',
      'scenario6a-clear-all-resets-state.json',
      'scenario6b-incremental-filter-removal.json',
      'scenario7a-inventory-search-log-capture.json',
    ];

    for (const filename of expectedFiles) {
      const filepath = path.join(EVIDENCE_DIR, filename);
      expect(fs.existsSync(filepath)).toBe(true);
    }

    const artefacts = expectedFiles.map((filename) => {
      const filepath = path.join(EVIDENCE_DIR, filename);
      const content = JSON.parse(fs.readFileSync(filepath, 'utf8')) as {
        description: string;
        scenario: string;
        assertions?: string[];
        timestamp: string;
      };
      return {
        file: filename,
        scenario: content.scenario,
        description: content.description,
        assertions: content.assertions ?? '(see file)',
        capturedAt: content.timestamp,
      };
    });

    saveEvidence('_manifest.json', {
      sprint: 'Sprint 10 — Project Inventory Search, Filters & Phase Wrap',
      generatedAt: new Date().toISOString(),
      totalArtefacts: artefacts.length,
      dodCoverage: [
        'Exact-match: valid issueKey query returns exactly that single row',
        'Exact-match: case-insensitive (search-1 finds SEARCH-1)',
        'Tokenised: "login bug" (AND) returns only SEARCH-1 — only issue with both tokens in summary',
        'Tokenised: single token "login" returns all matching summaries',
        'Tokenised: case-insensitive (uppercase tokens match same results)',
        'Filter status: status=Open narrows to 2 issues',
        'Filter issueType: issueType=Bug narrows to 2 issues',
        'Filter priority: priority=High narrows to 2 issues',
        'Filter assigneeAccountId: acc-alice returns 2 issues',
        'Filter labels (single): urgent returns 2 issues',
        'Filter labels (multi/AND): urgent+payment returns 1 issue only',
        'Filter date range: updatedFrom+updatedTo returns only in-range issues',
        'Combined: status=Open + issueType=Bug ANDs correctly',
        'Combined: priority + assignee intersection yields single issue',
        'Combined: tokenised q + two filters combined',
        'Combined: incompatible filter combo returns empty set',
        'Invalid date: updatedFrom=not-a-date returns HTTP 400 (UI surfaces error state)',
        'Invalid date: updatedTo=bad-date-value returns HTTP 400',
        'Valid date range returns 200 with correct results',
        'Clear-all: no-filter request after filtered request returns full 5-issue set',
        'Incremental filter removal broadens result set back to full',
        '[inventory-search] log line emitted per request with project/mode/filters/hits fields',
      ],
      seedFixture: {
        projectKey: PROJECT_KEY,
        cloudId: CLOUD_ID,
        backupPointId: BP_ID,
        issues: SEED_ISSUES.map((i) => ({
          objectId: i.objectId,
          summary: i.summary,
          status: i.status,
          issueType: i.issueType,
          priority: i.priority,
          assigneeAccountId: i.assignee.accountId,
          labels: [...i.labels],
          updated: i.updated,
        })),
      },
      artefacts,
    });

    expect(artefacts).toHaveLength(expectedFiles.length);
  });
});

# Sprint 17 — Pre-flight Codebase Inventory

_Generated: 2026-05-03 | Role: QA Engineer | Purpose: Source of truth for tasks 2-6_

This document is produced by walking the actual codebase. Every finding is backed by a
file:line quote. Nothing is invented. Tasks 2-6 MUST derive their port numbers, env-var
names, and volume paths from this document — not from INSTALL.md aspirational content.

---

## 1. Package Entry Point and npm Scripts

**File:** `package.json`

### 1.1 Entry point

```json
// package.json — no "main" field present
// no "scripts.start" present
```

**Finding:** There is **no `main` field** and **no `start` script** in `package.json`.
INSTALL.md §2.5 documents `node dist/server.js` as the run command, but this file does not
exist in the repository at the time of this inventory — `src/server.ts` is absent from
`src/`. Task 2 (Backend Dockerfile + /health endpoint) must create `src/server.ts` before
`npm run build` can produce `dist/server.js`.

### 1.2 All npm scripts (package.json lines 6–13)

| Script | Command |
|--------|---------|
| `build` | `bash scripts/check-deprecated-endpoint.sh && tsc` |
| `lint:deprecated` | `bash scripts/check-deprecated-endpoint.sh` |
| `test` | `jest` |
| `test:watch` | `jest --watch` |
| `test:e2e` | `playwright test` |
| `test:e2e:report` | `playwright show-report e2e/results/html-report` |

**Quoted evidence (package.json:6–12):**
```json
"scripts": {
  "build": "bash scripts/check-deprecated-endpoint.sh && tsc",
  "lint:deprecated": "bash scripts/check-deprecated-endpoint.sh",
  "test": "jest",
  "test:watch": "jest --watch",
  "test:e2e": "playwright test",
  "test:e2e:report": "playwright show-report e2e/results/html-report"
}
```

---

## 2. Server Port — `.listen(` Calls

**grep command:** `grep -rn '\.listen(' src/`

**Finding: NO `.listen(` calls exist anywhere under `src/`.**

The only `.listen(` in the repository is in the test harness:
- `e2e/support/test-server.ts:262` — `server.listen(port, () => {`

This is a test-only mock server used by Playwright E2E tests. It is **not** the production
server.

### Implication for Tasks 2-3

Because `src/server.ts` does not yet exist, the production port is **not currently
hard-coded anywhere in src/**. Based on INSTALL.md §2.4 and §3.3:

- INSTALL.md §2.4, line 95: `| PORT | HTTP/HTTPS port the backend listens on | 3000 |`
- INSTALL.md §3.2, line 151: `podman build -t jira-backup-app:latest .`
- INSTALL.md §3.4, line 182: `reverse_proxy jira-backup-app:3000`

**Prescribed port:** `3000` (from `PORT` env var; default `3000`).

Task 2 must create `src/server.ts` with `const port = parseInt(process.env.PORT ?? '3000', 10)`.
Task 3 must expose port `3000` in `podman-compose.yml` and use `PORT=3000` in the env.

---

## 3. All `process.env.*` References in `src/`

**grep command:** `grep -rn 'process\.env\.' src/ --include='*.ts'`

### 3.1 Vars actually read in src/ today

All six references are in a single file: `src/fault-injection/FaultInjectionConfig.ts`

| Variable | File:Line | Context |
|----------|-----------|---------|
| `NODE_ENV` | `FaultInjectionConfig.ts:80` | Production hard-gate |
| `NODE_ENV` | `FaultInjectionConfig.ts:133` | Production hard-gate |
| `NODE_ENV` | `FaultInjectionConfig.ts:144` | Production hard-gate |
| `FAULT_SUSPEND_HEARTBEAT_MS` | `FaultInjectionConfig.ts:84` | Fault injection: heartbeat suspend duration (ms) |
| `FAULT_ATTACHMENT_ERROR_RATE` | `FaultInjectionConfig.ts:85` | Fault injection: attachment error simulation rate (float 0–1) |
| `FAULT_HALT_RESTORE_PHASE` | `FaultInjectionConfig.ts:86` | Fault injection: restore phase to halt (string or null) |

**Quoted evidence (FaultInjectionConfig.ts:80–86):**
```typescript
if (process.env.NODE_ENV === 'production') {
  return { ...NO_FAULT_INJECTION };
}

const rawSuspend = process.env.FAULT_SUSPEND_HEARTBEAT_MS;
const rawRate    = process.env.FAULT_ATTACHMENT_ERROR_RATE;
const rawPhase   = process.env.FAULT_HALT_RESTORE_PHASE ?? null;
```

**Unique env var names (4):**
1. `NODE_ENV`
2. `FAULT_SUSPEND_HEARTBEAT_MS`
3. `FAULT_ATTACHMENT_ERROR_RATE`
4. `FAULT_HALT_RESTORE_PHASE`

### 3.2 Vars required by INSTALL.md but NOT yet read in src/

These vars are documented in INSTALL.md §2.4 and §3.3 but are not referenced by any
current `process.env.*` call in `src/`. They will be needed by the `src/server.ts` file
that Task 2 creates.

| Variable | Purpose | INSTALL.md ref |
|----------|---------|----------------|
| `JIRA_OAUTH_CLIENT_ID` | OAuth app Client ID | §2.4 line 89 |
| `JIRA_OAUTH_CLIENT_SECRET` | OAuth app Client Secret | §2.4 line 90 |
| `OAUTH_REDIRECT_URI` | OAuth callback URL | §2.4 line 91 |
| `DATABASE_URL` | Path to SQLite database | §2.4 line 92 |
| `TLS_CERT` | Path to mkcert certificate | §2.4 line 93 |
| `TLS_KEY` | Path to mkcert private key | §2.4 line 94 |
| `PORT` | Server listen port (default 3000) | §2.4 line 95 |
| `LOG_LEVEL` | Log verbosity (default `info`) | §2.4 line 101 |
| `HEARTBEAT_INTERVAL_MS` | Heartbeat interval ms (default `8000`) | §2.4 line 102 |
| `STALL_THRESHOLD_MS` | Stall threshold ms (default `20000`) | §2.4 line 103 |

**Total env vars for `.env.example`:** 14 (4 from src/ today + 10 from INSTALL.md pending
`src/server.ts` creation). `NODE_ENV` is a standard runtime var — include it.

---

## 4. TypeScript Build Configuration

**File:** `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Key facts for Task 2 (Dockerfile):**
- `npm run build` compiles `src/**/*.ts` → `dist/`
- Entry point after build: `dist/server.js` (once `src/server.ts` is created)
- Node version target: Node 20 (per `package.json` dev dependency `@types/node: ^20.14.0`)

---

## 5. Existing Infrastructure Files Audit

**Finding: NONE of the container infrastructure files exist yet.**

| File | Expected by INSTALL.md | Exists? |
|------|------------------------|---------|
| `Dockerfile` | §3.1–3.2 | **NO** |
| `podman-compose.yml` | §3.2 | **NO** |
| `docker-compose.yml` | §3.2 | **NO** |
| `.env.example` | §2.4 | **NO** |
| `.env` | §2.4 | **NO** |
| `Caddyfile` | §3.4 | **NO** |
| `Caddyfile.example` | (implied) | **NO** |
| `start.sh` | README.md Quick Start | **NO** |
| `start.ps1` | README.md Quick Start | **NO** |
| `start.bat` | README.md Quick Start | **NO** |
| `src/server.ts` | (implied by dist/server.js) | **NO** |

**Files that DO exist at root:**
- `.gitignore` (85 bytes)
- `tsconfig.json`
- `package.json`
- `jest.config.js`
- `playwright.config.ts`

---

## 6. Database Path and Volume Layout

From `db/migrations/001_jira_credentials.sql` and INSTALL.md §4.2:
- Default database path: `data/jira.db` (relative to project root / container workdir)
- Attachment blobs: implied at `attachments/` (from INSTALL.md §3.5 volume `jira-attachments: /attachments`)

**Implication for Task 3 (podman-compose.yml):**
- Mount named volume `jira-data` → `/data` inside container
- Mount named volume `jira-attachments` → `/attachments` inside container
- Set `DATABASE_URL=/data/jira.db` as default in compose env

---

## 7. .gitignore — Current Contents

**File:** `.gitignore` (complete)

```gitignore
node_modules/
dist/
data/
*.pem
```

**Implication for Tasks 4-5:**
- `.env` is NOT yet in `.gitignore` — Task 5 must add it
- `Caddyfile` (without `.example`) is NOT yet in `.gitignore` — Task 4 must add it
- `data/` is already excluded (good — prevents committing SQLite DB)
- `*.pem` is already excluded (good — prevents committing mkcert certs)

---

## 8. Summary for Tasks 2-6

| Task | Key fact from this inventory |
|------|------------------------------|
| Task 2 — Dockerfile | No `src/server.ts` exists yet; must be created. Port: `process.env.PORT ?? 3000`. Use Node 20 multi-stage. Entry: `node dist/server.js`. |
| Task 3 — podman-compose.yml | Port 3000. Volumes: `jira-data:/data`, `jira-attachments:/attachments`. No existing compose file to migrate. |
| Task 4 — Caddyfile.example | Reverse proxy to `backend:3000`. Use `local_certs` for localhost:4443. Add `Caddyfile` to `.gitignore`. |
| Task 5 — .env.example | 14 env vars total (see §3.1 and §3.2 tables). Add `.env` to `.gitignore`. |
| Task 6 — start.sh | No existing start.sh. Must auto-cp Caddyfile.example and .env.example, then `podman-compose up -d`. |

@echo off
REM start.bat -- One-command stack launcher for jira_workload_2 (Windows CMD).
REM
REM What it does:
REM   1. Auto-copies Caddyfile.example -> Caddyfile if the live config is missing
REM   2. Auto-copies .env.example -> .env if credentials file is missing (warns to edit)
REM   3. Starts the stack via podman-compose (falls back to docker compose)
REM   4. Prints the app URL and next steps
REM
REM Sources:
REM   - Port 4443:  Caddyfile.example -- localhost:4443 { tls internal ... }
REM   - Services:   podman-compose.yml -- backend + caddy
REM   - Env file:   .env.example (copy to .env before real use)

setlocal enabledelayedexpansion
cd /d "%~dp0"

REM ── 1. Caddyfile ─────────────────────────────────────────────────────────────
if not exist "Caddyfile" (
    if exist "Caddyfile.example" (
        copy /Y "Caddyfile.example" "Caddyfile" >nul
        echo [start.bat] Caddyfile created from Caddyfile.example.
    ) else (
        echo [start.bat] ERROR: Caddyfile.example not found. Cannot create Caddyfile. 1>&2
        exit /b 1
    )
)

REM ── 2. .env ──────────────────────────────────────────────────────────────────
if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo.
        echo   +---------------------------------------------------------+
        echo   ^|  WARNING: .env was just created from .env.example.      ^|
        echo   ^|  Edit .env and set JIRA_OAUTH_CLIENT_ID,                ^|
        echo   ^|  JIRA_OAUTH_CLIENT_SECRET, and OAUTH_REDIRECT_URI       ^|
        echo   ^|  before the OAuth flow will work.                       ^|
        echo   +---------------------------------------------------------+
        echo.
    ) else (
        echo [start.bat] ERROR: .env.example not found. Cannot create .env. 1>&2
        exit /b 1
    )
)

REM ── 3. Compose up ────────────────────────────────────────────────────────────
set COMPOSE_CMD=
where podman-compose >nul 2>&1
if %errorlevel%==0 (
    set COMPOSE_CMD=podman-compose
) else (
    where docker >nul 2>&1
    if %errorlevel%==0 (
        set COMPOSE_CMD=docker compose
    ) else (
        echo [start.bat] ERROR: Neither podman-compose nor docker compose found. 1>&2
        exit /b 1
    )
)

echo [start.bat] Starting stack with: %COMPOSE_CMD% up -d
%COMPOSE_CMD% up -d

REM ── 4. Summary ───────────────────────────────────────────────────────────────
echo.
echo   Stack is up. Open your browser at:
echo.
echo     https://localhost:4443
echo.
echo   Next steps:
echo     1. Navigate to the Jira connector and click Connect to begin OAuth.
echo     2. Check logs: %COMPOSE_CMD% logs -f backend
echo     3. To stop: %COMPOSE_CMD% down
echo.

endlocal

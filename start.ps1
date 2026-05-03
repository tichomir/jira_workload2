# start.ps1 — One-command stack launcher for jira_workload_2 (PowerShell).
#
# What it does:
#   1. Auto-copies Caddyfile.example -> Caddyfile if the live config is missing
#   2. Auto-copies .env.example -> .env if credentials file is missing (warns to edit)
#   3. Starts the stack via podman-compose (falls back to docker compose)
#   4. Prints the app URL and next steps
#
# Sources:
#   - Port 4443:  Caddyfile.example — `localhost:4443 { tls internal ... }`
#   - Services:   podman-compose.yml — backend + caddy
#   - Env file:   .env.example (copy to .env before real use)

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

# ── 1. Caddyfile ──────────────────────────────────────────────────────────────
if (-not (Test-Path "Caddyfile")) {
    if (Test-Path "Caddyfile.example") {
        Copy-Item "Caddyfile.example" "Caddyfile"
        Write-Host "[start.ps1] Caddyfile created from Caddyfile.example."
    } else {
        Write-Error "[start.ps1] ERROR: Caddyfile.example not found. Cannot create Caddyfile."
        exit 1
    }
}

# ── 2. .env ───────────────────────────────────────────────────────────────────
if (-not (Test-Path ".env")) {
    if (Test-Path ".env.example") {
        Copy-Item ".env.example" ".env"
        Write-Host ""
        Write-Host "  +---------------------------------------------------------+"
        Write-Host "  |  WARNING: .env was just created from .env.example.      |"
        Write-Host "  |  Edit .env and set JIRA_OAUTH_CLIENT_ID,                |"
        Write-Host "  |  JIRA_OAUTH_CLIENT_SECRET, and OAUTH_REDIRECT_URI       |"
        Write-Host "  |  before the OAuth flow will work.                       |"
        Write-Host "  +---------------------------------------------------------+"
        Write-Host ""
    } else {
        Write-Error "[start.ps1] ERROR: .env.example not found. Cannot create .env."
        exit 1
    }
}

# ── 3. Compose up ─────────────────────────────────────────────────────────────
$composeCmd = $null
if (Get-Command "podman-compose" -ErrorAction SilentlyContinue) {
    $composeCmd = "podman-compose"
} elseif (Get-Command "docker" -ErrorAction SilentlyContinue) {
    $composeCmd = "docker compose"
} else {
    Write-Error "[start.ps1] ERROR: Neither podman-compose nor docker compose found."
    exit 1
}

Write-Host "[start.ps1] Starting stack with: $composeCmd up -d"
Invoke-Expression "$composeCmd up -d"

# ── 4. Summary ────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Stack is up. Open your browser at:"
Write-Host ""
Write-Host "    https://localhost:4443"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "    1. Navigate to the Jira connector and click Connect to begin OAuth."
Write-Host "    2. Check logs: $composeCmd logs -f backend"
Write-Host "    3. To stop: $composeCmd down"
Write-Host ""

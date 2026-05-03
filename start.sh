#!/usr/bin/env bash
# start.sh — One-command stack launcher for jira_workload_2.
#
# What it does:
#   1. Auto-copies Caddyfile.example → Caddyfile if the live config is missing
#   2. Auto-copies .env.example → .env if credentials file is missing (warns to edit)
#   3. Starts the stack via podman-compose (falls back to docker compose)
#   4. Prints the app URL and next steps
#
# Sources:
#   - Port 4443: Caddyfile.example — `localhost:4443 { tls internal ... }`
#   - Services:  podman-compose.yml — backend + caddy
#   - Env file:  .env.example (copy to .env before real use)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── 1. Caddyfile ──────────────────────────────────────────────────────────────
if [ ! -f "Caddyfile" ]; then
  if [ -f "Caddyfile.example" ]; then
    cp Caddyfile.example Caddyfile
    echo "[start.sh] Caddyfile created from Caddyfile.example."
  else
    echo "[start.sh] ERROR: Caddyfile.example not found. Cannot create Caddyfile." >&2
    exit 1
  fi
fi

# ── 2. .env ───────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    echo ""
    echo "  ┌─────────────────────────────────────────────────────────┐"
    echo "  │  WARNING: .env was just created from .env.example.      │"
    echo "  │  Edit .env and set JIRA_OAUTH_CLIENT_ID,                │"
    echo "  │  JIRA_OAUTH_CLIENT_SECRET, and OAUTH_REDIRECT_URI       │"
    echo "  │  before the OAuth flow will work.                       │"
    echo "  └─────────────────────────────────────────────────────────┘"
    echo ""
  else
    echo "[start.sh] ERROR: .env.example not found. Cannot create .env." >&2
    exit 1
  fi
fi

# ── 3. Compose up ─────────────────────────────────────────────────────────────
if command -v podman-compose &>/dev/null; then
  COMPOSE_CMD="podman-compose"
elif command -v docker &>/dev/null && docker compose version &>/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
else
  echo "[start.sh] ERROR: Neither podman-compose nor 'docker compose' found." >&2
  echo "           Install Podman 4+ or Docker with the Compose plugin." >&2
  exit 1
fi

echo "[start.sh] Starting stack with: $COMPOSE_CMD up -d"
$COMPOSE_CMD up -d

# ── 4. Summary ────────────────────────────────────────────────────────────────
echo ""
echo "  Stack is up. Open your browser at:"
echo ""
echo "    https://localhost:4443"
echo ""
echo "  Next steps:"
echo "    1. Navigate to the Jira connector and click Connect to begin OAuth."
echo "    2. Check logs: $COMPOSE_CMD logs -f backend"
echo "    3. To stop: $COMPOSE_CMD down"
echo ""

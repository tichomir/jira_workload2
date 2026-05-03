#!/usr/bin/env bash
# =============================================================================
# scripts/log-audit.sh — Structured Log Pattern Audit
#
# Reads a NDJSON log stream (or any line-delimited log file) and verifies that
# every required [prefix] pattern appears at least once.  Exits non-zero (CI
# failure) if any required pattern is missing.
#
# Usage:
#   ./scripts/log-audit.sh <log-file>
#   cat app.log | ./scripts/log-audit.sh -
#
# Example (run against test log output):
#   npm test 2>&1 | tee /tmp/test.log && ./scripts/log-audit.sh /tmp/test.log
# =============================================================================

set -euo pipefail

LOG_FILE="${1:-}"
if [[ -z "$LOG_FILE" ]]; then
  echo "Usage: $0 <log-file-or-dash-for-stdin>"
  exit 1
fi

# ---------------------------------------------------------------------------
# Required structured log patterns — one per line.
# Each pattern is a grep ERE (extended regular expression).
# A pattern must match at least one log line for the audit to pass.
# ---------------------------------------------------------------------------

REQUIRED_PATTERNS=(
  # Goal 1 — OAuth authentication
  '\[jira-oauth\] account verified'
  '\[jira-oauth\] token refreshed'

  # Goal 2 — Project discovery
  '\[jira-discovery\].*page.*fetched'

  # Goal 3 — Issue capture (POST /search/jql)
  '\[jira-backup\].*search/jql'

  # Goal 4 — Attachment download
  '\[jira-backup\].*attachment downloaded'

  # Goal 5 — Context-node capture pipeline ordering
  '\[jira-backup\].*context.*pipeline'

  # Goal 6 — Restore phase execution
  '\[jira-restore\].*phase'

  # Goal 7 — Token rotation
  '\[jira-oauth\].*token.*refresh'

  # Goal 8 — Pagination termination
  '\[jira-backup\].*pagination.*terminated'

  # Goal 9 — Custom field context (custom:true gating)
  '\[jira-backup\].*custom-field context'

  # Goal 10 — SDI scan result
  '\[jira-sdi\]'

  # Goal 11 — Inventory manifest
  '\[jira-inventory\]'

  # Goal 12 — Restore job created
  '\[jira-restore\].*job\.created'

  # Goal 13 — Heartbeat and stall detection
  '\[jira-restore\].*job\.heartbeat'
  '\[jira-backup\].*heartbeat'
)

# ---------------------------------------------------------------------------
# Read log source
# ---------------------------------------------------------------------------

if [[ "$LOG_FILE" == "-" ]]; then
  LOG_CONTENT=$(cat)
else
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "ERROR: log file not found: $LOG_FILE"
    exit 1
  fi
  LOG_CONTENT=$(cat "$LOG_FILE")
fi

TOTAL_LINES=$(echo "$LOG_CONTENT" | wc -l | tr -d ' ')
echo ""
echo "=== Jira Workload-2 Structured Log Audit ==="
echo "Log source : ${LOG_FILE}"
echo "Total lines: ${TOTAL_LINES}"
echo ""

# ---------------------------------------------------------------------------
# Check each pattern
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
MISSING=()

for pattern in "${REQUIRED_PATTERNS[@]}"; do
  if echo "$LOG_CONTENT" | grep -qE "$pattern"; then
    MATCH=$(echo "$LOG_CONTENT" | grep -Em1 "$pattern" | head -c 120)
    printf "  ✓  %-55s  %s\n" "$pattern" "→ ${MATCH}"
    (( PASS += 1 ))
  else
    printf "  ✗  %-55s  MISSING\n" "$pattern"
    MISSING+=("$pattern")
    (( FAIL += 1 ))
  fi
done

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed out of ${#REQUIRED_PATTERNS[@]} patterns"
echo ""

# ---------------------------------------------------------------------------
# Write audit report as JSON (for CI artifact collection)
# ---------------------------------------------------------------------------

REPORT_DIR="tests/integration/prd-signal-assertions/evidence"
mkdir -p "$REPORT_DIR"
REPORT_FILE="$REPORT_DIR/log-audit-report.json"

# Build JSON report
python3 - <<PYEOF > "$REPORT_FILE"
import json, sys, datetime

patterns = $(printf '"%s",' "${REQUIRED_PATTERNS[@]}" | sed 's/,$//')
# Convert bash array to Python list safely
patterns_raw = """${REQUIRED_PATTERNS[*]}"""
pattern_list = [p.strip() for p in patterns_raw.split('\n') if p.strip()]

missing = """${MISSING[*]:-}"""
missing_list = [m.strip() for m in missing.split('\n') if m.strip()] if missing.strip() else []

report = {
    "generatedAt": datetime.datetime.utcnow().isoformat() + "Z",
    "logSource": "${LOG_FILE}",
    "totalLogLines": ${TOTAL_LINES},
    "totalPatterns": len(pattern_list),
    "passed": ${PASS},
    "failed": ${FAIL},
    "missingPatterns": missing_list,
    "status": "PASS" if ${FAIL} == 0 else "FAIL"
}
print(json.dumps(report, indent=2))
PYEOF

echo "Audit report written to: ${REPORT_FILE}"

# ---------------------------------------------------------------------------
# Exit code
# ---------------------------------------------------------------------------

if [[ ${FAIL} -gt 0 ]]; then
  echo ""
  echo "AUDIT FAILED — ${FAIL} required log pattern(s) missing:"
  for p in "${MISSING[@]}"; do
    echo "  - $p"
  done
  echo ""
  echo "Fix: ensure the application emits these structured log lines and re-run."
  exit 1
fi

echo "AUDIT PASSED — all ${PASS} required log patterns found."
exit 0

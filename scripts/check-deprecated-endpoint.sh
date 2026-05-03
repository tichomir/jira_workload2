#!/usr/bin/env bash
# check-deprecated-endpoint.sh
#
# CI lint gate: fail the build if the deprecated GET /rest/api/3/search
# endpoint appears anywhere in src/. The required endpoint is POST
# /rest/api/3/search/jql — see PRD Goal 8 and T2 §6 Constraint 6.
#
# Usage: bash scripts/check-deprecated-endpoint.sh
# Exit code: 0 = clean, 1 = violation found.

set -euo pipefail

SEARCH_DIR="${1:-src}"
PATTERN="/rest/api/3/search['\"]"

echo "[lint] Scanning ${SEARCH_DIR}/ for deprecated GET /rest/api/3/search endpoint..."

# grep returns exit 1 when no matches found (that's the GOOD case here)
if grep -rn --include="*.ts" "${PATTERN}" "${SEARCH_DIR}"; then
  echo ""
  echo "[lint] ERROR: Deprecated endpoint found. Use POST /rest/api/3/search/jql instead."
  echo "[lint] See PRD Goal 8 and T2 §6 Constraint 6."
  exit 1
else
  echo "[lint] OK — no deprecated GET /rest/api/3/search endpoint found in ${SEARCH_DIR}/."
  exit 0
fi

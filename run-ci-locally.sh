#!/usr/bin/env bash
#
# Local mirror of .github/workflows/e2e-tests.yml so you can reproduce
# a CI run on your own machine before pushing. Designed for Git Bash on
# Windows but works on macOS/Linux too.
#
# Usage:
#   ./run-ci-locally.sh                    # run all stages
#   ./run-ci-locally.sh --skip-install     # skip npm ci (faster re-runs)
#   ./run-ci-locally.sh --skip-e2e        # type-check + build only
#
# Exit codes: non-zero if any stage fails (same semantics as CI).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Args ─────────────────────────────────────────────────────────────────
SKIP_INSTALL=false
SKIP_E2E=false
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=true ;;
    --skip-e2e)     SKIP_E2E=true ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ── Pretty banner helpers ────────────────────────────────────────────────
BLUE='\033[1;34m'; GREEN='\033[1;32m'; RED='\033[1;31m'; DIM='\033[2m'; OFF='\033[0m'
step() { printf "\n${BLUE}━━━ %s ━━━${OFF}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${OFF}\n" "$1"; }
die()  { printf "${RED}✗ %s${OFF}\n" "$1" >&2; cleanup; exit 1; }

# ── Background backend lifecycle ─────────────────────────────────────────
BACKEND_PID=""
cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    printf "${DIM}stopping backend (pid %s)...${OFF}\n" "$BACKEND_PID"
    # On Git Bash, plain `kill` sends SIGTERM which tsx forwards correctly.
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# ── 1. Install ───────────────────────────────────────────────────────────
if [[ "$SKIP_INSTALL" == "false" ]]; then
  step "Installing frontend deps"
  npm ci
  ok "frontend deps installed"

  step "Installing backend deps"
  ( cd backend && npm ci )
  ok "backend deps installed"
else
  step "Skipping install (--skip-install)"
fi

# ── 2. Type-check ────────────────────────────────────────────────────────
step "Type-checking frontend"
npx tsc --noEmit || die "frontend type-check failed"
ok "frontend type-check"

step "Type-checking backend"
( cd backend && npx tsc --noEmit ) || die "backend type-check failed"
ok "backend type-check"

# ── 3. Build frontend ────────────────────────────────────────────────────
step "Building frontend"
npm run build > /dev/null || die "frontend build failed"
ok "build → ./dist"

# Optional skip
if [[ "$SKIP_E2E" == "true" ]]; then
  step "Skipping E2E (--skip-e2e)"
  ok "Local CI run complete"
  exit 0
fi

# ── 4. Playwright browsers ───────────────────────────────────────────────
step "Ensuring Playwright Chromium is installed"
npx playwright install chromium > /dev/null
ok "chromium ready"

# ── 5. Start backend + wait for /api/health ──────────────────────────────
step "Starting backend"
( cd backend && CI=true npx tsx server.ts > ../backend.log 2>&1 ) &
BACKEND_PID=$!
printf "${DIM}backend pid: %s — waiting for /api/health...${OFF}\n" "$BACKEND_PID"

READY=false
for i in $(seq 1 30); do
  if curl -sf http://localhost:3001/api/health > /dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 1
done
if [[ "$READY" == "false" ]]; then
  echo "----- backend.log (last 40 lines) -----" >&2
  tail -n 40 backend.log >&2 || true
  die "backend never became ready"
fi
ok "backend ready"

# ── 6. Run tests ─────────────────────────────────────────────────────────
step "Running Playwright tests"
if find tests -type f \( -name "*.spec.ts" -o -name "*.spec.js" \) 2>/dev/null | grep -q .; then
  CI=true npx playwright test || die "Playwright tests failed"
  ok "all Playwright tests passed"
else
  printf "${DIM}no spec files in tests/ — nothing to run${OFF}\n"
fi

# ── Done ─────────────────────────────────────────────────────────────────
step "Summary"
ok "Local CI run complete"
echo "  HTML report : ./playwright-report/index.html"
echo "  Raw artifacts: ./test-results/"

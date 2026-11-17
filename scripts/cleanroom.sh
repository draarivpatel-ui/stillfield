#!/bin/bash
# Fresh clone of the committed repo: npm ci and the full tests; then the Action's production-only install.
set -euo pipefail
R="$(cd "$(dirname "$0")/.." && pwd)"
C="$R/.scratch/cleanroom"
rm -rf "$C" && git clone -q "$R" "$C/full" && git clone -q "$R" "$C/action"
cd "$C/full" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --no-audit --no-fund --loglevel=error && npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)|^✖" || true
cd "$C/action" && npm ci --omit=dev --omit=optional --ignore-scripts --no-audit --no-fund --loglevel=error
ls node_modules | tr '\n' ' '; echo
cp "$C/full/test/.out/fail-full-4hz.mp4" "$C/action/clip.mp4"
S="$C/action/summary.md"; O="$C/action/out.txt"; : > "$S"; : > "$O"
set +e
INPUT_PATHS=clip.mp4 GITHUB_STEP_SUMMARY="$S" GITHUB_OUTPUT="$O" node src/action.ts; echo "action exit $?"
cat "$O"; head -8 "$S"

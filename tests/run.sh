#!/usr/bin/env bash
# dsh-paper-reader — run the whole verification matrix.
#
#   tests/run.sh                 # standalone harness suite + real-GUI suite
#   tests/run.sh --only=viewer   # pass extra args to BOTH scripts (see below)
#   SKIP_GUI=1 tests/run.sh      # chunk-level harness only (no dev host needed)
#   GUI_ONLY=1 tests/run.sh      # real-GUI suite only
#
# Standalone harness (tests/harness.spec.mjs):
#   • starts its own zero-dependency static server on 127.0.0.1:7812
#   • drives harness/pages/*.html with the installed Playwright + Chrome
#   • needs no DSH Host, no auth, no install
#   • screenshots → tests/screenshots/*.png, summary → tests/last-run.json
#
# Real GUI (tests/gui.spec.mjs):
#   • requires the Lead's isolated dev host on http://127.0.0.1:54001 with the
#     plugin installed; tokenized URL in /tmp/paperdev.url
#     (restart after lib/*.js changes: ./scripts/dev-gui.sh restart)
#   • verifies the true right sidebar → guide card → tab → upload → PDF render →
#     selection menu → highlight/note/ask → persistence flow in zh and en
#   • screenshots → tests/screenshots/gui-*.png, summary → tests/gui-last-run.json
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

status=0

if [ "${GUI_ONLY:-0}" != "1" ]; then
  echo "== standalone harness (chunk-level, 127.0.0.1:7812) =="
  node tests/harness.spec.mjs "$@"
  harness_status=$?
  [ "$harness_status" -ne 0 ] && status=1
fi

if [ "${SKIP_GUI:-0}" != "1" ]; then
  echo
  echo "== real GUI (dev host 127.0.0.1:54001) =="
  # The dev host is an isolated DSH instance (own DSH_HOME, same plugin list as
  # the desktop profile). Start it on demand; the GUI suite exits 2 when the
  # host/token is unavailable, which is reported but is not a product failure.
  if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:54001/" 2>/dev/null; then
    echo "(starting isolated dev host …)"
    ./scripts/dev-gui.sh start >/dev/null 2>&1 || true
  fi
  node tests/gui.spec.mjs "$@"
  gui_status=$?
  if [ "$gui_status" -ne 0 ]; then
    status=1
    # Exit code 2 means the dev host / token is not available — not a product failure.
    [ "$gui_status" -eq 2 ] && echo "(gui matrix could not run: dev host/token unavailable)"
  fi
fi

if [ "$status" -eq 0 ]; then
  echo
  echo "all verification matrices passed"
else
  echo
  echo "verification failed — see tests/last-run.json and tests/gui-last-run.json"
fi
exit "$status"

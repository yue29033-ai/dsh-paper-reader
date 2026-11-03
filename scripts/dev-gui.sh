#!/bin/bash
# Dev GUI for verifying dsh-paper-reader in the real Harness Web UI.
#
# Boots an isolated DSH host (own DSH_HOME under .dsh-dev/devhome, own port)
# with the desktop profile's plugin list + the same profile node_modules, so it
# renders the true right sidebar and plugin system without touching the user's
# running desktop app. The startup line prints a tokenized URL; the signed
# cookie is what authenticates the page.
#
#   scripts/dev-gui.sh start     start (background), print URL
#   scripts/dev-gui.sh stop      stop the background host
#   scripts/dev-gui.sh restart   stop + start (needed after lib/*.js changes)
#   scripts/dev-gui.sh url       print the current tokenized URL
#   scripts/dev-gui.sh log       tail the host log
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEVH="$ROOT/../.dsh-dev/devhome"
PROFILE="$DEVH/profiles/paperdev"
LOG="/tmp/paperdev.log"
URLFILE="/tmp/paperdev.url"
APP="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
ASAR="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar"
CLI="$ASAR/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
PORT=54001

prepare() {
  mkdir -p "$PROFILE" "$DEVH/storages"
  cp ~/.dsh/profiles/desktop/package.json "$PROFILE/package.json"
  cp ~/.dsh/profiles/desktop/cordis.patch.yml "$PROFILE/cordis.patch.yml"
  ln -sfn ~/.dsh/profiles/desktop/node_modules "$PROFILE/node_modules"
  # Seed the real workspace catalog so the dev GUI has a workspace to start a
  # session in (the fresh isolated DSH_HOME is otherwise empty; the Host writes
  # an empty catalog on first boot, so "missing" is not enough).
  if [ -f ~/.dsh/storages/workspace.json ]; then
    seeded=$(node -e 'try{const w=require(process.argv[1]);process.stdout.write(String((w.global||{}).workspaceIds?.length>0))}catch{process.stdout.write("false")}' "$DEVH/storages/workspace.json" 2>/dev/null)
    if [ "$seeded" != "true" ]; then
      cp ~/.dsh/storages/workspace.json "$DEVH/storages/workspace.json"
    fi
  fi
}

start() {
  prepare
  : > "$LOG"
  DSH_HOME="$DEVH" ELECTRON_RUN_AS_NODE=1 nohup "$APP" --expose-internals "$CLI" \
    --profile paperdev --port "$PORT" --host 127.0.0.1 --no-open >>"$LOG" 2>&1 &
  echo $! > /tmp/paperdev.pid
  for _ in $(seq 1 120); do
    URL=$(grep -o "http://127.0.0.1:$PORT/?token=[A-Za-z0-9_-]*" "$LOG" | head -1)
    if [ -n "${URL:-}" ]; then
      printf '%s\n' "$URL" > "$URLFILE"
      echo "$URL"
      return 0
    fi
    sleep 1
  done
  echo "dev-gui: host did not print a URL; see $LOG" >&2
  tail -20 "$LOG" >&2
  return 1
}

stop() {
  if [ -f /tmp/paperdev.pid ]; then
    kill "$(cat /tmp/paperdev.pid)" 2>/dev/null || true
    rm -f /tmp/paperdev.pid
  fi
  # The Electron-as-node child may linger under the launcher pid.
  pkill -f "profile paperdev --port $PORT" 2>/dev/null || true
  sleep 1
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  url) cat "$URLFILE" 2>/dev/null || true ;;
  log) tail -40 "$LOG" ;;
  *) echo "usage: $0 start|stop|restart|url|log" >&2; exit 2 ;;
esac

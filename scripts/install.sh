#!/bin/bash
# Install dsh-paper-reader into a DSH profile as a linked local bundle.
#
#   scripts/install.sh [profile]      (default: desktop)
#
# What it does:
#   1. symlink this package into <profile>/node_modules/dsh-paper-reader
#   2. append one mount row to <profile>/cordis.patch.yml (keeps a .bak copy)
# The running Host recomposes the profile (HMR) and pushes the plugin to the
# open GUI; reload the page if the guide card is not visible yet.
set -euo pipefail
PROFILE_NAME="${1:-desktop}"
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PATCH="$PROFILE/cordis.patch.yml"

[ -d "$PROFILE" ] || { echo "install: no such profile: $PROFILE" >&2; exit 1; }
[ -f "$PLUGIN_DIR/lib/client.js" ] || { echo "install: $PLUGIN_DIR looks incomplete" >&2; exit 1; }

mkdir -p "$PROFILE/node_modules"
ln -sfn "$PLUGIN_DIR" "$PROFILE/node_modules/dsh-paper-reader"

if grep -q "dsh-paper-reader" "$PATCH" 2>/dev/null; then
  echo "install: mount row already present in $PATCH"
  exit 0
fi
cp "$PATCH" "$PATCH.bak-paper-reader" 2>/dev/null || true
printf "    - id: paper-reader\n      name: 'dsh-paper-reader'\n" >> "$PATCH"
echo "install: linked $PLUGIN_DIR into $PROFILE"
echo "install: appended the mount row to $PATCH (backup: $PATCH.bak-paper-reader)"
echo "install: reload the Web GUI page if the paper reader is not visible yet"

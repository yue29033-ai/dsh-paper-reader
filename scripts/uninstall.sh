#!/bin/bash
# Remove dsh-paper-reader from a DSH profile.
#
#   scripts/uninstall.sh [profile]    (default: desktop)
#
# Removes the mount row from <profile>/cordis.patch.yml and the node_modules
# symlink. Uploaded papers/annotations (browser IndexedDB/localStorage) are not
# touched; the running Host drops the plugin on recomposition.
set -euo pipefail
PROFILE_NAME="${1:-desktop}"
PROFILE="$HOME/.dsh/profiles/$PROFILE_NAME"
PATCH="$PROFILE/cordis.patch.yml"

if [ -f "$PATCH" ] && grep -q "dsh-paper-reader" "$PATCH"; then
  cp "$PATCH" "$PATCH.bak-uninstall-paper-reader"
  # Remove the two mount-row lines, preserving everything else.
  TMP="$(mktemp)"
  grep -v "id: paper-reader" "$PATCH" | grep -v "name: 'dsh-paper-reader'" > "$TMP"
  mv "$TMP" "$PATCH"
  echo "uninstall: removed the mount row from $PATCH (backup: $PATCH.bak-uninstall-paper-reader)"
else
  echo "uninstall: no mount row found in $PATCH"
fi
if [ -L "$PROFILE/node_modules/dsh-paper-reader" ] || [ -e "$PROFILE/node_modules/dsh-paper-reader" ]; then
  rm -f "$PROFILE/node_modules/dsh-paper-reader"
  echo "uninstall: removed $PROFILE/node_modules/dsh-paper-reader"
fi
echo "uninstall: reload the Web GUI page"

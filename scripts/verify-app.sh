#!/usr/bin/env bash
#
# verify-app.sh — agent-device build-install-verify loop, verification half.
#
# Launches the dev app on a given simulator UDID and snapshots the UI to
# confirm it actually rendered (default: the bottom tab bar with Contacts /
# Wallet / Settings). Use after scripts/dev-two-sims.sh, or standalone after
# any `expo run:ios`.
#
# Usage:
#   scripts/verify-app.sh <udid> [expected-text ...]
#   scripts/verify-app.sh 18B4CAB6-4EFA-429D-A658-8F523B5FD66E
#   scripts/verify-app.sh <udid> Wallet            # custom assertion

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <simulator-udid> [expected-text ...]" >&2
  exit 2
fi

UDID="$1"
shift
EXPECTED=("$@")
if [ ${#EXPECTED[@]} -eq 0 ]; then
  EXPECTED=("Contacts" "Wallet" "Settings")
fi

BUNDLE_ID="fit.linky.app.dev"
# One named session per simulator so two instances can be driven side by side
# (and so we never clash with whatever the default session is bound to).
SESSION="linky-$UDID"

echo "[verify-app] Launching $BUNDLE_ID on $UDID (session $SESSION)"
agent-device open "$BUNDLE_ID" --udid "$UDID" --session "$SESSION"

# First launch of a dev client shows the expo-dev-menu (plus its intro screen)
# on top of the app; dismiss both so the snapshot sees the actual UI.
OVERLAY="$(agent-device snapshot --session "$SESSION")"
if printf '%s' "$OVERLAY" | grep -q "This is the developer menu"; then
  echo "[verify-app] Dismissing dev-menu intro"
  agent-device click 'label="Continue"' --session "$SESSION"
  OVERLAY="$(agent-device snapshot --session "$SESSION")"
fi
if printf '%s' "$OVERLAY" | grep -q "Runtime version"; then
  echo "[verify-app] Closing dev menu"
  agent-device click 'label="Close"' --session "$SESSION"
fi

echo "[verify-app] Waiting for \"${EXPECTED[0]}\" to render"
agent-device wait "${EXPECTED[0]}" 30000 --session "$SESSION"

echo "[verify-app] Snapshotting UI"
SNAPSHOT="$(agent-device snapshot --session "$SESSION")"
echo "$SNAPSHOT"

STATUS=0
for text in "${EXPECTED[@]}"; do
  if printf '%s' "$SNAPSHOT" | grep -qF "$text"; then
    echo "[verify-app] OK: found \"$text\""
  else
    echo "[verify-app] FAIL: \"$text\" not found in snapshot" >&2
    STATUS=1
  fi
done

exit $STATUS

#!/usr/bin/env bash
#
# dev-two-sims.sh — one command from fresh checkout to TWO running dev app
# instances on two iOS simulators sharing a single Metro instance.
#
# What it does:
#   1. Boots two simulators (override with SIM_A_UDID / SIM_B_UDID).
#   2. Starts one Metro bundler (APP_ENV=development) if none is listening.
#   3. Builds the development app ONCE via `expo run:ios` against sim A
#      (prebuild runs automatically on a fresh checkout).
#   4. Installs the same .app build product onto sim B via `simctl install`
#      and launches it — no second build.
#   5. Points both dev clients at the shared Metro instance via deep link.
#   6. Restores the committed throwaway identities (alice on A, bob on B) by
#      driving the onboarding restore flow (#18) with `agent-device` UI
#      automation: language → "I'm returning" → type the 20-word mnemonic →
#      confirm. Targets stable testIDs, so it works in any UI language.
#      Re-run just this step any time with:
#        scripts/dev-two-sims.sh restore-only
#      (Why not a deep link? A dev-gated /dev/restore?phrase= route exists,
#      but expo-dev-launcher swallows external linky-dev:// URLs in
#      development builds — verified on-device — so URLs never reach
#      expo-router. See apps/mobile/app/dev/restore.tsx.)
#
# Usage:
#   pnpm install                  # once, repo root
#   scripts/dev-two-sims.sh
#
# Stop Metro afterwards with: kill "$(cat /tmp/linky-dev-metro.pid)"

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOBILE_DIR="$REPO_ROOT/apps/mobile"

# Defaults: iPhone 17 Pro (sim A) and iPhone 17 (sim B).
SIM_A_UDID="${SIM_A_UDID:-18B4CAB6-4EFA-429D-A658-8F523B5FD66E}"
SIM_B_UDID="${SIM_B_UDID:-B15D0678-6BAF-47DE-9F55-12AAE5215E9F}"
BUNDLE_ID="fit.linky.app.dev"
METRO_PORT="${METRO_PORT:-8081}"
METRO_LOG="${METRO_LOG:-/tmp/linky-dev-metro.log}"
METRO_PID_FILE="${METRO_PID_FILE:-/tmp/linky-dev-metro.pid}"

log() { printf '\n[dev-two-sims] %s\n' "$*"; }

sim_name() {
  xcrun simctl list devices | grep -F "$1" | head -n1 | sed 's/ (.*//' | sed 's/^ *//'
}

# Restores a committed dev identity by driving the onboarding restore screen
# (#18) with agent-device. Expects the dev app running and logged out (the
# fresh state this script produces). Steps before the restore screen are
# tolerant (|| true) so a re-run from the create screen still works; the
# restore screen steps are strict.
restore_identity() {
  local udid="$1" file="$2" label="$3" phrase session
  phrase="$(node -p 'require(process.argv[1]).slip39Mnemonic' "$file")"
  session="linky-restore-$label"
  log "Restoring $label onto $(sim_name "$udid") ($udid) via agent-device (testID-driven, locale-independent)"
  # Every call pins --udid so nothing can stray to another device; the named
  # session must not be held elsewhere (agent-device close --session <name>).
  ad() { agent-device "$@" --udid "$udid" --session "$session"; }
  ad open "$BUNDLE_ID" >/dev/null
  # Onboarding: language -> create screen -> "I'm returning" (skip steps that
  # are already behind us).
  ad find "language-continue" click >/dev/null 2>&1 || true
  ad wait 1000 >/dev/null 2>&1 || true
  ad find "onboarding-restore-link" click >/dev/null 2>&1 || true
  ad wait 1000 >/dev/null 2>&1 || true
  # Restore screen: focus the word input, type the full phrase (fills all 20
  # word chips), confirm. The phrase is typed, not pasted, to avoid the iOS
  # pasteboard permission alert.
  ad find "restore-word-input" click >/dev/null
  ad type "$phrase" >/dev/null
  ad find "restore-confirm" click >/dev/null
  # Tabs header (testID open-settings) = restore succeeded, app entered.
  ad wait "open-settings" 20000 >/dev/null
  ad close >/dev/null 2>&1 || true
  log "$label restored — app shows the main tabs."
}

restore_both() {
  if ! command -v agent-device >/dev/null 2>&1; then
    log "SKIPPED identity restore: agent-device CLI not found."
    log "  Install it, or restore manually: onboarding -> 'I'm returning' ->"
    log "  paste the mnemonic from dev/test-identities/{alice,bob}.json."
    return 0
  fi
  restore_identity "$SIM_A_UDID" "$REPO_ROOT/dev/test-identities/alice.json" "alice"
  restore_identity "$SIM_B_UDID" "$REPO_ROOT/dev/test-identities/bob.json" "bob"
}

if [ "$SIM_A_UDID" = "$SIM_B_UDID" ]; then
  echo "SIM_A_UDID and SIM_B_UDID must differ" >&2
  exit 1
fi

# `restore-only`: skip boot/build/launch and just re-drive the restore step
# (both apps must already be running, e.g. after a full run of this script).
if [ "${1:-}" = "restore-only" ]; then
  restore_both
  exit 0
fi

# --- 1. Boot both simulators -------------------------------------------------
log "Booting simulators: $(sim_name "$SIM_A_UDID") ($SIM_A_UDID) and $(sim_name "$SIM_B_UDID") ($SIM_B_UDID)"
xcrun simctl bootstatus "$SIM_A_UDID" -b
xcrun simctl bootstatus "$SIM_B_UDID" -b
open -a Simulator || true

# --- 2. One shared Metro instance --------------------------------------------
if lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "Metro (or something) already listening on :$METRO_PORT — reusing it"
else
  log "Starting Metro on :$METRO_PORT (log: $METRO_LOG, pid file: $METRO_PID_FILE)"
  (
    cd "$MOBILE_DIR"
    APP_ENV=development nohup npx expo start --port "$METRO_PORT" \
      >"$METRO_LOG" 2>&1 &
    echo $! >"$METRO_PID_FILE"
  )
  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 1
  done
  if ! lsof -nP -iTCP:"$METRO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Metro failed to start; see $METRO_LOG" >&2
    exit 1
  fi
fi

# --- 3. Build once, install + launch on sim A --------------------------------
log "Building development app once (expo run:ios → $(sim_name "$SIM_A_UDID")). First build takes a while."
(
  cd "$MOBILE_DIR"
  # --no-bundler: we run our own shared Metro (mutually exclusive with --port;
  # the deep-link step below points the dev clients at $METRO_PORT explicitly).
  APP_ENV=development npx expo run:ios \
    --device "$SIM_A_UDID" \
    --no-bundler
)

# --- 4. Reuse the same build product on sim B ---------------------------------
# expo run:ios just installed the build product onto sim A; ask the simulator
# where it lives instead of guessing the Xcode DerivedData path.
APP_PATH="$(xcrun simctl get_app_container "$SIM_A_UDID" "$BUNDLE_ID" app)"
if [ -z "$APP_PATH" ] || [ ! -d "$APP_PATH" ]; then
  echo "Could not locate the installed $BUNDLE_ID app bundle on sim A" >&2
  exit 1
fi
log "Installing the same build product onto sim B (no rebuild): $APP_PATH"
xcrun simctl install "$SIM_B_UDID" "$APP_PATH"
xcrun simctl launch "$SIM_B_UDID" "$BUNDLE_ID"

# --- 5. Point both dev clients at the shared Metro ----------------------------
# expo-dev-client registers `exp+<slug>` for development-client deep links
# (the app's own scheme is linky-dev, but dev-client URLs use this one —
# it is what `expo run:ios` itself opens).
DEV_CLIENT_URL="exp+linky://expo-development-client/?url=http%3A%2F%2Flocalhost%3A$METRO_PORT"
log "Connecting both dev clients to Metro at localhost:$METRO_PORT"
sleep 2
xcrun simctl openurl "$SIM_A_UDID" "$DEV_CLIENT_URL"
xcrun simctl openurl "$SIM_B_UDID" "$DEV_CLIENT_URL"

# --- 6. Restore test identities ------------------------------------------------
# Give the freshly-connected dev clients a moment to load the JS bundle so
# the onboarding UI is mounted (worst case: re-run restore-only).
log "Waiting for the JS bundles to load before restoring identities..."
sleep 8
restore_both

log "Done. Two dev app instances are running:"
log "  A: $(sim_name "$SIM_A_UDID") ($SIM_A_UDID)"
log "  B: $(sim_name "$SIM_B_UDID") ($SIM_B_UDID)"
log "Verify each renders: scripts/verify-app.sh <udid>"
log "Stop Metro when done: kill \$(cat $METRO_PID_FILE) (if started by this script)"

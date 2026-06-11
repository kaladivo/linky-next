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
#   6. Identity restore (alice on A, bob on B): placeholder until issue #18.
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

if [ "$SIM_A_UDID" = "$SIM_B_UDID" ]; then
  echo "SIM_A_UDID and SIM_B_UDID must differ" >&2
  exit 1
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

# --- 6. Restore test identities (placeholder) ----------------------------------
# TODO(#18): the app has no identity-restore flow yet (onboarding restore is
# issue #18; SLIP-39 identity primitives are issue #12). Once #18 lands, this
# step restores the committed throwaway identities from dev/test-identities/:
#   - alice on sim A ($SIM_A_UDID)
#   - bob   on sim B ($SIM_B_UDID)
# e.g. by driving the restore screen with agent-device (fill the 20-word
# SLIP-39 mnemonic from dev/test-identities/{alice,bob}.json) or via a
# dev-only deep link.
log "SKIPPED identity restore: app has no restore flow yet (issue #18)."
log "  Once #18 lands: alice → sim A, bob → sim B (mnemonics in dev/test-identities/)."

log "Done. Two dev app instances are running:"
log "  A: $(sim_name "$SIM_A_UDID") ($SIM_A_UDID)"
log "  B: $(sim_name "$SIM_B_UDID") ($SIM_B_UDID)"
log "Verify each renders: scripts/verify-app.sh <udid>"
log "Stop Metro when done: kill \$(cat $METRO_PID_FILE) (if started by this script)"

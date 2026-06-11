# scripts/

Dev tooling for the standard Linky verification scenario: Linky is two-sided
(chat + payments), so changes are verified against **two app instances with
two identities on testnet**.

## One command → two running test instances

```sh
pnpm install              # once, from a fresh checkout
scripts/dev-two-sims.sh
```

`dev-two-sims.sh` boots two iOS simulators (iPhone 17 Pro + iPhone 17 by
default; override with `SIM_A_UDID` / `SIM_B_UDID`), starts a single Metro
instance (`APP_ENV=development`), builds the dev app **once** with
`expo run:ios` for sim A, installs the same `.app` build product onto sim B
via `xcrun simctl install` (never builds twice), launches both, and connects
both dev clients to the shared Metro via the `linky-dev://` deep link.

Identity restore — alice on sim A, bob on sim B, from the committed throwaway
mnemonics in [`dev/test-identities/`](../dev/test-identities/README.md) — is a
documented placeholder until the onboarding restore flow lands (issue #18;
SLIP-39 identity primitives are issue #12). Until then the script produces two
fresh, distinct app instances.

Metro keeps running after the script exits (it is the shared dev server). If
the script started it, stop it with:

```sh
kill "$(cat /tmp/linky-dev-metro.pid)"
```

## Build–install–verify loop (agent-device)

After a change, the loop is:

```sh
scripts/dev-two-sims.sh                 # build once, run on both sims
scripts/verify-app.sh <udid-A>          # launch + snapshot, assert tab UI renders
scripts/verify-app.sh <udid-B>
```

`verify-app.sh` uses [agent-device](https://github.com/anthropics/agent-device)
to launch `fit.linky.app.dev` on the given simulator UDID, wait for the UI,
take an accessibility snapshot, and fail unless the expected texts (default:
the Contacts / Wallet / Settings tab bar) are present. From there, drive
two-instance flows directly with `agent-device --udid <udid> ...` (tap, fill,
snapshot) — e.g. send a message or payment from A and assert it shows up on B.

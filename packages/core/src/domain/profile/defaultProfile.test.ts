/**
 * Pure default-address rules (#30): the canonical `${npub}@linky.fit`
 * derivation and the `profile.restore-default-ln` visibility rule.
 * (The deterministic name/avatar derivations are pinned separately by
 * `generatedAvatar.golden.test.ts`.)
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIGHTNING_ADDRESS_DOMAIN,
  canRestoreDefaultLightningAddress,
  deriveDefaultLightningAddress,
} from "./defaultProfile.js";

const NPUB = "npub1alicealicealicealicealicealicealicealicealicealicealice";

describe("deriveDefaultLightningAddress (profile.default-linky-address)", () => {
  it("derives `${npub}@linky.fit`", () => {
    expect(deriveDefaultLightningAddress(NPUB)).toBe(`${NPUB}@linky.fit`);
    expect(DEFAULT_LIGHTNING_ADDRESS_DOMAIN).toBe("linky.fit");
  });

  it("trims the npub before deriving", () => {
    expect(deriveDefaultLightningAddress(`  ${NPUB} `)).toBe(`${NPUB}@linky.fit`);
  });

  it("is empty for an empty/blank npub (no address to derive)", () => {
    expect(deriveDefaultLightningAddress("")).toBe("");
    expect(deriveDefaultLightningAddress("   ")).toBe("");
  });
});

describe("canRestoreDefaultLightningAddress (profile.restore-default-ln)", () => {
  const defaultAddress = deriveDefaultLightningAddress(NPUB);

  it("is hidden while the profile still uses the derived default", () => {
    expect(
      canRestoreDefaultLightningAddress({
        npub: NPUB,
        currentAddress: defaultAddress,
        ownedAliases: [],
      }),
    ).toBe(false);
  });

  it("ignores surrounding whitespace in the current address", () => {
    expect(
      canRestoreDefaultLightningAddress({
        npub: NPUB,
        currentAddress: `  ${defaultAddress}  `,
        ownedAliases: [],
      }),
    ).toBe(false);
  });

  it("shows once the user overrides the address and owns no alias", () => {
    expect(
      canRestoreDefaultLightningAddress({
        npub: NPUB,
        currentAddress: "alice@getalby.com",
        ownedAliases: [],
      }),
    ).toBe(true);
  });

  it("shows when the address was cleared entirely", () => {
    expect(
      canRestoreDefaultLightningAddress({ npub: NPUB, currentAddress: "", ownedAliases: [] }),
    ).toBe(true);
  });

  it("is hidden when a paid alias exists (TODO(#61): alias claim populates this)", () => {
    expect(
      canRestoreDefaultLightningAddress({
        npub: NPUB,
        currentAddress: "alice@getalby.com",
        ownedAliases: ["alice@linky.fit"],
      }),
    ).toBe(false);
  });

  it("is hidden without an npub (nothing to restore to)", () => {
    expect(
      canRestoreDefaultLightningAddress({
        npub: "",
        currentAddress: "alice@getalby.com",
        ownedAliases: [],
      }),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  decodeAppProfile,
  decodeEnvironmentConfig,
  environmentForProfile,
  networkForProfile,
} from "../../index.js";

describe("AppProfile", () => {
  it("accepts the three profiles", () => {
    expect(decodeAppProfile("development")).toBe("development");
    expect(decodeAppProfile("staging")).toBe("staging");
    expect(decodeAppProfile("production")).toBe("production");
  });

  it("rejects unknown profiles", () => {
    expect(() => decodeAppProfile("prod")).toThrow();
    expect(() => decodeAppProfile(undefined)).toThrow();
  });

  it("derives the network discriminant from the profile", () => {
    expect(networkForProfile("development")).toBe("test");
    expect(networkForProfile("staging")).toBe("test");
    expect(networkForProfile("production")).toBe("main");
  });
});

describe("environmentForProfile — defaults match the spec table", () => {
  const SPEC_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.0xchat.com"];

  it("development", () => {
    expect(environmentForProfile("development")).toEqual({
      profile: "development",
      network: "test",
      cashuMintUrl: "https://testnut.cashu.space",
      presetMintUrls: ["https://testnut.cashu.space", "https://nofees.testnut.cashu.space"],
      nostrRelayUrls: SPEC_RELAYS,
      evoluSyncUrls: ["wss://free.evoluhq.com"],
      pushServiceUrl: "http://localhost:8787",
    });
  });

  it("staging", () => {
    expect(environmentForProfile("staging")).toEqual({
      profile: "staging",
      network: "test",
      cashuMintUrl: "https://testnut.cashu.space",
      presetMintUrls: ["https://testnut.cashu.space", "https://nofees.testnut.cashu.space"],
      nostrRelayUrls: SPEC_RELAYS,
      evoluSyncUrls: ["wss://free.evoluhq.com"],
      pushServiceUrl: "https://push.linky.fit",
    });
  });

  it("production", () => {
    expect(environmentForProfile("production")).toEqual({
      profile: "production",
      network: "main",
      cashuMintUrl: "https://cashu.cz",
      presetMintUrls: [
        "https://cashu.cz",
        "https://testnut.cashu.space",
        "https://mint.minibits.cash/Bitcoin",
        "https://kashu.me",
        "https://cashu.21m.lol",
      ],
      nostrRelayUrls: SPEC_RELAYS,
      evoluSyncUrls: ["wss://evolu.linky.fit", "wss://free.evoluhq.com"],
      pushServiceUrl: "https://push.linky.fit",
    });
  });
});

describe("structural mainnet guard", () => {
  const base = {
    presetMintUrls: ["https://testnut.cashu.space"],
    nostrRelayUrls: ["wss://relay.damus.io"],
    evoluSyncUrls: ["wss://free.evoluhq.com"],
    pushServiceUrl: "https://push.linky.fit",
  };

  it("refuses a mainnet mint for the development profile", () => {
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://cashu.cz",
      }),
    ).toThrow();
  });

  it("refuses a mainnet mint for the staging profile", () => {
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "staging",
        network: "test",
        cashuMintUrl: "https://cashu.cz",
      }),
    ).toThrow();
  });

  it("refuses the production-only sync host for non-production profiles", () => {
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://testnut.cashu.space",
        evoluSyncUrls: ["wss://evolu.linky.fit"],
      }),
    ).toThrow();
  });

  it("refuses a network discriminant that does not match the profile", () => {
    // development cannot claim mainnet…
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "main",
        cashuMintUrl: "https://testnut.cashu.space",
      }),
    ).toThrow();
    // …and production cannot claim testnet.
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "production",
        network: "test",
        cashuMintUrl: "https://cashu.cz",
      }),
    ).toThrow();
  });

  it("allows a local mint for development", () => {
    const config = decodeEnvironmentConfig({
      ...base,
      profile: "development",
      network: "test",
      cashuMintUrl: "https://localhost:3338",
    });
    expect(config.network).toBe("test");
  });

  it("allows mainnet endpoints for production", () => {
    const config = decodeEnvironmentConfig({
      ...base,
      profile: "production",
      network: "main",
      cashuMintUrl: "https://cashu.cz",
      presetMintUrls: ["https://cashu.cz", "https://testnut.cashu.space"],
      evoluSyncUrls: ["wss://evolu.linky.fit", "wss://free.evoluhq.com"],
    });
    expect(config.network).toBe("main");
  });

  it("refuses a mainnet preset mint for non-production profiles (mints.presets guard)", () => {
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://testnut.cashu.space",
        presetMintUrls: ["https://testnut.cashu.space", "https://cashu.cz"],
      }),
    ).toThrow();
  });

  it("allows a localhost http push service for development, refuses it for production", () => {
    const config = decodeEnvironmentConfig({
      ...base,
      profile: "development",
      network: "test",
      cashuMintUrl: "https://testnut.cashu.space",
      pushServiceUrl: "http://localhost:8787",
    });
    expect(config.pushServiceUrl).toBe("http://localhost:8787");
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "production",
        network: "main",
        cashuMintUrl: "https://cashu.cz",
        pushServiceUrl: "http://localhost:8787",
      }),
    ).toThrow();
    // Non-localhost plain http is refused even for development.
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://testnut.cashu.space",
        pushServiceUrl: "http://push.linky.fit",
      }),
    ).toThrow();
  });

  it("rejects malformed endpoint URLs", () => {
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "http://testnut.cashu.space", // not https
      }),
    ).toThrow();
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://testnut.cashu.space",
        nostrRelayUrls: ["https://relay.damus.io"], // not wss
      }),
    ).toThrow();
    expect(() =>
      decodeEnvironmentConfig({
        ...base,
        profile: "development",
        network: "test",
        cashuMintUrl: "https://testnut.cashu.space",
        nostrRelayUrls: [], // relays must be non-empty
      }),
    ).toThrow();
  });
});

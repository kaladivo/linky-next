/**
 * notificationsState tests (#52): the enable/disable + replace-stale state
 * machine — (de)serialization resilience, the registration plan and the
 * persistence round-trip (in-memory KeyValueStorage).
 */
import { KeyValueStorage, Randomness } from "@linky/core";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  decodeNotificationsState,
  encodeNotificationsState,
  getOrCreateInstallationId,
  initialNotificationsState,
  loadNotificationsState,
  persistNotificationsState,
  planRegistration,
} from "./notificationsState";
import type { NotificationsState } from "./notificationsState";

const registration = {
  pubkeyHex: "a".repeat(64),
  expoPushToken: "ExponentPushToken[t1]",
  tokenSource: "expo" as const,
  serviceUrl: "http://localhost:8787",
  installationId: "install-1",
  registeredAtMs: 1_750_000_000_000,
  replacedStaleInstalls: 1,
};

const enabledState: NotificationsState = {
  enabled: true,
  registration,
  lastError: null,
  lastDelivery: null,
};

const current = {
  pubkeyHex: registration.pubkeyHex,
  expoPushToken: registration.expoPushToken,
  serviceUrl: registration.serviceUrl,
  installationId: registration.installationId,
};

describe("planRegistration (notifications.replace-stale)", () => {
  it("disabled state never registers", () => {
    expect(planRegistration(initialNotificationsState, current)).toEqual({ _tag: "disabled" });
  });

  it("matching credentials are a noop", () => {
    expect(planRegistration(enabledState, current)).toEqual({ _tag: "noop" });
  });

  it("enabled without a registration registers (initial)", () => {
    expect(
      planRegistration({ ...enabledState, registration: null }, current),
    ).toEqual({ _tag: "register", reason: "initial" });
  });

  it.each([
    ["identity-changed", { ...current, pubkeyHex: "b".repeat(64) }],
    ["token-changed", { ...current, expoPushToken: "ExponentPushToken[t2]" }],
    ["service-changed", { ...current, serviceUrl: "https://push.linky.fit" }],
    ["install-changed", { ...current, installationId: "install-2" }],
  ] as const)("drift re-registers: %s", (reason, drifted) => {
    expect(planRegistration(enabledState, drifted)).toEqual({ _tag: "register", reason });
  });
});

describe("state (de)serialization", () => {
  it("round-trips a full state", () => {
    const state: NotificationsState = {
      enabled: true,
      registration: { ...registration, tokenSource: "dev-fake" },
      lastError: "HTTP 429 rate_limited: Too many requests",
      lastDelivery: { receivedAtMs: 123, eventId: "e".repeat(64), presentation: "remote-tap" },
    };
    expect(decodeNotificationsState(encodeNotificationsState(state))).toEqual(state);
  });

  it("treats null/garbage/partial values as the initial state", () => {
    expect(decodeNotificationsState(null)).toEqual(initialNotificationsState);
    expect(decodeNotificationsState("not json")).toEqual(initialNotificationsState);
    expect(decodeNotificationsState("42")).toEqual(initialNotificationsState);
    // A registration missing required fields is dropped, not crashed on.
    expect(
      decodeNotificationsState(JSON.stringify({ enabled: true, registration: { pubkeyHex: "x" } })),
    ).toEqual({ ...initialNotificationsState, enabled: true });
  });
});

describe("persistence + install id", () => {
  const randomness = Layer.succeed(Randomness, {
    nextBytes: (count) => Effect.sync(() => new Uint8Array(count).fill(7)),
  });
  const layers = Layer.mergeAll(KeyValueStorage.layerMemory, randomness);

  it("persists and reloads the state", async () => {
    const loaded = await Effect.runPromise(
      Effect.gen(function* () {
        yield* persistNotificationsState(enabledState);
        return yield* loadNotificationsState;
      }).pipe(Effect.provide(layers)),
    );
    expect(loaded).toEqual(enabledState);
  });

  it("creates the install id once and keeps it stable", async () => {
    const [first, second] = await Effect.runPromise(
      Effect.gen(function* () {
        const a = yield* getOrCreateInstallationId;
        const b = yield* getOrCreateInstallationId;
        return [a, b] as const;
      }).pipe(Effect.provide(layers)),
    );
    expect(first).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    expect(second).toBe(first);
  });
});

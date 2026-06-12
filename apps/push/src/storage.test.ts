import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { PushStorageService } from "./storage.js";
import { makeSqliteStorage } from "./storage.js";

const run = <A>(effect: Effect.Effect<A>): A => Effect.runSync(effect);

const withStorage = (test: (storage: PushStorageService) => void): void => {
  const { service, close } = makeSqliteStorage(":memory:");
  try {
    test(service);
  } finally {
    close();
  }
};

const caps = { maxInstallsPerIdentity: 3, maxIdentitiesPerInstall: 2 };
const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);

describe("registration lifecycle", () => {
  it("registers and lists by pubkey", () =>
    withStorage((storage) => {
      const result = run(
        storage.register({
          recipientPubkey: PK_A,
          installationId: "i1",
          expoPushToken: "ExponentPushToken[t1]",
          nowMs: 1000,
          ...caps,
        }),
      );
      expect(result).toEqual({ _tag: "registered", replacedStaleInstalls: 0 });
      const rows = run(storage.registrationsForPubkey(PK_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expoPushToken).toBe("ExponentPushToken[t1]");
    }));

  it("replaces the token for the same identity+install instead of duplicating", () =>
    withStorage((storage) => {
      const register = (token: string) =>
        run(
          storage.register({
            recipientPubkey: PK_A,
            installationId: "i1",
            expoPushToken: token,
            nowMs: 1000,
            ...caps,
          }),
        );
      register("ExponentPushToken[old]");
      register("ExponentPushToken[new]");
      const rows = run(storage.registrationsForPubkey(PK_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.expoPushToken).toBe("ExponentPushToken[new]");
    }));

  it("removes a stale install that still holds the same device token (reinstall)", () =>
    withStorage((storage) => {
      run(
        storage.register({
          recipientPubkey: PK_A,
          installationId: "old-install",
          expoPushToken: "ExponentPushToken[device]",
          nowMs: 1000,
          ...caps,
        }),
      );
      const result = run(
        storage.register({
          recipientPubkey: PK_A,
          installationId: "new-install",
          expoPushToken: "ExponentPushToken[device]",
          nowMs: 2000,
          ...caps,
        }),
      );
      expect(result).toEqual({ _tag: "registered", replacedStaleInstalls: 1 });
      const rows = run(storage.registrationsForPubkey(PK_A));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.installationId).toBe("new-install");
    }));

  it("caps installs per identity", () =>
    withStorage((storage) => {
      for (const install of ["i1", "i2", "i3"]) {
        expect(
          run(
            storage.register({
              recipientPubkey: PK_A,
              installationId: install,
              expoPushToken: `ExponentPushToken[${install}]`,
              nowMs: 1000,
              ...caps,
            }),
          )._tag,
        ).toBe("registered");
      }
      expect(
        run(
          storage.register({
            recipientPubkey: PK_A,
            installationId: "i4",
            expoPushToken: "ExponentPushToken[i4]",
            nowMs: 1000,
            ...caps,
          }),
        )._tag,
      ).toBe("limit-installs-per-identity");
      // Re-registering an existing install is a replace, not a new slot.
      expect(
        run(
          storage.register({
            recipientPubkey: PK_A,
            installationId: "i2",
            expoPushToken: "ExponentPushToken[i2b]",
            nowMs: 2000,
            ...caps,
          }),
        )._tag,
      ).toBe("registered");
    }));

  it("caps identities per install", () =>
    withStorage((storage) => {
      const register = (pubkey: string) =>
        run(
          storage.register({
            recipientPubkey: pubkey,
            installationId: "i1",
            expoPushToken: "ExponentPushToken[t]",
            nowMs: 1000,
            ...caps,
          }),
        );
      expect(register(PK_A)._tag).toBe("registered");
      expect(register(PK_B)._tag).toBe("registered");
      expect(register("c".repeat(64))._tag).toBe("limit-identities-per-install");
    }));

  it("unregister removes the identity; the install survives until the last one", () =>
    withStorage((storage) => {
      for (const pubkey of [PK_A, PK_B]) {
        run(
          storage.register({
            recipientPubkey: pubkey,
            installationId: "i1",
            expoPushToken: "ExponentPushToken[t]",
            nowMs: 1000,
            ...caps,
          }),
        );
      }
      const first = run(storage.unregister({ recipientPubkey: PK_A, installationId: "i1" }));
      expect(first).toEqual({ removedIdentity: true, installRemoved: false });
      const second = run(storage.unregister({ recipientPubkey: PK_B, installationId: "i1" }));
      expect(second).toEqual({ removedIdentity: true, installRemoved: true });
      const missing = run(storage.unregister({ recipientPubkey: PK_B, installationId: "i1" }));
      expect(missing).toEqual({ removedIdentity: false, installRemoved: false });
    }));

  it("removeToken drops every registration holding the token", () =>
    withStorage((storage) => {
      for (const pubkey of [PK_A, PK_B]) {
        run(
          storage.register({
            recipientPubkey: pubkey,
            installationId: "i1",
            expoPushToken: "ExponentPushToken[dead]",
            nowMs: 1000,
            ...caps,
          }),
        );
      }
      expect(run(storage.removeToken("ExponentPushToken[dead]"))).toBe(2);
      expect(run(storage.registrationsForPubkey(PK_A))).toHaveLength(0);
    }));
});

describe("dedupe state", () => {
  it("markEventSeen is first-writer-wins and prunable", () =>
    withStorage((storage) => {
      expect(run(storage.markEventSeen("e1", 1000))).toBe(true);
      expect(run(storage.markEventSeen("e1", 2000))).toBe(false);
      expect(run(storage.pruneSeenEvents(1500))).toBe(1);
      expect(run(storage.markEventSeen("e1", 3000))).toBe(true);
    }));

  it("markDelivered dedupes per (event, token) — across installs sharing a token", () =>
    withStorage((storage) => {
      expect(run(storage.markDelivered("e1", "tokenX", 1000))).toBe(true);
      expect(run(storage.markDelivered("e1", "tokenX", 1000))).toBe(false);
      expect(run(storage.markDelivered("e1", "tokenY", 1000))).toBe(true);
      expect(run(storage.markDelivered("e2", "tokenX", 1000))).toBe(true);
    }));

  it("consumeProof blocks reuse until pruned past expiry", () =>
    withStorage((storage) => {
      expect(run(storage.consumeProof("p1", 5000))).toBe(true);
      expect(run(storage.consumeProof("p1", 9000))).toBe(false);
      expect(run(storage.pruneProofs(6000))).toBe(1);
      expect(run(storage.consumeProof("p1", 9000))).toBe(true);
    }));
});

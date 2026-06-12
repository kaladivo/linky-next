/**
 * Pure token list/detail model logic (#38): grouping, sorting, badges,
 * detail affordances and the share-link format.
 */
import type { TokenRecord, TokenState } from "@linky/core";
import { encodeCashuToken } from "@linky/core";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  groupTokenRecords,
  mintDisplayName,
  tokenDetailActions,
  tokenShareUrl,
  tokenStateLabelKey,
  tokenStateTone,
} from "./tokenListModel";

const record = (
  id: string,
  state: TokenState,
  amount: number,
  createdAtMillis = 0,
): TokenRecord => ({
  id,
  mintUrl: "https://testnut.cashu.space",
  unit: "sat",
  amount,
  state,
  token: `token-${id}`,
  error: null,
  createdAtMillis,
  updatedAtMillis: createdAtMillis,
});

describe("mintDisplayName", () => {
  it("strips the scheme and trailing slashes", () => {
    expect(mintDisplayName("https://testnut.cashu.space/")).toBe("testnut.cashu.space");
    expect(mintDisplayName("http://mint.example/api/")).toBe("mint.example/api");
  });
});

describe("groupTokenRecords", () => {
  const groups = groupTokenRecords([
    record("a1", "accepted", 100, 1),
    record("a2", "accepted", 50, 5),
    record("err", "error", 10, 9),
    record("sp", "spent", 999, 10),
    record("is", "issued", 20, 2),
    record("pe", "pending", 30, 8),
    record("ex", "externalized", 40, 3),
    record("re", "reserved", 60, 4),
    record("del", "deleted", 5, 6),
  ]);

  it("splits into the PoC mine/out sections", () => {
    expect(groups.mine.map((r) => r.id)).toEqual(["a2", "a1", "err", "sp"]);
    expect(groups.out.map((r) => r.id)).toEqual(["is", "pe", "re", "ex"]);
  });

  it("never renders deleted tombstones", () => {
    const ids = [...groups.mine, ...groups.out].map((r) => r.id);
    expect(ids).not.toContain("del");
  });

  it("orders live value first, dead value last, newest first within rank", () => {
    expect(groups.mine[0]!.id).toBe("a2"); // newest accepted first
    expect(groups.mine.at(-1)!.id).toBe("sp"); // spent last
  });

  it("totals: mine = accepted only, out = everything out", () => {
    expect(groups.mineTotal).toBe(150);
    expect(groups.outTotal).toBe(150);
  });

  it("counts purgeable spent rows for the cleanup button", () => {
    expect(groups.spentCount).toBe(1);
  });
});

describe("state badges", () => {
  it("maps every state to a label key and tone", () => {
    expect(tokenStateLabelKey("accepted")).toBe("tokenStateAccepted");
    expect(tokenStateLabelKey("externalized")).toBe("tokenStateExternalized");
    expect(tokenStateTone("accepted")).toBe("ok");
    expect(tokenStateTone("error")).toBe("danger");
    expect(tokenStateTone("spent")).toBe("danger");
    expect(tokenStateTone("issued")).toBe("muted");
  });
});

describe("tokenDetailActions", () => {
  it("maps states to the #33 repair transitions", () => {
    expect(tokenDetailActions("accepted")).toEqual({
      canCheck: true,
      canReserve: true,
      canReturn: false,
      canReaccept: false,
    });
    expect(tokenDetailActions("reserved").canReturn).toBe(true);
    expect(tokenDetailActions("externalized").canReturn).toBe(true);
    expect(tokenDetailActions("pending").canReturn).toBe(true);
    expect(tokenDetailActions("issued").canReturn).toBe(true);
    expect(tokenDetailActions("error").canReaccept).toBe(true);
    expect(tokenDetailActions("spent").canCheck).toBe(false);
    expect(tokenDetailActions("deleted").canCheck).toBe(false);
  });
});

describe("tokenShareUrl", () => {
  // A structurally valid V4 token over a fake proof (dev-seed shape).
  const validToken = Effect.runSync(
    encodeCashuToken({
      mintUrl: "https://testnut.cashu.space",
      unit: "sat",
      proofs: [
        { id: "009a1f293253e41e", amount: 21, secret: "share-test", C: `02${"ab".repeat(32)}` },
      ],
    }),
  );

  it("wraps a valid token into the fragment-format Linky link", () => {
    const url = tokenShareUrl(validToken);
    expect(url).not.toBeNull();
    expect(url!.startsWith("https://linky.fit/cashu/#")).toBe(true);
    // The token travels in the fragment — nothing after the host/path
    // before the '#' may contain it.
    const [base, fragment] = url!.split("#");
    expect(base).toBe("https://linky.fit/cashu/");
    expect(decodeURIComponent(fragment!)).toBe(validToken);
  });

  it("returns null for undecodable token text (share disabled)", () => {
    expect(tokenShareUrl("cashuB-not-a-token")).toBeNull();
    expect(tokenShareUrl("")).toBeNull();
  });
});

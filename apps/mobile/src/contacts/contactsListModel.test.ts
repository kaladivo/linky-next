import { describe, expect, it } from "vitest";

import type { ContactListItem, UnknownThreadListItem } from "@linky/evolu-store";

import {
  buildContactListSections,
  contactDisplayName,
  formatPreviewText,
  formatPreviewTimestamp,
  groupFilterKey,
  shortNpub,
  toContactFilter,
  unknownThreadDisplayName,
} from "./contactsListModel";

const contactItem = (
  id: string,
  overrides?: Partial<ContactListItem["contact"]> & {
    readonly previewAtSec?: number | null;
    readonly previewDirection?: "in" | "out";
  },
): ContactListItem => {
  const { previewAtSec = null, previewDirection = "in", ...contact } = overrides ?? {};
  return {
    contact: {
      id,
      name: `Name ${id}`,
      npub: `npub1${id}`,
      lnAddress: null,
      groupName: null,
      archivedAtSec: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: null,
      ...contact,
    },
    preview:
      previewAtSec === null
        ? null
        : {
            kind: "message",
            rumorId: `rumor-${id}`,
            direction: previewDirection,
            content: `hello from ${id}`,
            sentAtSec: previewAtSec,
          },
  };
};

const unknownItem = (
  id: string,
  npub: string,
  previewAtSec: number | null,
  lastActivityAtSec: number | null = previewAtSec,
): UnknownThreadListItem => ({
  thread: { id, npub, firstSeenAtSec: lastActivityAtSec, lastActivityAtSec },
  preview:
    previewAtSec === null
      ? null
      : {
          kind: "message",
          rumorId: `rumor-${id}`,
          direction: "in",
          content: "who dis",
          sentAtSec: previewAtSec,
        },
});

describe("toContactFilter", () => {
  it("maps the chips onto the repository filter", () => {
    expect(toContactFilter({ kind: "all" }, "")).toEqual({ archived: false });
    expect(toContactFilter({ kind: "noGroup" }, "")).toEqual({ archived: false, group: null });
    expect(toContactFilter({ kind: "archived" }, "")).toEqual({ archived: true });
    expect(toContactFilter({ kind: "group", group: "Friends" }, "")).toEqual({
      archived: false,
      group: "Friends",
    });
  });

  it("combines with trimmed search and drops empty search", () => {
    expect(toContactFilter({ kind: "group", group: "Work" }, "  ali ")).toEqual({
      archived: false,
      group: "Work",
      search: "ali",
    });
    expect(toContactFilter({ kind: "all" }, "   ")).toEqual({ archived: false });
  });

  it("has distinct keys per chip", () => {
    const keys = [
      groupFilterKey({ kind: "all" }),
      groupFilterKey({ kind: "noGroup" }),
      groupFilterKey({ kind: "archived" }),
      groupFilterKey({ kind: "group", group: "A" }),
      groupFilterKey({ kind: "group", group: "B" }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("buildContactListSections", () => {
  const base = {
    selection: { kind: "all" } as const,
    search: "",
    unknownPrefix: "[Unknown]",
    lang: "en" as const,
  };

  it("splits conversations from other contacts and keeps activity order", () => {
    const sections = buildContactListSections({
      ...base,
      items: [
        contactItem("b", { previewAtSec: 200 }),
        contactItem("a", { previewAtSec: 100 }),
        contactItem("c"), // no conversation
      ],
      unknownThreads: [],
    });
    expect(sections.conversations.map((row) => row.id)).toEqual(["b", "a"]);
    expect(sections.others.map((row) => row.id)).toEqual(["c"]);
  });

  it("merges unknown threads into conversations by activity", () => {
    const sections = buildContactListSections({
      ...base,
      items: [contactItem("a", { previewAtSec: 100 }), contactItem("b", { previewAtSec: 300 })],
      unknownThreads: [unknownItem("u1", "npub1stranger", 200)],
    });
    expect(sections.conversations.map((row) => row.key)).toEqual([
      "contact-b",
      "unknown-u1",
      "contact-a",
    ]);
    expect(sections.conversations[1]?.kind).toBe("unknown");
  });

  it("falls back to the thread's lastActivityAtSec without a preview", () => {
    const sections = buildContactListSections({
      ...base,
      items: [contactItem("a", { previewAtSec: 100 })],
      unknownThreads: [unknownItem("u1", "npub1stranger", null, 500)],
    });
    expect(sections.conversations.map((row) => row.key)).toEqual(["unknown-u1", "contact-a"]);
  });

  it("hides unknown threads on any chip but All", () => {
    for (const selection of [
      { kind: "noGroup" } as const,
      { kind: "archived" } as const,
      { kind: "group", group: "Friends" } as const,
    ]) {
      const sections = buildContactListSections({
        ...base,
        selection,
        items: [],
        unknownThreads: [unknownItem("u1", "npub1stranger", 200)],
      });
      expect(sections.conversations).toEqual([]);
    }
  });

  it("matches unknown threads against npub search, case-insensitively", () => {
    const threads = [
      unknownItem("u1", "npub1STRANGERaaa", 200),
      unknownItem("u2", "npub1other", 100),
    ];
    const sections = buildContactListSections({
      ...base,
      search: "stranger",
      items: [],
      unknownThreads: threads,
    });
    expect(sections.conversations.map((row) => row.id)).toEqual(["u1"]);
  });
});

describe("display names", () => {
  it("uses the saved name when present", () => {
    expect(
      contactDisplayName({ name: "Alice", npub: "npub1whatever" }, "en"),
    ).toBe("Alice");
  });

  it("derives the PoC default name for unnamed contacts (per language)", () => {
    const en = contactDisplayName({ name: null, npub: "npub1whatever" }, "en");
    const cs = contactDisplayName({ name: null, npub: "npub1whatever" }, "cs");
    expect(en.length).toBeGreaterThan(0);
    expect(cs.length).toBeGreaterThan(0);
    // Deterministic: same npub, same name.
    expect(contactDisplayName({ name: null, npub: "npub1whatever" }, "en")).toBe(en);
  });

  it("prefixes unknown threads with the localized unknown marker", () => {
    const name = unknownThreadDisplayName("npub1whatever", "[Unknown]", "en");
    expect(name.startsWith("[Unknown] ")).toBe(true);
    expect(name.length).toBeGreaterThan("[Unknown] ".length);
  });
});

describe("formatPreviewText", () => {
  const preview = (direction: "in" | "out", content: string) => ({
    kind: "message" as const,
    rumorId: "r",
    direction,
    content,
    sentAtSec: 1,
  });

  it("prefixes the direction symbol", () => {
    expect(formatPreviewText(preview("out", "hello"))).toBe("↗ hello");
    expect(formatPreviewText(preview("in", "hello"))).toBe("↘ hello");
  });

  it("truncates to 40 chars with an ellipsis", () => {
    const long = "x".repeat(50);
    expect(formatPreviewText(preview("in", long))).toBe(`↘ ${"x".repeat(40)}…`);
    const exact = "y".repeat(40);
    expect(formatPreviewText(preview("in", exact))).toBe(`↘ ${exact}`);
  });
});

describe("formatPreviewTimestamp", () => {
  const noonUtc = Date.UTC(2026, 5, 10, 12, 0, 0); // 2026-06-10T12:00Z

  it("renders a time for the same day and a date otherwise", () => {
    const sameDay = formatPreviewTimestamp(Math.floor(noonUtc / 1000) - 3600, noonUtc, "en");
    expect(sameDay).toMatch(/\d{1,2}:\d{2}/);
    const otherDay = formatPreviewTimestamp(
      Math.floor(noonUtc / 1000) - 3 * 24 * 3600,
      noonUtc,
      "en",
    );
    expect(otherDay).not.toMatch(/:/);
    expect(otherDay).toMatch(/\d{2}/);
  });

  it("returns empty for invalid timestamps", () => {
    expect(formatPreviewTimestamp(0, noonUtc, "en")).toBe("");
    expect(formatPreviewTimestamp(Number.NaN, noonUtc, "en")).toBe("");
  });
});

describe("shortNpub", () => {
  it("shortens long npubs and keeps short ones", () => {
    expect(shortNpub("npub1short")).toBe("npub1short");
    const long = "npub1kkht6jvgr8mt4844saf80j5jjwyy6fdy90sxsuxt4hfv8pel499s96jvz8";
    expect(shortNpub(long)).toBe("npub1kkht6…96jvz8");
  });
});

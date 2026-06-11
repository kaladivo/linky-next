import { deriveGeneratedAvatar } from "@linky/core";
import { describe, expect, it } from "vitest";

import { toAvatarDisplayUrl } from "./avatarDisplay";

describe("toAvatarDisplayUrl", () => {
  it("turns the canonical DiceBear SVG URL into a sized PNG URL with identical options", () => {
    const svgUrl = deriveGeneratedAvatar("npub1example").pictureUrl;
    const displayUrl = toAvatarDisplayUrl(svgUrl);

    expect(displayUrl.startsWith("https://api.dicebear.com/9.x/avataaars/png?")).toBe(true);
    expect(displayUrl.endsWith("&size=480")).toBe(true);
    // Same rendering options: only the endpoint + size differ.
    expect(displayUrl.replace("/png?", "/svg?").replace(/&size=\d+$/, "")).toBe(svgUrl);
  });

  it("passes custom-photo data URLs through untouched", () => {
    const dataUrl = "data:image/jpeg;base64,abc123";
    expect(toAvatarDisplayUrl(dataUrl)).toBe(dataUrl);
  });

  it("supports an explicit pixel size", () => {
    const svgUrl = deriveGeneratedAvatar("npub1example").pictureUrl;
    expect(toAvatarDisplayUrl(svgUrl, 96).endsWith("&size=96")).toBe(true);
  });
});

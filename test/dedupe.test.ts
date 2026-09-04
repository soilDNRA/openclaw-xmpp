import { describe, expect, it } from "vitest";

import { ExpiringDedupe } from "../src/dedupe.js";

describe("ExpiringDedupe", () => {
  it("recognizes duplicates until the TTL expires", () => {
    let now = 1_000;
    const dedupe = new ExpiringDedupe(100, 10, () => now);
    expect(dedupe.seen("a")).toBe(false);
    expect(dedupe.seen("a")).toBe(true);
    now = 1_101;
    expect(dedupe.seen("a")).toBe(false);
  });

  it("evicts oldest entries at the configured limit", () => {
    const dedupe = new ExpiringDedupe(1_000, 2, () => 1_000);
    dedupe.seen("a");
    dedupe.seen("b");
    dedupe.seen("c");
    expect(dedupe.size).toBe(2);
    expect(dedupe.seen("a")).toBe(false);
  });
});

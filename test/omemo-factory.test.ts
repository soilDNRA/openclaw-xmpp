import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveOmemoStateDirectory } from "../src/omemo/factory.js";

describe("production OMEMO factory state ownership", () => {
  it("uses a private, traversal-safe, stable directory for each account", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-state-"));
    const first = resolveOmemoStateDirectory(root, "../../Personal Account");
    const again = resolveOmemoStateDirectory(root, "../../Personal Account");
    const other = resolveOmemoStateDirectory(root, "personal-account");

    expect(first).toBe(again);
    expect(other).not.toBe(first);
    expect(relative(root, first)).not.toMatch(/^\.\./);
    expect(first.endsWith("/omemo")).toBe(true);
    for (let current = first; current !== root; current = dirname(current)) {
      expect(statSync(current).mode & 0o777).toBe(0o700);
    }
  });
});

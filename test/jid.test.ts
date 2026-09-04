import { describe, expect, it } from "vitest";

import {
  matchesAllowFrom,
  normalizeBareJid,
  normalizeFullJid,
  normalizeXmppTarget
} from "../src/jid.js";

describe("JID normalization", () => {
  it("normalizes case, resources, and target prefixes", () => {
    expect(normalizeBareJid(" Alice@Example.ORG/Phone ")).toBe(
      "alice@example.org"
    );
    expect(normalizeFullJid("xmpp:Alice@Example.ORG/Phone")).toBe(
      "alice@example.org/Phone"
    );
    expect(normalizeXmppTarget("xmpp:Alice@Example.ORG")).toBe(
      "alice@example.org"
    );
  });

  it("rejects non-JID targets", () => {
    expect(normalizeBareJid("not-a-jid")).toBeUndefined();
    expect(normalizeXmppTarget("*")).toBeUndefined();
  });

  it("matches bare JID allowlists and wildcard entries", () => {
    expect(
      matchesAllowFrom("Alice@Example.ORG/Phone", ["alice@example.org"])
    ).toBe(true);
    expect(matchesAllowFrom("alice@example.org", ["*"])).toBe(true);
    expect(matchesAllowFrom("mallory@example.org", ["alice@example.org"])).toBe(
      false
    );
  });
});

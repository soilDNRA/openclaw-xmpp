import { describe, expect, it } from "vitest";

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import {
  chunkXmppReplyText,
  recoverMarkdownWrappedMediaDirectives
} from "../src/inbound.js";

describe("XMPP inbound runtime wiring", () => {
  it("splits long direct-DM replies with the configured XMPP limit", () => {
    const cfg = {
      channels: {
        xmpp: {
          textChunkLimit: 4_000
        }
      }
    } as OpenClawConfig;
    const text = `${"A".repeat(3_500)}\n\n${"B".repeat(3_000)} END OF TEST`;

    const chunks = chunkXmppReplyText({
      cfg,
      accountId: "default",
      text
    });

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 4_000)).toBe(true);
    expect(chunks.at(-1)).toContain("END OF TEST");
  });

  it("uses the conservative XMPP default when no override is configured", () => {
    const chunks = chunkXmppReplyText({
      cfg: { channels: { xmpp: { enabled: true } } } as OpenClawConfig,
      accountId: "default",
      text: "X".repeat(6_482)
    });

    expect(chunks.map((chunk) => chunk.length)).toEqual([4_000, 2_482]);
  });

  it("uses an account-level XMPP chunk limit for direct-DM replies", () => {
    const cfg = {
      channels: {
        xmpp: {
          textChunkLimit: 4_000,
          accounts: {
            personal: { textChunkLimit: 2_000 }
          }
        }
      }
    } as OpenClawConfig;

    const chunks = chunkXmppReplyText({
      cfg,
      accountId: "personal",
      text: "X".repeat(4_500)
    });

    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= 2_000)).toBe(true);
  });

  it("recovers whole-line Markdown-wrapped MEDIA directives", () => {
    const source = "/home/example/.openclaw/media/plot with spaces.png";
    const wrappers = ["**{}**", "__{}__", "~~{}~~", "`{}`", "*{}*", "_{}_"];

    for (const wrapper of wrappers) {
      const raw = wrapper.replace("{}", `MEDIA:${source}`);
      expect(recoverMarkdownWrappedMediaDirectives(raw)).toEqual({
        text: "",
        mediaSources: [source]
      });
    }
  });

  it("recovers nested wrappers and preserves the caption", () => {
    const source = "https://upload.example.org/plot.png";

    expect(
      recoverMarkdownWrappedMediaDirectives(
        `Plot attached.\n**\`MEDIA:${source}\`**`
      )
    ).toEqual({
      text: "Plot attached.",
      mediaSources: [source]
    });
  });

  it("does not recover inline prose, plain directives, or fenced examples", () => {
    const source = "https://upload.example.org/plot.png";
    const raw = [
      `Here is the file: **MEDIA:${source}**`,
      `MEDIA:${source}`,
      "```text",
      `**MEDIA:${source}**`,
      "```"
    ].join("\n");

    expect(recoverMarkdownWrappedMediaDirectives(raw)).toEqual({
      text: raw,
      mediaSources: []
    });
  });

  it("rejects wrapped unsupported or credential-bearing media sources", () => {
    const raw = [
      "**MEDIA:http://upload.example.org/plot.png**",
      "**MEDIA:https://user:secret@upload.example.org/plot.png**",
      "**MEDIA:relative/plot.png**"
    ].join("\n");

    expect(recoverMarkdownWrappedMediaDirectives(raw)).toEqual({
      text: raw,
      mediaSources: []
    });
  });
});

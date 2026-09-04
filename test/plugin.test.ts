import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import pluginEntry from "../index.js";
import { xmppPlugin } from "../src/channel.js";
import { DEFAULT_TEXT_CHUNK_LIMIT } from "../src/constants.js";
import { registerLiveTransport } from "../src/transport.js";

const configuredXmpp = {
  channels: {
    xmpp: {
      jid: "bot@example.org",
      password: "secret"
    }
  }
} as unknown as OpenClawConfig;

describe("OpenClaw plugin contract", () => {
  it("registers one native direct-message channel", () => {
    expect(pluginEntry.id).toBe("xmpp");
    expect(pluginEntry.setChannelRuntime).toBeTypeOf("function");
    expect(xmppPlugin.id).toBe("xmpp");
    expect(xmppPlugin.capabilities.chatTypes).toEqual(["direct"]);
    expect(xmppPlugin.gateway?.startAccount).toBeTypeOf("function");
    expect(xmppPlugin.message?.send?.text).toBeTypeOf("function");
    expect(xmppPlugin.message?.send?.media).toBeTypeOf("function");
    expect(xmppPlugin.message?.receive?.defaultAckPolicy).toBe(
      "after_agent_dispatch"
    );
    expect(xmppPlugin.outbound?.chunker).toBeTypeOf("function");
    expect(xmppPlugin.outbound?.textChunkLimit).toBe(DEFAULT_TEXT_CHUNK_LIMIT);
  });

  it("provides the chunker required by OpenClaw's message delivery path", () => {
    const chunker = xmppPlugin.outbound?.chunker;
    expect(chunker).toBeTypeOf("function");

    const chunks = chunker?.("X".repeat(6_482), DEFAULT_TEXT_CHUNK_LIMIT);

    expect(chunks?.map((chunk) => chunk.length)).toEqual([4_000, 2_482]);
  });

  it("advertises structured message-tool sends for configured accounts", () => {
    expect(
      xmppPlugin.actions?.describeMessageTool({
        cfg: configuredXmpp,
        accountId: "default"
      })
    ).toEqual({ actions: ["send"], capabilities: [] });
    expect(
      xmppPlugin.actions?.extractToolSend?.({
        args: {
          action: "send",
          to: "alice@example.org",
          accountId: "default"
        }
      })
    ).toEqual({
      to: "alice@example.org",
      accountId: "default",
      threadId: undefined
    });
  });

  it("forwards structured media payloads to the native XMPP uploader", async () => {
    const readFile = vi.fn(async () => Buffer.from("image"));
    const sendMedia = vi.fn(async () => ({
      id: "xmpp-media-1",
      to: "alice@example.org",
      url: "https://upload.example.org/plot.png"
    }));
    const unregister = registerLiveTransport("default", {
      sendMedia
    } as never);

    try {
      const result = await xmppPlugin.message?.send?.media?.({
        cfg: configuredXmpp,
        to: "alice@example.org",
        text: "Plot attached.",
        mediaUrl: "/tmp/plot.png",
        accountId: "default",
        mediaAccess: { readFile }
      } as never);

      expect(sendMedia).toHaveBeenCalledWith({
        to: "alice@example.org",
        text: "Plot attached.",
        mediaUrl: "/tmp/plot.png",
        mediaReadFile: readFile
      });
      expect(result?.messageId).toBe("xmpp-media-1");
    } finally {
      unregister();
    }
  });

  it("keeps the public package free of installation-specific identifiers", async () => {
    const root = resolve(import.meta.dirname, "..");
    const files = [
      "README.md",
      "SECURITY.md",
      "CONTRIBUTING.md",
      "openclaw.plugin.json",
      "package.json",
      "package-lock.json"
    ];
    const contents = (
      await Promise.all(
        files.map((file) => readFile(resolve(root, file), "utf8"))
      )
    ).join("\n");
    expect(contents).not.toMatch(
      /(?:private\.example|\/home\/local-owner|Local Owner|legacy-xmpp-bridge|Local Agent)/i
    );
  });

  it("ships a manifest aligned with the runtime id and channel", async () => {
    const manifest = JSON.parse(
      await readFile(
        resolve(import.meta.dirname, "../openclaw.plugin.json"),
        "utf8"
      )
    ) as {
      id: string;
      channels: string[];
      activation: { onStartup: boolean };
      channelConfigs: {
        xmpp: {
          schema: {
            properties: Record<string, unknown>;
            definitions: {
              account: { properties: Record<string, unknown> };
            };
          };
        };
      };
    };
    expect(manifest.id).toBe("xmpp");
    expect(manifest.channels).toEqual(["xmpp"]);
    expect(manifest.activation.onStartup).toBe(false);
    const expectedTextChunkLimitSchema = {
      type: "integer",
      minimum: 1,
      maximum: 100000
    };
    expect(
      manifest.channelConfigs.xmpp.schema.properties.textChunkLimit
    ).toEqual(expectedTextChunkLimitSchema);
    expect(
      manifest.channelConfigs.xmpp.schema.definitions.account.properties
        .textChunkLimit
    ).toEqual(expectedTextChunkLimitSchema);
  });
});

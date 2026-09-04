import { describe, expect, it, vi } from "vitest";

import type { XmppConnectionConfig } from "../src/config.js";
import { XmppTransport } from "../src/transport.js";

const config: XmppConnectionConfig = {
  accountId: "default",
  jid: "bot@example.org",
  domain: "example.org",
  username: "bot",
  password: "secret",
  resource: "openclaw",
  service: "xmpp://example.org:5222",
  dmPolicy: "allowlist",
  allowFrom: ["alice@example.org"],
  sendReceipts: true,
  requestReceipts: true,
  sendChatStates: true,
  mediaMaxBytes: 10 * 1024 * 1024,
  healthProbe: false,
  healthProbeIntervalMs: 300_000,
  healthProbeTimeoutMs: 15_000,
  reconnectDelayMs: 1_000
};

function transport() {
  return new XmppTransport(config, {
    onMessage: vi.fn(async () => undefined),
    onStatus: vi.fn(),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  });
}

describe("XMPP inline media delivery", () => {
  it("refuses local media unless OpenClaw provides its validated reader", async () => {
    const xmpp = transport();
    await expect(xmpp.sendMedia({
      to: "alice@example.org",
      text: "",
      mediaUrl: "/outside/unchecked.png"
    })).rejects.toThrow(/validated media reader/);
  });
  it("sends a caption first and a URL-only fallback media stanza second", async () => {
    const xmpp = transport();
    const sendText = vi
      .spyOn(xmpp, "sendText")
      .mockImplementation(async (to, _text, options = {}) => ({
        id: options.sharedFile ? "media-1" : "caption-1",
        to,
        ...(options.oobUrl ? { url: options.oobUrl } : {})
      }));
    const url = "https://upload.example.org/plot.png";

    const sent = await xmpp.sendMedia({
      to: "alice@example.org",
      text: "Here is the plot.",
      mediaUrl: url,
      contentType: "image/png"
    });

    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "alice@example.org",
      "Here is the plot."
    );
    expect(sendText).toHaveBeenNthCalledWith(2, "alice@example.org", url, {
      oobUrl: url,
      sharedFile: {
        url,
        name: "plot.png",
        mediaType: "image/png"
      }
    });
    expect(sent).toMatchObject({ id: "media-1", url });
  });

  it("does not duplicate an empty or URL-valued caption", async () => {
    for (const caption of ["", "https://upload.example.org/plot.png"]) {
      const xmpp = transport();
      const sendText = vi
        .spyOn(xmpp, "sendText")
        .mockResolvedValue({ id: "media-1", to: "alice@example.org" });
      const url = "https://upload.example.org/plot.png";

      await xmpp.sendMedia({
        to: "alice@example.org",
        text: caption,
        mediaUrl: url,
        contentType: "image/png"
      });

      expect(sendText).toHaveBeenCalledOnce();
      expect(sendText).toHaveBeenCalledWith(
        "alice@example.org",
        url,
        expect.objectContaining({ oobUrl: url })
      );
    }
  });
});

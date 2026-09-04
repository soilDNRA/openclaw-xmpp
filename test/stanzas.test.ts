import { xml } from "@xmpp/client";
import { describe, expect, it } from "vitest";

import { NS } from "../src/constants.js";
import {
  buildChatState,
  buildReceipt,
  buildTextMessage,
  parseInboundMessage
} from "../src/stanzas.js";

describe("XMPP stanza mapping", () => {
  it("parses direct messages with stanza ids, delays, and receipt requests", () => {
    const stanza = xml(
      "message",
      {
        from: "alice@example.org/phone",
        to: "bot@example.org/openclaw",
        type: "chat",
        id: "client-id"
      },
      xml("body", {}, " hello "),
      xml("stanza-id", {
        xmlns: NS.sid,
        by: "example.org",
        id: "server-id"
      }),
      xml("delay", {
        xmlns: NS.delay,
        stamp: "2026-07-30T10:00:00Z"
      }),
      xml("request", { xmlns: NS.receipts })
    );
    expect(parseInboundMessage(stanza, "bot@example.org")).toEqual({
      id: "server-id",
      from: "alice@example.org/phone",
      fromBare: "alice@example.org",
      to: "bot@example.org/openclaw",
      body: "hello",
      timestamp: Date.parse("2026-07-30T10:00:00Z"),
      receiptRequested: true,
      receiptId: "client-id"
    });
  });

  it("keeps the sender id separate from the server stanza id for receipts", () => {
    const parsed = parseInboundMessage(
      xml(
        "message",
        { from: "alice@example.org/phone", id: "sender-id" },
        xml("body", {}, "hello"),
        xml("stanza-id", { xmlns: NS.sid, by: "example.org", id: "archive-id" }),
        xml("request", { xmlns: NS.receipts })
      ),
      "bot@example.org"
    );

    expect(parsed?.id).toBe("archive-id");
    expect(parsed?.receiptId).toBe("sender-id");
  });

  it("ignores groupchat, empty, receipt-only, and self messages", () => {
    expect(
      parseInboundMessage(
        xml(
          "message",
          { type: "groupchat", from: "room@example.org/alice" },
          xml("body", {}, "hello")
        ),
        "bot@example.org"
      )
    ).toBeUndefined();
    expect(
      parseInboundMessage(
        xml(
          "message",
          { type: "chat", from: "alice@example.org" },
          xml("received", { xmlns: NS.receipts, id: "x" })
        ),
        "bot@example.org"
      )
    ).toBeUndefined();
    expect(
      parseInboundMessage(
        xml(
          "message",
          { type: "chat", from: "bot@example.org/other" },
          xml("body", {}, "loop")
        ),
        "bot@example.org"
      )
    ).toBeUndefined();
  });

  it("builds origin ids, receipt requests, OOB URLs, receipts, and chat states", () => {
    const sent = buildTextMessage({
      to: "alice@example.org",
      text: "photo",
      id: "out-1",
      requestReceipt: true,
      oobUrl: "https://upload.example.org/photo.png"
    });
    expect(sent.id).toBe("out-1");
    expect(sent.stanza.getChildText("body")).toBe("photo");
    expect(sent.stanza.getChild("origin-id", NS.sid)?.attrs.id).toBe("out-1");
    expect(sent.stanza.getChild("request", NS.receipts)).toBeTruthy();
    expect(
      sent.stanza
        .getChild("x", NS.oob)
        ?.getChildText("url")
    ).toBe("https://upload.example.org/photo.png");

    expect(
      buildReceipt({ to: "alice@example.org", id: "in-1" })
        .getChild("received", NS.receipts)
        ?.attrs.id
    ).toBe("in-1");
    expect(
      buildChatState({ to: "alice@example.org", state: "composing" }).getChild(
        "composing",
        NS.chatStates
      )
    ).toBeTruthy();
  });

  it("builds XEP-0447 inline file sharing with XEP-0446 metadata", () => {
    const url = "https://upload.example.org/plot.png";
    const sent = buildTextMessage({
      to: "alice@example.org",
      text: url,
      id: "media-1",
      oobUrl: url,
      sharedFile: {
        url,
        name: "plot.png",
        mediaType: "image/png",
        size: 1234,
        sha256: "c2hhMjU2"
      }
    });
    const sharing = sent.stanza.getChild("file-sharing", NS.sfs);
    expect(sharing?.attrs.disposition).toBe("inline");
    const file = sharing?.getChild("file", NS.fileMetadata);
    expect(file?.getChildText("media-type")).toBe("image/png");
    expect(file?.getChildText("name")).toBe("plot.png");
    expect(file?.getChildText("size")).toBe("1234");
    const hash = file?.getChild("hash", NS.hashes);
    expect(hash?.attrs.algo).toBe("sha-256");
    expect(hash?.text()).toBe("c2hhMjU2");
    expect(
      sharing
        ?.getChild("sources", NS.sfs)
        ?.getChild("url-data", NS.urlData)?.attrs.target
    ).toBe(url);
    expect(
      sent.stanza.getChild("fallback", NS.fallback)?.attrs.for
    ).toBe(NS.sfs);
  });

  it("preserves a real caption without marking it as fallback text", () => {
    const sent = buildTextMessage({
      to: "alice@example.org",
      text: "Here is the plot.",
      sharedFile: {
        url: "https://upload.example.org/plot.png",
        name: "plot.png",
        mediaType: "image/png"
      }
    });
    expect(sent.stanza.getChildText("body")).toBe("Here is the plot.");
    expect(sent.stanza.getChild("file-sharing", NS.sfs)).toBeTruthy();
    expect(sent.stanza.getChild("fallback", NS.fallback)).toBeUndefined();
  });
});

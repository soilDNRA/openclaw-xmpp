import { randomUUID } from "node:crypto";

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import { NS } from "./constants.js";
import { normalizeBareJid, normalizeFullJid } from "./jid.js";

export interface InboundXmppMessage {
  id: string;
  from: string;
  fromBare: string;
  to?: string;
  body: string;
  timestamp?: number;
  receiptRequested: boolean;
  receiptId?: string;
}

export interface SharedFileMetadata {
  url: string;
  name: string;
  mediaType: string;
  size?: number;
  sha256?: string;
}

export function parseInboundMessage(
  stanza: Element,
  ownBareJid: string
): InboundXmppMessage | undefined {
  if (!stanza.is("message")) {
    return undefined;
  }
  const type = stanza.attrs.type ?? "normal";
  if (type === "groupchat" || type === "error" || type === "headline") {
    return undefined;
  }
  const body = stanza.getChildText("body")?.trim();
  if (!body) {
    return undefined;
  }
  const from = normalizeFullJid(String(stanza.attrs.from ?? ""));
  const fromBare = from ? normalizeBareJid(from) : undefined;
  if (!from || !fromBare || fromBare === normalizeBareJid(ownBareJid)) {
    return undefined;
  }
  const to = normalizeFullJid(String(stanza.attrs.to ?? ""));
  const stanzaId = stanza
    .getChildren("stanza-id", NS.sid)
    .map((entry) => entry.attrs.id)
    .find((id): id is string => typeof id === "string" && id.length > 0);
  const originId = stanza.getChild("origin-id", NS.sid)?.attrs.id;
  const attrId =
    typeof stanza.attrs.id === "string" && stanza.attrs.id
      ? stanza.attrs.id
      : undefined;
  const id = stanzaId ?? originId ?? attrId ?? randomUUID();
  const delayStamp = stanza.getChild("delay", NS.delay)?.attrs.stamp;
  const parsedDelay =
    typeof delayStamp === "string" ? Date.parse(delayStamp) : Number.NaN;

  return {
    id,
    from,
    fromBare,
    ...(to ? { to } : {}),
    body,
    ...(Number.isFinite(parsedDelay) ? { timestamp: parsedDelay } : {}),
    receiptRequested: Boolean(stanza.getChild("request", NS.receipts)),
    ...(attrId ? { receiptId: attrId } : {})
  };
}

export function buildTextMessage(params: {
  to: string;
  text: string;
  id?: string;
  requestReceipt?: boolean;
  oobUrl?: string;
  sharedFile?: SharedFileMetadata;
}): { id: string; stanza: Element } {
  const id = params.id ?? randomUUID();
  const children: Element[] = [
    xml("body", {}, params.text),
    xml("origin-id", { xmlns: NS.sid, id })
  ];
  if (params.requestReceipt) {
    children.push(xml("request", { xmlns: NS.receipts }));
  }
  if (params.oobUrl) {
    children.push(
      xml(
        "x",
        { xmlns: NS.oob },
        xml("url", {}, params.oobUrl),
        xml("desc", {}, params.text)
      )
    );
  }
  if (params.sharedFile) {
    const metadataChildren: Element[] = [
      xml(
        "media-type",
        { xmlns: NS.fileMetadata },
        params.sharedFile.mediaType
      ),
      xml("name", { xmlns: NS.fileMetadata }, params.sharedFile.name)
    ];
    if (params.sharedFile.size !== undefined) {
      metadataChildren.push(
        xml("size", { xmlns: NS.fileMetadata }, String(params.sharedFile.size))
      );
    }
    if (params.sharedFile.sha256) {
      metadataChildren.push(
        xml(
          "hash",
          { xmlns: NS.hashes, algo: "sha-256" },
          params.sharedFile.sha256
        )
      );
    }
    children.push(
      xml(
        "file-sharing",
        { xmlns: NS.sfs, disposition: "inline" },
        xml("file", { xmlns: NS.fileMetadata }, ...metadataChildren),
        xml(
          "sources",
          { xmlns: NS.sfs },
          xml("url-data", {
            xmlns: NS.urlData,
            target: params.sharedFile.url
          })
        )
      )
    );
    if (params.text === params.sharedFile.url) {
      children.push(
        xml(
          "fallback",
          { xmlns: NS.fallback, for: NS.sfs },
          xml("body", {})
        )
      );
    }
  }
  return {
    id,
    stanza: xml("message", { to: params.to, type: "chat", id }, ...children)
  };
}

export function buildReceipt(params: {
  to: string;
  id: string;
}): Element {
  return xml(
    "message",
    { to: params.to, type: "chat" },
    xml("received", { xmlns: NS.receipts, id: params.id })
  );
}

export function buildChatState(params: {
  to: string;
  state: "active" | "composing" | "paused" | "inactive" | "gone";
}): Element {
  return xml(
    "message",
    { to: params.to, type: "chat" },
    xml(params.state, { xmlns: NS.chatStates })
  );
}

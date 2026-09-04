export const CHANNEL_ID = "xmpp" as const;
export const DEFAULT_ACCOUNT_ID = "default";
export const DEFAULT_RESOURCE = "openclaw";
export const DEFAULT_MEDIA_MAX_MB = 25;
export const DEFAULT_TEXT_CHUNK_LIMIT = 4_000;
export const DEFAULT_DEDUPE_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DEDUPE_MAX_ENTRIES = 10_000;

export const NS = {
  chatStates: "http://jabber.org/protocol/chatstates",
  delay: "urn:xmpp:delay",
  discoInfo: "http://jabber.org/protocol/disco#info",
  discoItems: "http://jabber.org/protocol/disco#items",
  fallback: "urn:xmpp:fallback:0",
  fileMetadata: "urn:xmpp:file:metadata:0",
  hashes: "urn:xmpp:hashes:2",
  httpUpload: "urn:xmpp:http:upload:0",
  oob: "jabber:x:oob",
  receipts: "urn:xmpp:receipts",
  sfs: "urn:xmpp:sfs:0",
  sid: "urn:xmpp:sid:0",
  urlData: "http://jabber.org/protocol/url-data"
} as const;

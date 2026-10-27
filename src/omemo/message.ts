import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { parse as parseXml } from "ltx";

import { normalizeBareJid } from "../jid.js";
import { LEGACY_OMEMO, OMEMO_2, type OmemoVersion } from "./engine.js";
import { LibomemoStoreAdapter, type OmemoTrustMode } from "./libomemo-store.js";
import { type OmemoRecordView, type OmemoTransactionalStore, type PendingInbound, type PendingOutbound } from "./store.js";

const HINTS = "urn:xmpp:hints";
const STANZA_IDS = "urn:xmpp:sid:0";
const SCE = "urn:xmpp:sce:1";
const CLIENT = "jabber:client";
const MAX_DEVICE_ID = 0x7fff_ffff;
const MAX_KEYS = 2_000;
const MAX_PAYLOAD = 16 * 1024 * 1024;

export interface OmemoEncryptedKey { rid: number; data: Uint8Array; keyExchange?: boolean }
export interface OmemoEncryptedKeyGroup { jid?: string; keys: OmemoEncryptedKey[] }
export interface OmemoEncryptedEnvelope {
  version: OmemoVersion;
  senderDeviceId: number;
  keyGroups: OmemoEncryptedKeyGroup[];
  iv?: Uint8Array;
  payload?: Uint8Array;
}

export interface OmemoRecipientDevices { jid: string; deviceIds: readonly number[] }
export interface OmemoSessionEncryptResult { body: string; type: number; kex?: boolean }
export interface OmemoOutboundBindings {
  createSessionCipher(store: LibomemoStoreAdapter, address: string, version: OmemoVersion): {
    encrypt(plaintext: Uint8Array): Promise<OmemoSessionEncryptResult>;
  };
}

export interface OmemoSessionDecryptResult { plaintext: ArrayBuffer; ratchet?: unknown }
export interface OmemoInboundBindings {
  createSessionCipher(store: LibomemoStoreAdapter, address: string, version: OmemoVersion): {
    decryptWhisperMessage(ciphertext: Uint8Array, encoding: "binary"): Promise<OmemoSessionDecryptResult>;
    decryptPreKeyWhisperMessage(ciphertext: Uint8Array, encoding: "binary"): Promise<OmemoSessionDecryptResult>;
  };
}

export interface OmemoInboundMessage {
  id: string;
  from: string;
  text: string;
  version: OmemoVersion;
  senderDeviceId: number;
}

export interface OmemoInboundCoordinatorOptions {
  account: string;
  localDeviceId: number;
  store: OmemoTransactionalStore;
  bindings: OmemoInboundBindings;
  trustMode: OmemoTrustMode;
  refreshBundle?(version: OmemoVersion): Promise<void>;
}

/** Decrypts and commits the ratchet with a sealed delivery before dispatch. */
export class OmemoInboundCoordinator {
  readonly #account: string;
  readonly #localDeviceId: number;
  readonly #store: OmemoTransactionalStore;
  readonly #bindings: OmemoInboundBindings;
  readonly #trustMode: OmemoTrustMode;
  readonly #refreshBundle: ((version: OmemoVersion) => Promise<void>) | undefined;

  constructor(options: OmemoInboundCoordinatorOptions) {
    this.#account = bare(options.account, "account");
    this.#localDeviceId = deviceId(options.localDeviceId);
    this.#store = options.store;
    this.#bindings = options.bindings;
    this.#trustMode = options.trustMode;
    this.#refreshBundle = options.refreshBundle;
  }

  async decryptAndDispatch(stanza: Element, dispatch: (message: OmemoInboundMessage) => Promise<void>): Promise<OmemoInboundMessage | undefined> {
    if (!stanza.is("message")) return undefined;
    const type = stanza.attrs.type ?? "normal";
    if (type === "error") return undefined;
    if (type === "groupchat" || type === "headline" || (type !== "chat" && type !== "normal")) {
      throw new Error("Unsupported OMEMO message type.");
    }
    requireMessageAttrs(stanza);
    const from = bareJidFrom(stanza.attrs.from);
    const encrypted = encryptedChild(stanza);
    if (!encrypted) return undefined;
    const id = inboundStanzaId(stanza, from, encrypted);
    const version = encrypted.getNS() as OmemoVersion;
    const envelope = parseEncryptedEnvelope(version, encrypted);
    const wrapped = recipientKey(envelope, version, this.#account, this.#localDeviceId);
    const address = `${from}.${envelope.senderDeviceId}`;
    const pending = await this.#store.inbound(this.#account, id, from, async (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: this.#trustMode });
      const cipher = this.#bindings.createSessionCipher(adapter, address, version);
      const result = wrapped.keyExchange
        ? await cipher.decryptPreKeyWhisperMessage(wrapped.data, "binary")
        : await cipher.decryptWhisperMessage(wrapped.data, "binary");
      const material = arrayBuffer(result.plaintext, "decrypted key material");
      if (!envelope.payload) return new Uint8Array();
      return version === LEGACY_OMEMO
        ? decryptLegacyPayload(envelope.payload!, envelope.iv!, material)
        : decryptOmemo2Payload(envelope.payload!, material, from);
    });
    if (!envelope.payload) {
      if (wrapped.keyExchange) await this.#refreshBundle?.(version);
      this.#store.acknowledgeInbound(this.#account, id);
      return undefined;
    }
    const text = decodePlaintext(pending.plaintext);
    const message = { id, from, text, version, senderDeviceId: envelope.senderDeviceId };
    if (wrapped.keyExchange) await this.#refreshBundle?.(version);
    await dispatch(message);
    this.#store.acknowledgeInbound(this.#account, id);
    return message;
  }

  async dispatchPending(dispatch: (message: Pick<OmemoInboundMessage, "id" | "from" | "text">) => Promise<void>): Promise<number> {
    const pending = this.#store.listInbound(this.#account);
    for (const item of pending) {
      if (item.plaintext.byteLength === 0) {
        this.#store.acknowledgeInbound(this.#account, item.id);
        continue;
      }
      await dispatch({ id: item.id, from: item.sender, text: decodePlaintext(item.plaintext) });
      this.#store.acknowledgeInbound(this.#account, item.id);
    }
    return pending.length;
  }
}

export interface OmemoOutboundCoordinatorOptions {
  account: string;
  localDeviceId: number;
  store: OmemoTransactionalStore;
  bindings: OmemoOutboundBindings;
  trustMode: OmemoTrustMode;
  requireTrustedTargets?: boolean;
  random?: (length: number) => Uint8Array;
  id?: () => string;
}

/** Atomic ratchet/ciphertext boundary. This class does not build or trust sessions. */
export class OmemoOutboundCoordinator {
  readonly #account: string;
  readonly #localDeviceId: number;
  readonly #store: OmemoTransactionalStore;
  readonly #bindings: OmemoOutboundBindings;
  readonly #trustMode: OmemoTrustMode;
  readonly #requireTrustedTargets: boolean;
  readonly #random: (length: number) => Uint8Array;
  readonly #id: () => string;

  constructor(options: OmemoOutboundCoordinatorOptions) {
    this.#account = bare(options.account, "account");
    this.#localDeviceId = deviceId(options.localDeviceId);
    this.#store = options.store;
    this.#bindings = options.bindings;
    this.#trustMode = options.trustMode;
    this.#requireTrustedTargets = options.requireTrustedTargets ?? false;
    this.#random = options.random ?? ((length) => randomBytes(length));
    this.#id = options.id ?? randomUUID;
  }

  async encryptAndSend(input: {
    to: string;
    text: string;
    version: OmemoVersion;
    recipients: readonly OmemoRecipientDevices[];
    send(stanza: Element): Promise<void>;
  }): Promise<{ id: string; pending: PendingOutbound }> {
    const to = bare(input.to, "recipient");
    if (!input.text) throw new Error("OMEMO plaintext must not be empty.");
    const targets = planTargets(input.version, input.recipients, this.#account, this.#localDeviceId);
    if (!targets.some((target) => target.jid === to)) throw new Error("OMEMO recipient has no target devices.");
    const id = this.#id();
    if (!id || id.length > 1024) throw new Error("Invalid OMEMO stanza ID.");
    const pending = await this.#store.outbound(this.#account, id, to, async (view) => {
      const envelope = await this.#encryptEnvelope(input.version, input.text, targets, view);
      const stanza = xml("message", { to, type: "chat", id }, serializeEncryptedEnvelope(envelope), xml("store", { xmlns: HINTS }));
      return new TextEncoder().encode(stanza.toString());
    });
    const stanza = parseCommittedStanza(pending.stanza);
    await input.send(stanza);
    this.#store.acknowledgeOutbound(this.#account, id);
    return { id, pending };
  }

  async #encryptEnvelope(version: OmemoVersion, text: string, targets: PlannedTarget[], view: OmemoRecordView): Promise<OmemoEncryptedEnvelope> {
    const adapter = new LibomemoStoreAdapter(view, { mode: this.#trustMode });
    const content = version === LEGACY_OMEMO
      ? encryptLegacy(new TextEncoder().encode(text), this.#secureRandom(16), this.#secureRandom(12))
      : encryptOmemo2(sceEnvelope(text, this.#account), this.#secureRandom(32));
    const groups = new Map<string, OmemoEncryptedKey[]>();
    for (const target of targets) {
      const address = `${target.jid}.${target.deviceId}`;
      if (this.#requireTrustedTargets) {
        const identity = adapter.loadIdentityKey(address);
        if (!identity) throw new Error("OMEMO target identity disappeared.");
        adapter.trust.assertTrusted(address, identity, 1);
      }
      const cipher = this.#bindings.createSessionCipher(adapter, address, version);
      const encrypted = await cipher.encrypt(content.keyMaterial);
      const data = binaryString(encrypted.body);
      if (data.byteLength === 0) throw new Error("OMEMO session produced an empty encrypted key.");
      const keys = groups.get(target.jid) ?? [];
      keys.push({ rid: target.deviceId, data, ...(isKeyExchange(version, encrypted) ? { keyExchange: true } : {}) });
      groups.set(target.jid, keys);
    }
    const envelope: OmemoEncryptedEnvelope = {
      version,
      senderDeviceId: this.#localDeviceId,
      keyGroups: [...groups].map(([jid, keys]) => ({ ...(version === OMEMO_2 ? { jid } : {}), keys })),
      payload: content.payload
    };
    if (version === LEGACY_OMEMO) envelope.iv = (content as ReturnType<typeof encryptLegacy>).iv;
    return envelope;
  }

  #secureRandom(length: number): Uint8Array {
    const value = this.#random(length);
    if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new Error("Invalid OMEMO random source output.");
    return Uint8Array.from(value);
  }
}

export function serializeEncryptedEnvelope(value: OmemoEncryptedEnvelope): Element {
  validateVersion(value.version);
  const sid = deviceId(value.senderDeviceId);
  const count = value.keyGroups.reduce((sum, group) => sum + group.keys.length, 0);
  if (count < 1 || count > MAX_KEYS) throw new Error("Invalid OMEMO encrypted-key count.");
  const seen = new Set<string>();
  if (value.version === LEGACY_OMEMO) {
    if (value.iv?.byteLength !== 12) throw new Error("Legacy OMEMO requires a 12-byte IV.");
    const keys = value.keyGroups.flatMap((group) => group.keys).map((key) => keyElement(value.version, key, seen, ""));
    return xml("encrypted", { xmlns: value.version },
      xml("header", { sid: String(sid) }, ...keys, xml("iv", {}, base64(value.iv))),
      ...(value.payload ? [xml("payload", {}, payload(value.payload))] : []));
  }
  if (value.iv !== undefined) throw new Error("OMEMO 2 does not carry an XML IV.");
  const groups = value.keyGroups.map((group) => {
    const jid = bare(group.jid ?? "", "key-group JID");
    if (group.keys.length === 0) throw new Error("OMEMO 2 key group must not be empty.");
    return xml("keys", { jid }, ...group.keys.map((key) => keyElement(value.version, key, seen, jid)));
  });
  return xml("encrypted", { xmlns: value.version }, xml("header", { sid: String(sid) }, ...groups),
    ...(value.payload ? [xml("payload", {}, payload(value.payload))] : []));
}

export function parseEncryptedEnvelope(version: OmemoVersion, element: Element): OmemoEncryptedEnvelope {
  validateVersion(version);
  if (!element.is("encrypted", version) || Object.keys(element.attrs).some((key) => key !== "xmlns")) throw new Error("Invalid OMEMO encrypted element.");
  const children = element.getChildElements();
  const headers = children.filter((child) => child.is("header", version));
  const payloads = children.filter((child) => child.is("payload", version));
  if (headers.length !== 1 || payloads.length > 1 || children.length !== 1 + payloads.length) throw new Error("Malformed OMEMO encrypted structure.");
  const header = headers[0]!;
  requireAttrs(header, ["sid"]);
  const senderDeviceId = integerString(header.attrs.sid, "sender device ID");
  const seen = new Set<string>();
  let keyGroups: OmemoEncryptedKeyGroup[];
  let iv: Uint8Array | undefined;
  if (version === LEGACY_OMEMO) {
    const ivs = header.getChildren("iv", version);
    const keys = header.getChildren("key", version);
    if (ivs.length !== 1 || keys.length < 1 || header.getChildElements().length !== keys.length + 1) throw new Error("Malformed legacy OMEMO header.");
    iv = decodeElement(ivs[0]!, 12, 12, "IV");
    keyGroups = [{ keys: keys.map((key) => parseKey(version, key, seen, "")) }];
  } else {
    const groups = header.getChildren("keys", version);
    if (groups.length < 1 || groups.length !== header.getChildElements().length) throw new Error("Malformed OMEMO 2 header.");
    keyGroups = groups.map((group) => {
      requireAttrs(group, ["jid"]);
      const jid = bare(group.attrs.jid ?? "", "key-group JID");
      const keys = group.getChildren("key", version);
      if (keys.length < 1 || keys.length !== group.getChildElements().length) throw new Error("Malformed OMEMO 2 key group.");
      return { jid, keys: keys.map((key) => parseKey(version, key, seen, jid)) };
    });
  }
  if (seen.size > MAX_KEYS) throw new Error("OMEMO encrypted-key count exceeds limit.");
  const encryptedPayload = payloads[0] ? decodeElement(payloads[0], 1, MAX_PAYLOAD, "payload") : undefined;
  return { version, senderDeviceId, keyGroups, ...(iv ? { iv } : {}), ...(encryptedPayload ? { payload: encryptedPayload } : {}) };
}

interface PlannedTarget { jid: string; deviceId: number }
function planTargets(version: OmemoVersion, recipients: readonly OmemoRecipientDevices[], account: string, ownId: number): PlannedTarget[] {
  validateVersion(version);
  if (recipients.length === 0) throw new Error("OMEMO has no recipient device lists.");
  const result: PlannedTarget[] = [];
  const seen = new Set<string>();
  for (const recipient of recipients) {
    const jid = bare(recipient.jid, "recipient device-list JID");
    for (const rawId of recipient.deviceIds) {
      const id = deviceId(rawId);
      if (jid === account && id === ownId) continue;
      const address = `${jid}.${id}`;
      if (seen.has(address)) throw new Error("OMEMO target device is duplicated.");
      seen.add(address);
      result.push({ jid, deviceId: id });
    }
  }
  if (result.length === 0 || result.length > MAX_KEYS) throw new Error("Invalid OMEMO target-device count.");
  return result.sort((a, b) => a.jid.localeCompare(b.jid) || a.deviceId - b.deviceId);
}

function encryptLegacy(plaintext: Uint8Array, key: Uint8Array, iv: Uint8Array): { keyMaterial: Uint8Array; payload: Uint8Array; iv: Uint8Array } {
  const cipher = createCipheriv("aes-128-gcm", key, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { keyMaterial: Buffer.concat([key, cipher.getAuthTag()]), payload: ciphertext, iv };
}
function encryptOmemo2(plaintext: Uint8Array, key: Uint8Array): { keyMaterial: Uint8Array; payload: Uint8Array } {
  const derived = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(32), "OMEMO Payload", 80));
  const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(64, 80));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", derived.subarray(32, 64)).update(ciphertext).digest().subarray(0, 16);
  return { keyMaterial: Buffer.concat([key, mac]), payload: ciphertext };
}
function decryptLegacyPayload(payloadBytes: Uint8Array, iv: Uint8Array, material: Uint8Array): Uint8Array {
  if (material.byteLength !== 32) throw new Error("Invalid legacy OMEMO key material.");
  const decipher = createDecipheriv("aes-128-gcm", material.subarray(0, 16), iv, { authTagLength: 16 });
  decipher.setAuthTag(material.subarray(16));
  try { return Buffer.concat([decipher.update(payloadBytes), decipher.final()]); }
  catch { throw new Error("Legacy OMEMO payload authentication failed."); }
}
function decryptOmemo2Payload(payloadBytes: Uint8Array, material: Uint8Array, sender: string): Uint8Array {
  if (material.byteLength !== 48) throw new Error("Invalid OMEMO 2 key material.");
  const key = material.subarray(0, 32);
  const derived = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(32), "OMEMO Payload", 80));
  const mac = createHmac("sha256", derived.subarray(32, 64)).update(payloadBytes).digest().subarray(0, 16);
  if (!timingSafeEqual(mac, material.subarray(32))) throw new Error("OMEMO 2 payload authentication failed.");
  try {
    const decipher = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(64, 80));
    return parseSce(Buffer.concat([decipher.update(payloadBytes), decipher.final()]), sender);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid OMEMO 2 SCE")) throw error;
    throw new Error("OMEMO 2 payload decryption failed.");
  }
}
function parseSce(encoded: Uint8Array, sender: string): Uint8Array {
  let root: Element;
  try { root = parseXml(new TextDecoder("utf-8", { fatal: true }).decode(encoded)); }
  catch { throw new Error("Invalid OMEMO 2 SCE encoding."); }
  if (!root.is("envelope", SCE) || Object.keys(root.attrs).some((key) => key !== "xmlns")) throw new Error("Invalid OMEMO 2 SCE envelope.");
  const children = root.getChildElements();
  if (children.length !== 3 || !children[0]?.is("content", SCE) || !children[1]?.is("rpad", SCE) || !children[2]?.is("from", SCE)) throw new Error("Invalid OMEMO 2 SCE structure.");
  const [content, rpad, from] = children as [Element, Element, Element];
  requireAttrs(content, []); requireAttrs(rpad, []); requireAttrs(from, ["jid"]);
  if (bare(from.attrs.jid ?? "", "SCE sender") !== sender) throw new Error("Invalid OMEMO 2 SCE sender binding.");
  decodeElement(rpad, 1, 4096, "SCE random padding");
  const bodies = content.getChildren("body", CLIENT);
  if (bodies.length !== 1 || content.getChildElements().length !== 1) throw new Error("Invalid OMEMO 2 SCE content.");
  const body = bodies[0]!;
  requireAttrs(body, ["xmlns"]);
  if (body.getChildElements().length !== 0) throw new Error("Invalid OMEMO 2 SCE body.");
  return new TextEncoder().encode(body.getText());
}
function sceEnvelope(text: string, from: string): Uint8Array {
  const element = xml("envelope", { xmlns: SCE }, xml("content", {}, xml("body", { xmlns: CLIENT }, text)),
    xml("rpad", {}, base64(randomBytes(16))), xml("from", { jid: from }));
  return new TextEncoder().encode(element.toString());
}
function keyElement(version: OmemoVersion, key: OmemoEncryptedKey, seen: Set<string>, jid: string): Element {
  const rid = deviceId(key.rid);
  const identity = `${jid}\u0000${rid}`;
  if (seen.has(identity)) throw new Error("OMEMO encrypted key contains a duplicate recipient.");
  seen.add(identity);
  if (!(key.data instanceof Uint8Array) || key.data.byteLength === 0 || key.data.byteLength > MAX_PAYLOAD) throw new Error("Invalid OMEMO encrypted key.");
  const attrs: Record<string, string> = { rid: String(rid) };
  if (key.keyExchange) attrs[version === LEGACY_OMEMO ? "prekey" : "kex"] = "true";
  return xml("key", attrs, base64(key.data));
}
function parseKey(version: OmemoVersion, element: Element, seen: Set<string>, jid: string): OmemoEncryptedKey {
  requireAttrs(element, version === LEGACY_OMEMO ? ["rid", "prekey"] : ["rid", "kex"]);
  const rid = integerString(element.attrs.rid, "recipient device ID");
  const flag = element.attrs[version === LEGACY_OMEMO ? "prekey" : "kex"];
  if (flag !== undefined && flag !== "true") throw new Error("Invalid OMEMO key-exchange flag.");
  const identity = `${jid}\u0000${rid}`;
  if (seen.has(identity)) throw new Error("OMEMO encrypted key contains a duplicate recipient.");
  seen.add(identity);
  return { rid, data: decodeElement(element, 1, MAX_PAYLOAD, "encrypted key"), ...(flag === "true" ? { keyExchange: true } : {}) };
}
function isKeyExchange(version: OmemoVersion, result: OmemoSessionEncryptResult): boolean {
  return version === OMEMO_2 ? result.kex === true : result.type === 3;
}
function binaryString(value: string): Uint8Array {
  if (typeof value !== "string") throw new Error("OMEMO session returned an invalid encrypted key.");
  return Uint8Array.from(value, (character) => character.charCodeAt(0) & 0xff);
}
function arrayBuffer(value: unknown, name: string): Uint8Array {
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0 || value.byteLength > MAX_PAYLOAD) throw new Error(`Invalid OMEMO ${name}.`);
  return new Uint8Array(value);
}
function encryptedChild(stanza: Element): Element | undefined {
  const children = stanza.getChildElements().filter((child) => child.is("encrypted", LEGACY_OMEMO) || child.is("encrypted", OMEMO_2));
  if (children.length > 1) throw new Error("OMEMO message contains multiple encrypted payloads.");
  return children[0];
}
function inboundStanzaId(stanza: Element, from: string, encrypted: Element): string {
  const stanzaId = stanza.getChildren("stanza-id", STANZA_IDS)
    .map((element) => element.attrs.id)
    .find((value) => typeof value === "string" && value.length > 0);
  const originId = stanza.getChild("origin-id", STANZA_IDS)?.attrs.id;
  const candidate = stanzaId ?? originId ?? stanza.attrs.id;
  if (candidate !== undefined && candidate !== "") return requiredToken(candidate, "stanza ID");
  return `sha256:${createHash("sha256").update(from).update("\0").update(encrypted.toString()).digest("hex")}`;
}
function recipientKey(envelope: OmemoEncryptedEnvelope, version: OmemoVersion, account: string, localId: number): OmemoEncryptedKey {
  const groups = version === LEGACY_OMEMO ? envelope.keyGroups : envelope.keyGroups.filter((group) => group.jid === account);
  const keys = groups.flatMap((group) => group.keys).filter((key) => key.rid === localId);
  if (keys.length !== 1) throw new Error("OMEMO message does not contain exactly one key for this device.");
  return keys[0]!;
}
function requiredToken(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Invalid OMEMO ${name}.`);
  return value;
}
function bareJidFrom(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid OMEMO sender.");
  return bare(value.split("/", 1)[0] ?? "", "sender");
}
function requireMessageAttrs(stanza: Element): void {
  if (Object.keys(stanza.attrs).some((key) => !["from", "to", "type", "id", "xmlns", "xml:lang"].includes(key))) throw new Error("Unexpected OMEMO message attribute.");
  if (stanza.attrs["xml:lang"] !== undefined) requiredToken(stanza.attrs["xml:lang"], "message language");
}
function decodePlaintext(value: Uint8Array): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
    if (!text) throw new Error();
    return text;
  } catch { throw new Error("Invalid OMEMO plaintext encoding."); }
}
function parseCommittedStanza(stanza: Uint8Array): Element {
  // The exact bytes are already durable. Parsing solely reconstructs the Element
  // required by @xmpp/client without regenerating or modifying the ciphertext.
  const text = new TextDecoder("utf-8", { fatal: true }).decode(stanza);
  const element = parseXml(text);
  if (element.toString() !== text) throw new Error("Committed OMEMO stanza could not be reconstructed exactly.");
  return element;
}
function decodeElement(element: Element, min: number, max: number, name: string): Uint8Array {
  if (element.getChildElements().length !== 0 || element.children.some((child) => typeof child !== "string" && typeof child !== "number")) throw new Error(`Invalid OMEMO ${name} content.`);
  const raw = element.getText().replace(/[\t\n\r ]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)) throw new Error(`Invalid OMEMO ${name} base64.`);
  const value = Buffer.from(raw, "base64");
  if (value.toString("base64") !== raw || value.byteLength < min || value.byteLength > max) throw new Error(`Invalid OMEMO ${name}.`);
  return Uint8Array.from(value);
}
function payload(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > MAX_PAYLOAD) throw new Error("Invalid OMEMO payload.");
  return base64(value);
}
function base64(value: Uint8Array): string { return Buffer.from(value).toString("base64"); }
function requireAttrs(element: Element, allowed: string[]): void {
  if (Object.keys(element.attrs).some((key) => !allowed.includes(key))) throw new Error("Unexpected OMEMO encrypted XML attribute.");
}
function bare(value: string, name: string): string {
  const normalized = normalizeBareJid(value);
  if (!normalized || normalized !== value || value.includes("/")) throw new Error(`Invalid OMEMO ${name}.`);
  return normalized;
}
function deviceId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_DEVICE_ID) throw new Error("Invalid OMEMO device ID.");
  return value;
}
function integerString(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid OMEMO ${name}.`);
  return deviceId(Number(value));
}
function validateVersion(value: string): asserts value is OmemoVersion {
  if (value !== LEGACY_OMEMO && value !== OMEMO_2) throw new Error("Unsupported OMEMO version.");
}

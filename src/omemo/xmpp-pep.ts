import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import { normalizeBareJid } from "../jid.js";
import { LEGACY_OMEMO, OMEMO_2, type OmemoPublishedBundle, type OmemoVersion } from "./engine.js";
import { OmemoPepConflictError, OmemoPepPublisher, type OmemoPepAdapter, type OmemoPepItem } from "./pep.js";
import { bundleNode, deviceListNode, parseDeviceList, type OmemoDevice } from "./xml.js";

export const PUBSUB = "http://jabber.org/protocol/pubsub";
export const PUBSUB_EVENT = "http://jabber.org/protocol/pubsub#event";
export const PUBSUB_OWNER = "http://jabber.org/protocol/pubsub#owner";
export const DATA_FORMS = "jabber:x:data";
const STANZAS = "urn:ietf:params:xml:ns:xmpp-stanzas";
const DEVICE_ITEM = "current";
const MAX_BUNDLE_ITEMS = "max";

export interface OmemoIqCaller { request(stanza: Element): Promise<Element> }

/** Concrete IQ adapter for the transport-independent publication policy. */
export class XmppOmemoPepAdapter implements OmemoPepAdapter {
  constructor(readonly account: string, readonly iq: OmemoIqCaller) {
    if (!account.trim()) throw new Error("OMEMO PEP account must not be empty.");
  }

  async fetchDeviceList(version: OmemoVersion): Promise<OmemoPepItem | undefined> {
    return await this.#fetch(deviceListNode(version), DEVICE_ITEM);
  }

  async publishDeviceList(version: OmemoVersion, payload: Element, expectedRevision?: string): Promise<void> {
    await this.#publish(deviceListNode(version), DEVICE_ITEM, payload, expectedRevision);
  }

  async fetchBundle(version: OmemoVersion, deviceId: number): Promise<OmemoPepItem | undefined> {
    return await this.#fetch(bundleNode(version, deviceId), version === OMEMO_2 ? String(deviceId) : DEVICE_ITEM);
  }

  async publishBundle(version: OmemoVersion, deviceId: number, payload: Element, expectedRevision?: string): Promise<void> {
    await this.#publish(bundleNode(version, deviceId), version === OMEMO_2 ? String(deviceId) : DEVICE_ITEM, payload, expectedRevision);
  }

  async retractBundle(version: OmemoVersion, deviceId: number, expectedRevision?: string): Promise<void> {
    const node = bundleNode(version, deviceId);
    const itemId = version === OMEMO_2 ? String(deviceId) : DEVICE_ITEM;
    if (expectedRevision !== undefined) {
      const current = await this.#fetch(node, itemId);
      if (current?.revision !== expectedRevision) throw new OmemoPepConflictError();
    }
    try {
      await this.iq.request(xml("iq", { type: "set", to: this.account },
        xml("pubsub", { xmlns: PUBSUB }, xml("retract", { node }, xml("item", { id: itemId })))));
    } catch (error) {
      if (isItemNotFound(error)) return;
      if (isConflict(error)) throw new OmemoPepConflictError();
      throw error;
    }
  }

  async configureOmemo2Nodes(): Promise<void> {
    await this.#configure(deviceListNode(OMEMO_2), "1");
    await this.#configure(bundleNode(OMEMO_2, 1), MAX_BUNDLE_ITEMS);
  }

  async #fetch(node: string, itemId: string): Promise<OmemoPepItem | undefined> {
    let result: Element;
    try {
      result = await this.iq.request(xml("iq", { type: "get", to: this.account },
        xml("pubsub", { xmlns: PUBSUB }, xml("items", { node }, xml("item", { id: itemId })))));
    } catch (error) {
      if (isItemNotFound(error)) return undefined;
      throw error;
    }
    const pubsub = result.getChild("pubsub", PUBSUB);
    const items = pubsub?.getChild("items", PUBSUB);
    if (!pubsub || !items || items.attrs.node !== node) throw new Error("Malformed OMEMO PEP fetch response.");
    const entries = items.getChildren("item", PUBSUB);
    if (entries.length === 0) return undefined;
    if (entries.length !== 1 || entries[0]!.attrs.id !== itemId || entries[0]!.getChildElements().length !== 1) {
      throw new Error("Malformed OMEMO PEP item response.");
    }
    return { payload: entries[0]!.getChildElements()[0]!, revision: canonicalRevision(entries[0]!.getChildElements()[0]!) };
  }

  async #publish(node: string, itemId: string, payload: Element, expectedRevision?: string): Promise<void> {
    if (expectedRevision !== undefined) {
      const current = await this.#fetch(node, itemId);
      if (current?.revision !== expectedRevision) throw new OmemoPepConflictError();
    }
    try {
      await this.iq.request(xml("iq", { type: "set", to: this.account },
        xml("pubsub", { xmlns: PUBSUB }, xml("publish", { node }, xml("item", { id: itemId }, payload)))));
    } catch (error) {
      if (isConflict(error)) throw new OmemoPepConflictError();
      throw error;
    }
  }

  async #configure(node: string, maxItems: string): Promise<void> {
    await this.iq.request(xml("iq", { type: "set", to: this.account },
      xml("pubsub", { xmlns: PUBSUB_OWNER },
        xml("configure", { node },
          xml("x", { xmlns: DATA_FORMS, type: "submit" },
            field("FORM_TYPE", "http://jabber.org/protocol/pubsub#node_config", "hidden"),
            field("pubsub#access_model", "open"),
            field("pubsub#max_items", maxItems))))));
  }
}

/** Handles PEP device events and restores this process's missing advertisement. */
export class OmemoPepSession {
  readonly #publisher: OmemoPepPublisher;
  #reannouncing = new Map<OmemoVersion, Promise<void>>();
  readonly #retired = new Set<OmemoVersion>();
  readonly #retiring = new Set<OmemoVersion>();
  constructor(
    readonly adapter: XmppOmemoPepAdapter,
    readonly bundles: ReadonlyMap<OmemoVersion, OmemoPublishedBundle>,
    readonly devices: ReadonlyMap<OmemoVersion, Omit<OmemoDevice, "id">> = new Map(),
    retired: ReadonlySet<OmemoVersion> = new Set()
  ) {
    this.#publisher = new OmemoPepPublisher({ adapter });
    for (const version of retired) this.#retired.add(version);
  }

  async initialize(): Promise<void> {
    for (const bundle of this.bundles.values()) {
      if (!this.#retired.has(bundle.version)) await this.#publisher.publish(bundle, this.devices.get(bundle.version));
    }
    // Prosody creates PEP nodes on first publish. Configure the OMEMO 2 nodes
    // only after both payloads exist, while still completing before presence.
    if (this.bundles.has(OMEMO_2) && !this.#retired.has(OMEMO_2)) await this.adapter.configureOmemo2Nodes();
  }

  async retire(version: OmemoVersion, deviceId: number): Promise<void> {
    if (this.#retiring.has(version)) throw new Error("OMEMO device retirement is already in progress.");
    this.#retired.add(version);
    this.#retiring.add(version);
    try {
      await this.#publisher.retire(version, deviceId);
    } finally {
      this.#retiring.delete(version);
    }
  }

  async activate(version: OmemoVersion, expectedDeviceId: number): Promise<void> {
    const bundle = this.bundles.get(version);
    if (!bundle || bundle.deviceId !== expectedDeviceId) {
      throw new Error("OMEMO activation target does not match the local bundle.");
    }
    await this.#publisher.publish(bundle, this.devices.get(version));
    if (version === OMEMO_2) await this.adapter.configureOmemo2Nodes();
    this.#retired.delete(version);
  }

  async handleEvent(stanza: Element): Promise<boolean> {
    const event = parseDeviceListEvent(stanza);
    if (!event) return false;
    // Only our own PEP service may cause this process to restore its local
    // advertisement. A contact can publish the same node names on their PEP
    // service and must not be able to trigger writes to our account.
    if (normalizeBareJid(String(stanza.attrs.from ?? "")) !== normalizeBareJid(this.adapter.account)) return true;
    if (this.#retiring.has(event.version) || this.#retired.has(event.version)) return true;
    const bundle = this.bundles.get(event.version);
    if (!bundle || event.devices.some((device) => device.id === bundle.deviceId)) return true;
    const pending = this.#reannouncing.get(event.version);
    if (pending) { await pending; return true; }
    const operation = this.#publisher.publish(bundle, this.devices.get(event.version));
    this.#reannouncing.set(event.version, operation);
    try { await operation; } finally { this.#reannouncing.delete(event.version); }
    return true;
  }
}

export function parseDeviceListEvent(stanza: Element): { version: OmemoVersion; devices: OmemoDevice[] } | undefined {
  if (!stanza.is("message") || (stanza.attrs.type !== undefined && stanza.attrs.type !== "headline")) return undefined;
  const event = stanza.getChild("event", PUBSUB_EVENT);
  if (!event) return undefined;
  const items = event.getChild("items", PUBSUB_EVENT);
  if (!items) return undefined;
  const version: OmemoVersion | undefined = items.attrs.node === deviceListNode(LEGACY_OMEMO)
    ? LEGACY_OMEMO
    : items.attrs.node === deviceListNode(OMEMO_2)
      ? OMEMO_2
      : undefined;
  if (!version) return undefined;
  const entries = items.getChildren("item", PUBSUB_EVENT);
  if (entries.length !== 1 || entries[0]!.attrs.id !== DEVICE_ITEM || entries[0]!.getChildElements().length !== 1) {
    throw new Error("Malformed OMEMO PEP device-list event.");
  }
  return { version, devices: parseDeviceList(version, entries[0]!.getChildElements()[0]!) };
}

function field(name: string, value: string, type?: string): Element {
  return xml("field", { var: name, ...(type ? { type } : {}) }, xml("value", {}, value));
}
function canonicalRevision(payload: Element): string { return payload.toString(); }
function errorElement(error: unknown): Element | undefined {
  const stanza = typeof error === "object" && error !== null && "stanza" in error ? (error as { stanza?: unknown }).stanza : undefined;
  return stanza && typeof stanza === "object" && "getChild" in stanza ? stanza as Element : undefined;
}
function isItemNotFound(error: unknown): boolean {
  return errorCondition(error) === "item-not-found" || Boolean(errorElement(error)?.getChild("error")?.getChild("item-not-found", STANZAS));
}
function isConflict(error: unknown): boolean {
  return errorCondition(error) === "conflict" || Boolean(errorElement(error)?.getChild("error")?.getChild("conflict", STANZAS));
}
function errorCondition(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "condition" in error && typeof (error as { condition?: unknown }).condition === "string"
    ? (error as { condition: string }).condition
    : undefined;
}

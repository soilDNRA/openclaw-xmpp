import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { describe, expect, it, vi } from "vitest";

import { LEGACY_OMEMO, OMEMO_2, type OmemoPublishedBundle } from "../src/omemo/engine.js";
import { serializeBundle, serializeDeviceList } from "../src/omemo/xml.js";
import { DATA_FORMS, OmemoPepSession, PUBSUB, PUBSUB_EVENT, PUBSUB_OWNER, XmppOmemoPepAdapter, parseDeviceListEvent } from "../src/omemo/xmpp-pep.js";
import { OmemoPepConflictError } from "../src/omemo/pep.js";

function bytes(length: number, fill: number): ArrayBuffer { return Uint8Array.from({ length }, () => fill).buffer; }
function bundle(version: typeof LEGACY_OMEMO | typeof OMEMO_2, deviceId = 77): OmemoPublishedBundle {
  const length = version === LEGACY_OMEMO ? 33 : 32;
  return { version, deviceId, identityKey: bytes(length, 1), signedPreKey: { id: 2, publicKey: bytes(length, 2), signature: bytes(64, 3) }, preKeys: [{ id: 3, publicKey: bytes(length, 4) }] };
}
function result(node: string, id: string, payload?: Element): Element {
  return xml("iq", { type: "result" }, xml("pubsub", { xmlns: PUBSUB },
    xml("items", { node }, ...(payload ? [xml("item", { id }, payload)] : []))));
}
function event(version: typeof LEGACY_OMEMO | typeof OMEMO_2, devices: number[], from = "bot@example.org"): Element {
  const payload = serializeDeviceList(version, devices.map((id) => ({ id })));
  return xml("message", { type: "headline", from }, xml("event", { xmlns: PUBSUB_EVENT },
    xml("items", { node: version === LEGACY_OMEMO ? `${version}.devicelist` : `${version}:devices` },
      xml("item", { id: "current" }, payload))));
}

describe("XMPP OMEMO PEP boundary", () => {
  it("constructs profile-specific item IQs and strictly parses responses", async () => {
    const value = bundle(OMEMO_2);
    const request = vi.fn(async (stanza: Element): Promise<Element> => {
      const items = stanza.getChild("pubsub", PUBSUB)?.getChild("items", PUBSUB);
      return result(String(items!.attrs.node), String(items!.getChild("item", PUBSUB)!.attrs.id), serializeBundle(value));
    });
    const adapter = new XmppOmemoPepAdapter("bot@example.org", { request });
    const fetched = await adapter.fetchBundle(OMEMO_2, 77);
    expect(fetched?.payload?.toString()).toBe(serializeBundle(value).toString());
    const iq = request.mock.calls[0]![0];
    expect(iq.attrs).toMatchObject({ type: "get", to: "bot@example.org" });
    expect(iq.toString()).toContain('node="urn:xmpp:omemo:2:bundles"');
    expect(iq.toString()).toContain('<item id="77"/>');

    request.mockResolvedValueOnce(result("wrong", "77", serializeBundle(value)));
    await expect(adapter.fetchBundle(OMEMO_2, 77)).rejects.toThrow("Malformed OMEMO PEP fetch response");
  });

  it("maps the exact @xmpp IQ error contract to missing items and publication conflicts", async () => {
    const missing = Object.assign(new Error("item-not-found"), { condition: "item-not-found" });
    const conflict = Object.assign(new Error("conflict"), { condition: "conflict" });
    const request = vi.fn<(stanza: Element) => Promise<Element>>()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce(result(`${OMEMO_2}:devices`, "current", serializeDeviceList(OMEMO_2, [{ id: 4 }])))
      .mockRejectedValueOnce(conflict);
    const adapter = new XmppOmemoPepAdapter("bot@example.org", { request });
    await expect(adapter.fetchDeviceList(OMEMO_2)).resolves.toBeUndefined();
    await expect(adapter.publishDeviceList(OMEMO_2, serializeDeviceList(OMEMO_2, [{ id: 5 }]), serializeDeviceList(OMEMO_2, [{ id: 4 }]).toString()))
      .rejects.toBeInstanceOf(OmemoPepConflictError);
  });

  it("retracts the exact profile bundle item after a revision check", async () => {
    const value = bundle(OMEMO_2);
    const request = vi.fn<(stanza: Element) => Promise<Element>>()
      .mockResolvedValueOnce(result(`${OMEMO_2}:bundles`, "77", serializeBundle(value)))
      .mockResolvedValueOnce(xml("iq", { type: "result" }));
    const adapter = new XmppOmemoPepAdapter("bot@example.org", { request });
    await adapter.retractBundle(OMEMO_2, 77, serializeBundle(value).toString());
    const retract = request.mock.calls[1]![0].getChild("pubsub", PUBSUB)?.getChild("retract", PUBSUB);
    expect(retract?.attrs.node).toBe(`${OMEMO_2}:bundles`);
    expect(retract?.getChild("item", PUBSUB)?.attrs.id).toBe("77");
  });

  it("configures OMEMO 2 nodes for open access and retained bundle items", async () => {
    const request = vi.fn(async (_stanza: Element): Promise<Element> => xml("iq", { type: "result" }));
    await new XmppOmemoPepAdapter("bot@example.org", { request }).configureOmemo2Nodes();
    expect(request).toHaveBeenCalledTimes(2);
    for (const call of request.mock.calls) {
      const configure = call[0].getChild("pubsub", PUBSUB_OWNER)?.getChild("configure", PUBSUB_OWNER);
      const form = configure?.getChild("x", DATA_FORMS);
      expect(call[0].attrs.type).toBe("set");
      expect(form?.attrs.type).toBe("submit");
      expect(form?.toString()).toContain("pubsub#access_model");
      expect(form?.toString()).toContain("open");
    }
    expect(request.mock.calls[0]![0].toString()).toContain("pubsub#max_items");
    expect(request.mock.calls[0]![0].toString()).toContain("<value>1</value>");
    expect(request.mock.calls[1]![0].toString()).toContain("<value>max</value>");
  });

  it("publishes fresh PEP nodes before configuring them", async () => {
    const requests: Element[] = [];
    const existing = new Set<string>();
    const adapter = new XmppOmemoPepAdapter("bot@example.org", { request: async (stanza) => {
      requests.push(stanza);
      const pubsub = stanza.getChild("pubsub", PUBSUB);
      const items = pubsub?.getChild("items", PUBSUB);
      if (items) {
        const node = String(items.attrs.node);
        if (!existing.has(node)) throw Object.assign(new Error("Node not found"), { condition: "item-not-found" });
        return result(node, String(items.getChild("item", PUBSUB)!.attrs.id));
      }
      const publish = pubsub?.getChild("publish", PUBSUB);
      if (publish) existing.add(String(publish.attrs.node));
      const configure = stanza.getChild("pubsub", PUBSUB_OWNER)?.getChild("configure", PUBSUB_OWNER);
      if (configure && !existing.has(String(configure.attrs.node))) {
        throw Object.assign(new Error("Node not found"), { condition: "item-not-found" });
      }
      return xml("iq", { type: "result" });
    } });
    const session = new OmemoPepSession(adapter, new Map([
      [LEGACY_OMEMO, bundle(LEGACY_OMEMO, 76)],
      [OMEMO_2, bundle(OMEMO_2, 77)]
    ]));

    await expect(session.initialize()).resolves.toBeUndefined();
    const firstConfigure = requests.findIndex((iq) => iq.getChild("pubsub", PUBSUB_OWNER)?.getChild("configure", PUBSUB_OWNER));
    const lastPublish = requests.findLastIndex((iq) => iq.getChild("pubsub", PUBSUB)?.getChild("publish", PUBSUB));
    expect(firstConfigure).toBeGreaterThan(lastPublish);
  });

  it("parses only strict headline device events", () => {
    expect(parseDeviceListEvent(event(LEGACY_OMEMO, [8, 4]))).toEqual({ version: LEGACY_OMEMO, devices: [{ id: 4 }, { id: 8 }] });
    expect(parseDeviceListEvent(xml("message", { type: "chat" }))).toBeUndefined();
    const malformed = event(OMEMO_2, [4]);
    malformed.getChild("event", PUBSUB_EVENT)!.getChild("items", PUBSUB_EVENT)!.getChild("item", PUBSUB_EVENT)!.attrs.id = "wrong";
    expect(() => parseDeviceListEvent(malformed)).toThrow("Malformed OMEMO PEP device-list event");
  });

  it("reannounces a missing self device once and ignores present or unrelated events", async () => {
    const own = bundle(LEGACY_OMEMO);
    const requests: Element[] = [];
    const adapter = new XmppOmemoPepAdapter("bot@example.org", { request: async (stanza) => {
      requests.push(stanza);
      const items = stanza.getChild("pubsub", PUBSUB)?.getChild("items", PUBSUB);
      if (items) return result(String(items.attrs.node), String(items.getChild("item", PUBSUB)!.attrs.id));
      return xml("iq", { type: "result" });
    } });
    const session = new OmemoPepSession(adapter, new Map([[LEGACY_OMEMO, own]]));
    await expect(session.handleEvent(event(LEGACY_OMEMO, [12]))).resolves.toBe(true);
    const publishes = requests.filter((iq) => iq.getChild("pubsub", PUBSUB)?.getChild("publish", PUBSUB));
    expect(publishes).toHaveLength(2);
    expect(publishes[0]!.toString()).toContain(`${LEGACY_OMEMO}.bundles:77`);
    expect(publishes[1]!.toString()).toContain(`${LEGACY_OMEMO}.devicelist`);
    const before = requests.length;
    await session.handleEvent(event(LEGACY_OMEMO, [12], "mallory@example.org"));
    await session.handleEvent(event(LEGACY_OMEMO, [77]));
    await expect(session.handleEvent(xml("message", { type: "headline" }))).resolves.toBe(false);
    expect(requests).toHaveLength(before);
  });
});

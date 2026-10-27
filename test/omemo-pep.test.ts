import type { Element } from "@xmpp/xml";
import { describe, expect, it } from "vitest";

import { LEGACY_OMEMO, OMEMO_2, type OmemoPublishedBundle, type OmemoVersion } from "../src/omemo/engine.js";
import { OmemoPepConflictError, OmemoPepPublisher, type OmemoPepAdapter, type OmemoPepItem } from "../src/omemo/pep.js";
import { parseDeviceList, serializeBundle, serializeDeviceList } from "../src/omemo/xml.js";

function bytes(length: number, fill: number): ArrayBuffer { return Uint8Array.from({ length }, () => fill).buffer; }
function bundle(version: OmemoVersion): OmemoPublishedBundle {
  const length = version === LEGACY_OMEMO ? 33 : 32;
  return { version, deviceId: 77, identityKey: bytes(length, 1),
    signedPreKey: { id: 2, publicKey: bytes(length, 2), signature: bytes(64, 3) },
    preKeys: [{ id: 3, publicKey: bytes(length, 4) }] };
}

class MemoryPep implements OmemoPepAdapter {
  devices: OmemoPepItem | undefined;
  bundles = new Map<string, OmemoPepItem>();
  devicePublishes = 0;
  bundlePublishes = 0;
  bundleRetractions = 0;
  conflictDeviceOnce = false;
  conflictBundleOnce = false;
  async fetchDeviceList(): Promise<OmemoPepItem | undefined> { return this.devices; }
  async publishDeviceList(_version: OmemoVersion, payload: Element, expected?: string): Promise<void> {
    this.devicePublishes++;
    if (this.conflictDeviceOnce) {
      this.conflictDeviceOnce = false;
      this.devices = { payload: serializeDeviceList(OMEMO_2, [{ id: 55, label: "Phone", labelSignature: bytes(64, 9) }]), revision: "2" };
      throw new OmemoPepConflictError();
    }
    if (expected !== this.devices?.revision) throw new OmemoPepConflictError();
    this.devices = { payload, revision: String(Number(expected ?? 0) + 1) };
  }
  async fetchBundle(version: OmemoVersion, deviceId: number): Promise<OmemoPepItem | undefined> {
    return this.bundles.get(`${version}:${deviceId}`);
  }
  async publishBundle(version: OmemoVersion, deviceId: number, payload: Element, expected?: string): Promise<void> {
    this.bundlePublishes++;
    const key = `${version}:${deviceId}`;
    if (this.conflictBundleOnce) { this.conflictBundleOnce = false; throw new OmemoPepConflictError(); }
    if (expected !== this.bundles.get(key)?.revision) throw new OmemoPepConflictError();
    this.bundles.set(key, { payload, revision: String(Number(expected ?? 0) + 1) });
  }
  async retractBundle(version: OmemoVersion, deviceId: number, expected?: string): Promise<void> {
    this.bundleRetractions++;
    const key = `${version}:${deviceId}`;
    if (expected !== this.bundles.get(key)?.revision) throw new OmemoPepConflictError();
    this.bundles.delete(key);
  }
}

describe("OmemoPepPublisher", () => {
  it("publishes a bundle before advertising the device and is idempotent", async () => {
    const adapter = new MemoryPep();
    const publisher = new OmemoPepPublisher({ adapter });
    await publisher.publish(bundle(OMEMO_2), { label: "OpenClaw", labelSignature: bytes(64, 8) });
    expect(adapter.bundlePublishes).toBe(1);
    expect(adapter.devicePublishes).toBe(1);
    expect(parseDeviceList(OMEMO_2, adapter.devices!.payload!)).toEqual([{ id: 77, label: "OpenClaw", labelSignature: bytes(64, 8) }]);
    await publisher.publish(bundle(OMEMO_2), { label: "OpenClaw", labelSignature: bytes(64, 8) });
    expect(adapter.bundlePublishes).toBe(1);
    expect(adapter.devicePublishes).toBe(1);
  });

  it("refetches and preserves a concurrently added device after conflict", async () => {
    const adapter = new MemoryPep();
    adapter.devices = { payload: serializeDeviceList(OMEMO_2, [{ id: 10 }]), revision: "1" };
    adapter.conflictDeviceOnce = true;
    await new OmemoPepPublisher({ adapter }).publish(bundle(OMEMO_2), { label: "OpenClaw", labelSignature: bytes(64, 8) });
    expect(adapter.devicePublishes).toBe(2);
    expect(parseDeviceList(OMEMO_2, adapter.devices!.payload!)).toEqual([
      { id: 55, label: "Phone", labelSignature: bytes(64, 9) },
      { id: 77, label: "OpenClaw", labelSignature: bytes(64, 8) }
    ]);
  });

  it("retries bundle conflicts and stops at the bounded attempt limit", async () => {
    const adapter = new MemoryPep();
    adapter.conflictBundleOnce = true;
    await new OmemoPepPublisher({ adapter }).publish(bundle(LEGACY_OMEMO));
    expect(adapter.bundlePublishes).toBe(2);

    const blocked = new MemoryPep();
    blocked.publishBundle = async () => { blocked.bundlePublishes++; throw new OmemoPepConflictError(); };
    await expect(new OmemoPepPublisher({ adapter: blocked, maxAttempts: 2 }).publish(bundle(OMEMO_2)))
      .rejects.toBeInstanceOf(OmemoPepConflictError);
    expect(blocked.bundlePublishes).toBe(2);
  });

  it("does not overwrite a canonically identical existing bundle", async () => {
    const adapter = new MemoryPep();
    const value = bundle(OMEMO_2);
    adapter.bundles.set(`${OMEMO_2}:77`, { payload: serializeBundle(value), revision: "8" });
    await new OmemoPepPublisher({ adapter }).publish(value);
    expect(adapter.bundlePublishes).toBe(0);
  });

  it("accepts a concurrent removal of the selected device before retracting its bundle", async () => {
    const adapter = new MemoryPep();
    const value = bundle(OMEMO_2);
    adapter.devices = {
      payload: serializeDeviceList(OMEMO_2, [{ id: 11 }, { id: 77 }, { id: 88 }]),
      revision: "1"
    };
    adapter.bundles.set(`${OMEMO_2}:77`, { payload: serializeBundle(value), revision: "4" });
    adapter.conflictDeviceOnce = true;
    await new OmemoPepPublisher({ adapter }).retire(OMEMO_2, 77);
    expect(parseDeviceList(OMEMO_2, adapter.devices!.payload!)).toEqual([
      { id: 55, label: "Phone", labelSignature: bytes(64, 9) }
    ]);
    expect(adapter.devicePublishes).toBe(1);
    expect(adapter.bundleRetractions).toBe(1);
    expect(adapter.bundles.has(`${OMEMO_2}:77`)).toBe(false);
    await new OmemoPepPublisher({ adapter }).retire(OMEMO_2, 77);
    expect(adapter.bundleRetractions).toBe(1);
  });
});

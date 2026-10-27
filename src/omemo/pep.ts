import type { Element } from "@xmpp/xml";

import type { OmemoPublishedBundle, OmemoVersion } from "./engine.js";
import { parseDeviceList, serializeBundle, serializeDeviceList, type OmemoDevice } from "./xml.js";

export class OmemoPepConflictError extends Error {
  readonly code = "OMEMO_PEP_CONFLICT";
  constructor() { super("OMEMO PEP item changed during publication."); }
}

export interface OmemoPepItem { payload?: Element; revision?: string }
export interface OmemoPepAdapter {
  fetchDeviceList(version: OmemoVersion): Promise<OmemoPepItem | undefined>;
  publishDeviceList(version: OmemoVersion, payload: Element, expectedRevision?: string): Promise<void>;
  fetchBundle(version: OmemoVersion, deviceId: number): Promise<OmemoPepItem | undefined>;
  publishBundle(version: OmemoVersion, deviceId: number, payload: Element, expectedRevision?: string): Promise<void>;
  retractBundle(version: OmemoVersion, deviceId: number, expectedRevision?: string): Promise<void>;
}

export interface OmemoPepPublisherOptions { adapter: OmemoPepAdapter; maxAttempts?: number }

/** Conflict-aware, transport-independent PEP publication policy. */
export class OmemoPepPublisher {
  readonly #adapter: OmemoPepAdapter;
  readonly #maxAttempts: number;
  constructor(options: OmemoPepPublisherOptions) {
    this.#adapter = options.adapter;
    this.#maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1 || this.#maxAttempts > 10) {
      throw new Error("Invalid OMEMO PEP publication attempt limit.");
    }
  }

  async publish(bundle: OmemoPublishedBundle, device?: Omit<OmemoDevice, "id">): Promise<void> {
    const canonicalBundle = serializeBundle(bundle);
    await this.#retry(async () => {
      const current = await this.#adapter.fetchBundle(bundle.version, bundle.deviceId);
      if (current?.payload && current.payload.toString() === canonicalBundle.toString()) return;
      await this.#adapter.publishBundle(bundle.version, bundle.deviceId, canonicalBundle, current?.revision);
    });
    await this.#retry(async () => {
      const current = await this.#adapter.fetchDeviceList(bundle.version);
      const devices = current?.payload ? parseDeviceList(bundle.version, current.payload) : [];
      const merged = mergeDevice(devices, { id: bundle.deviceId, ...device });
      const payload = serializeDeviceList(bundle.version, merged);
      if (current?.payload && current.payload.toString() === payload.toString()) return;
      await this.#adapter.publishDeviceList(bundle.version, payload, current?.revision);
    });
  }

  /** Remove the local advertisement before retracting its now-unreachable bundle. */
  async retire(version: OmemoVersion, deviceId: number): Promise<void> {
    await this.#retry(async () => {
      const current = await this.#adapter.fetchDeviceList(version);
      const devices = current?.payload ? parseDeviceList(version, current.payload) : [];
      const retained = devices.filter((device) => device.id !== deviceId);
      if (retained.length === devices.length) return;
      await this.#adapter.publishDeviceList(
        version, serializeDeviceList(version, retained), current?.revision
      );
    });
    await this.#retry(async () => {
      const current = await this.#adapter.fetchBundle(version, deviceId);
      if (!current) return;
      await this.#adapter.retractBundle(version, deviceId, current.revision);
    });
  }

  async #retry(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      try { await operation(); return; }
      catch (error) {
        if (!(error instanceof OmemoPepConflictError) || attempt === this.#maxAttempts) throw error;
      }
    }
  }
}

function mergeDevice(devices: OmemoDevice[], own: OmemoDevice): OmemoDevice[] {
  const merged = devices.filter((device) => device.id !== own.id);
  merged.push(own);
  return merged;
}

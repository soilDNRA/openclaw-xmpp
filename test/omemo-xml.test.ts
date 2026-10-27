import { xml } from "@xmpp/client";
import { describe, expect, it } from "vitest";

import { LEGACY_OMEMO, OMEMO_2, type OmemoPublishedBundle } from "../src/omemo/engine.js";
import {
  bundleNode,
  deviceListNode,
  parseBundle,
  parseDeviceList,
  serializeBundle,
  serializeDeviceList
} from "../src/omemo/xml.js";

function bytes(length: number, fill: number): ArrayBuffer {
  return Uint8Array.from({ length }, () => fill).buffer;
}

function bundle(version: typeof LEGACY_OMEMO | typeof OMEMO_2): OmemoPublishedBundle {
  const keyBytes = version === LEGACY_OMEMO ? 33 : 32;
  return {
    version,
    deviceId: 1234,
    identityKey: bytes(keyBytes, 1),
    signedPreKey: { id: 7, publicKey: bytes(keyBytes, 2), signature: bytes(64, 3) },
    preKeys: [{ id: 10, publicKey: bytes(keyBytes, 4) }, { id: 9, publicKey: bytes(keyBytes, 5) }]
  };
}

describe("OMEMO XML codecs", () => {
  it.each([LEGACY_OMEMO, OMEMO_2] as const)("round trips strict %s device lists", (version) => {
    const labelled = version === OMEMO_2 ? { id: 10, label: "Laptop", labelSignature: bytes(64, 8) } : { id: 10 };
    const payload = serializeDeviceList(version, [{ id: 20 }, labelled]);
    expect(parseDeviceList(version, payload)).toEqual([...([labelled, { id: 20 }] as const)]);
    expect(payload.toString()).toContain(version === LEGACY_OMEMO ? "<list" : "<devices");
  });

  it.each([LEGACY_OMEMO, OMEMO_2] as const)("round trips strict %s bundles", (version) => {
    const payload = serializeBundle(bundle(version));
    const parsed = parseBundle(version, 1234, payload, () => 0);
    expect(parsed.registrationId).toBe(1234);
    expect(parsed.identityKey).toEqual(bundle(version).identityKey);
    expect(parsed.signedPreKey).toEqual({
      keyId: 7,
      publicKey: bundle(version).signedPreKey.publicKey,
      signature: bundle(version).signedPreKey.signature
    });
    expect(parsed.preKey).toEqual({ keyId: 9, publicKey: bytes(version === LEGACY_OMEMO ? 33 : 32, 5) });
  });

  it("uses the profile-specific PEP node names", () => {
    expect(deviceListNode(LEGACY_OMEMO)).toBe("eu.siacs.conversations.axolotl.devicelist");
    expect(deviceListNode(OMEMO_2)).toBe("urn:xmpp:omemo:2:devices");
    expect(bundleNode(LEGACY_OMEMO, 1234)).toBe("eu.siacs.conversations.axolotl.bundles:1234");
    expect(bundleNode(OMEMO_2, 1234)).toBe("urn:xmpp:omemo:2:bundles");
  });

  it("fails closed on namespace, duplicates, unknown children, attributes, and noncanonical base64", () => {
    expect(() => parseDeviceList(OMEMO_2, xml("devices", { xmlns: LEGACY_OMEMO }))).toThrow("Expected OMEMO devices");
    expect(() => parseDeviceList(OMEMO_2, xml("devices", { xmlns: OMEMO_2 },
      xml("device", { id: "1" }), xml("device", { id: "1" })))).toThrow("duplicate device ID");
    expect(() => parseDeviceList(OMEMO_2, xml("devices", { xmlns: OMEMO_2 },
      xml("device", { id: "1", mystery: "x" })))).toThrow("Unexpected OMEMO XML attribute");

    const valid = bundle(OMEMO_2);
    const malformed = serializeBundle(valid);
    malformed.c("unknown");
    expect(() => parseBundle(OMEMO_2, 1234, malformed)).toThrow("Malformed OMEMO bundle structure");

    const invalidBase64 = serializeBundle(valid);
    invalidBase64.getChild("ik", OMEMO_2)!.children = ["AQ=="];
    expect(() => parseBundle(OMEMO_2, 1234, invalidBase64)).toThrow("Invalid OMEMO identity key");
  });

  it("rejects empty prekey sets, duplicate key IDs, oversized labels, and invalid device IDs", () => {
    expect(() => serializeBundle({ ...bundle(OMEMO_2), preKeys: [] })).toThrow("no one-time prekeys");
    const duplicate = bundle(OMEMO_2);
    duplicate.preKeys = [duplicate.preKeys[0]!, duplicate.preKeys[0]!];
    expect(() => serializeBundle(duplicate)).toThrow("duplicate prekey ID");
    expect(() => serializeDeviceList(OMEMO_2, [{ id: 1, label: "x".repeat(129), labelSignature: bytes(64, 1) }])).toThrow("Invalid OMEMO device label");
    expect(() => serializeDeviceList(OMEMO_2, [{ id: 1, label: "unsigned" }])).toThrow("label signature");
    expect(() => bundleNode(LEGACY_OMEMO, 0)).toThrow("Invalid OMEMO device ID");
  });
});

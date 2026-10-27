import { randomInt } from "node:crypto";

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import {
  LEGACY_OMEMO,
  OMEMO_2,
  type OmemoPublishedBundle,
  type OmemoRemoteBundle,
  type OmemoVersion
} from "./engine.js";

const MAX_DEVICE_ID = 0x7fff_ffff;
const MAX_KEY_ID = 0x7fff_ffff;
const MAX_DEVICES = 1_000;
const MAX_PREKEYS = 1_000;
const MAX_LABEL_BYTES = 128;

export interface OmemoDevice { id: number; label?: string; labelSignature?: ArrayBuffer }

export function deviceListNode(version: OmemoVersion): string {
  return version === LEGACY_OMEMO ? `${LEGACY_OMEMO}.devicelist` : `${OMEMO_2}:devices`;
}

export function bundleNode(version: OmemoVersion, deviceId: number): string {
  deviceId = integer(deviceId, "device ID", 1, MAX_DEVICE_ID);
  return version === LEGACY_OMEMO
    ? `${LEGACY_OMEMO}.bundles:${deviceId}`
    : `${OMEMO_2}:bundles`;
}

export function serializeDeviceList(version: OmemoVersion, devices: readonly OmemoDevice[]): Element {
  validateVersion(version);
  if (devices.length > MAX_DEVICES) throw new Error("OMEMO device list exceeds the size limit.");
  const ordered = [...devices].sort((a, b) => a.id - b.id);
  const seen = new Set<number>();
  const children = ordered.map((device) => {
    const id = integer(device.id, "device ID", 1, MAX_DEVICE_ID);
    if (seen.has(id)) throw new Error("OMEMO device list contains a duplicate device ID.");
    seen.add(id);
    const attrs: Record<string, string> = { id: String(id) };
    if (device.label !== undefined || device.labelSignature !== undefined) {
      if (version !== OMEMO_2 || device.label === undefined || device.labelSignature === undefined) {
        throw new Error("OMEMO device labels require an OMEMO 2 label signature.");
      }
      attrs.label = label(device.label);
      attrs.labelsig = base64(binary(device.labelSignature, 64, "device-label signature"));
    }
    return xml("device", attrs);
  });
  return xml(version === LEGACY_OMEMO ? "list" : "devices", { xmlns: version }, ...children);
}

export function parseDeviceList(version: OmemoVersion, payload: Element): OmemoDevice[] {
  validateVersion(version);
  requireElement(payload, version === LEGACY_OMEMO ? "list" : "devices", version);
  requireAttrs(payload, ["xmlns"]);
  requireNoText(payload);
  const children = payload.getChildElements();
  if (children.length > MAX_DEVICES) throw new Error("OMEMO device list exceeds the size limit.");
  const result: OmemoDevice[] = [];
  const seen = new Set<number>();
  for (const child of children) {
    requireElement(child, "device", version);
    requireAttrs(child, version === OMEMO_2 ? ["id", "label", "labelsig"] : ["id"]);
    requireNoChildrenOrText(child);
    const id = integerString(child.attrs.id, "device ID", 1, MAX_DEVICE_ID);
    if (seen.has(id)) throw new Error("OMEMO device list contains a duplicate device ID.");
    seen.add(id);
    const rawLabel = child.attrs.label;
    const rawSignature = child.attrs.labelsig;
    if ((rawLabel === undefined) !== (rawSignature === undefined)) {
      throw new Error("OMEMO device labels require a label signature.");
    }
    result.push({ id, ...(rawLabel === undefined ? {} : {
      label: label(rawLabel),
      labelSignature: decodeBase64(rawSignature, 64, "device-label signature")
    }) });
  }
  return result.sort((a, b) => a.id - b.id);
}

export function serializeBundle(bundle: OmemoPublishedBundle): Element {
  const { version } = bundle;
  validateVersion(version);
  integer(bundle.deviceId, "device ID", 1, MAX_DEVICE_ID);
  const signedId = integer(bundle.signedPreKey.id, "signed-prekey ID", 1, MAX_KEY_ID);
  const identity = binary(bundle.identityKey, version === LEGACY_OMEMO ? 33 : 32, "identity key");
  const signed = binary(bundle.signedPreKey.publicKey, version === LEGACY_OMEMO ? 33 : 32, "signed prekey");
  const signature = binary(bundle.signedPreKey.signature, 64, "signed-prekey signature");
  if (bundle.preKeys.length === 0) throw new Error("OMEMO bundle has no one-time prekeys.");
  if (bundle.preKeys.length > MAX_PREKEYS) throw new Error("OMEMO bundle exceeds the prekey limit.");
  const seen = new Set<number>();
  const prekeys = [...bundle.preKeys].sort((a, b) => a.id - b.id).map((prekey) => {
    const id = integer(prekey.id, "prekey ID", 1, MAX_KEY_ID);
    if (seen.has(id)) throw new Error("OMEMO bundle contains a duplicate prekey ID.");
    seen.add(id);
    const value = base64(binary(prekey.publicKey, version === LEGACY_OMEMO ? 33 : 32, "prekey"));
    return version === LEGACY_OMEMO
      ? xml("preKeyPublic", { preKeyId: String(id) }, value)
      : xml("pk", { id: String(id) }, value);
  });
  if (version === LEGACY_OMEMO) {
    return xml("bundle", { xmlns: version },
      xml("signedPreKeyPublic", { signedPreKeyId: String(signedId) }, base64(signed)),
      xml("signedPreKeySignature", {}, base64(signature)),
      xml("identityKey", {}, base64(identity)),
      xml("prekeys", {}, ...prekeys));
  }
  return xml("bundle", { xmlns: version },
    xml("spk", { id: String(signedId) }, base64(signed)),
    xml("spks", {}, base64(signature)),
    xml("ik", {}, base64(identity)),
    xml("prekeys", {}, ...prekeys));
}

export function parseBundle(
  version: OmemoVersion,
  deviceId: number,
  payload: Element,
  selectPreKey: (count: number) => number = randomInt
): OmemoRemoteBundle {
  validateVersion(version);
  const registrationId = integer(deviceId, "device ID", 1, MAX_DEVICE_ID);
  requireElement(payload, "bundle", version);
  requireAttrs(payload, ["xmlns"]);
  requireNoText(payload);
  const names = version === LEGACY_OMEMO
    ? { signed: "signedPreKeyPublic", signedId: "signedPreKeyId", signature: "signedPreKeySignature", identity: "identityKey", prekey: "preKeyPublic", prekeyId: "preKeyId" }
    : { signed: "spk", signedId: "id", signature: "spks", identity: "ik", prekey: "pk", prekeyId: "id" };
  const expected = [names.signed, names.signature, names.identity, "prekeys"];
  const children = payload.getChildElements();
  if (children.length !== expected.length || expected.some((name) => children.filter((child) => child.is(name, version)).length !== 1)) {
    throw new Error("Malformed OMEMO bundle structure.");
  }
  const signed = payload.getChild(names.signed, version)!;
  const signature = payload.getChild(names.signature, version)!;
  const identity = payload.getChild(names.identity, version)!;
  const prekeys = payload.getChild("prekeys", version)!;
  requireAttrs(signed, [names.signedId]);
  requireAttrs(signature, []);
  requireAttrs(identity, []);
  requireAttrs(prekeys, []);
  const signedId = integerString(signed.attrs[names.signedId], "signed-prekey ID", 1, MAX_KEY_ID);
  const keyBytes = version === LEGACY_OMEMO ? 33 : 32;
  const parsedPrekeys = prekeys.getChildElements();
  requireNoText(prekeys);
  if (parsedPrekeys.length === 0) throw new Error("OMEMO bundle has no one-time prekeys.");
  if (parsedPrekeys.length > MAX_PREKEYS) throw new Error("OMEMO bundle exceeds the prekey limit.");
  const seen = new Set<number>();
  const selectedIndex = selectPreKey(parsedPrekeys.length);
  if (!Number.isSafeInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= parsedPrekeys.length) {
    throw new Error("Invalid OMEMO prekey selection.");
  }
  const selected = parsedPrekeys[selectedIndex]!;
  for (const entry of parsedPrekeys) {
    requireElement(entry, names.prekey, version);
    requireAttrs(entry, [names.prekeyId]);
    requireTextOnly(entry);
    const id = integerString(entry.attrs[names.prekeyId], "prekey ID", 1, MAX_KEY_ID);
    if (seen.has(id)) throw new Error("OMEMO bundle contains a duplicate prekey ID.");
    seen.add(id);
  }
  return {
    registrationId,
    identityKey: decodeBase64Element(identity, version === LEGACY_OMEMO ? 33 : 32, "identity key"),
    signedPreKey: {
      keyId: signedId,
      publicKey: decodeBase64Element(signed, keyBytes, "signed prekey"),
      signature: decodeBase64Element(signature, 64, "signed-prekey signature")
    },
    preKey: {
      keyId: integerString(selected.attrs[names.prekeyId], "prekey ID", 1, MAX_KEY_ID),
      publicKey: decodeBase64Element(selected, keyBytes, "prekey")
    }
  };
}

function decodeBase64Element(element: Element, length: number, name: string): ArrayBuffer {
  requireTextOnly(element);
  return decodeBase64(element.getText(), length, name);
}
function decodeBase64(value: unknown, length: number, name: string): ArrayBuffer {
  const raw = typeof value === "string" ? value : "";
  if (/[^A-Za-z0-9+/=\t\n\r ]/.test(raw)) throw new Error(`Invalid OMEMO ${name} base64.`);
  const text = raw.replace(/[\t\n\r ]/g, "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    throw new Error(`Invalid OMEMO ${name} base64.`);
  }
  const decoded = Buffer.from(text, "base64");
  if (decoded.toString("base64") !== text || decoded.byteLength !== length) {
    throw new Error(`Invalid OMEMO ${name}.`);
  }
  return Uint8Array.from(decoded).buffer;
}

function requireElement(value: Element, name: string, namespace: string): void {
  if (!value.is(name, namespace)) throw new Error(`Expected OMEMO ${name} element in ${namespace}.`);
}
function requireAttrs(value: Element, allowed: string[]): void {
  if (Object.keys(value.attrs).some((key) => !allowed.includes(key))) throw new Error("Unexpected OMEMO XML attribute.");
}
function requireNoText(value: Element): void {
  if (value.getText().trim() !== "") throw new Error("Unexpected OMEMO XML text.");
}
function requireNoChildrenOrText(value: Element): void {
  if (value.children.length !== 0) throw new Error("Unexpected OMEMO XML content.");
}
function requireTextOnly(value: Element): void {
  if (value.getChildElements().length !== 0 || value.children.some((child) => typeof child !== "string" && typeof child !== "number")) {
    throw new Error("Unexpected OMEMO XML content.");
  }
}
function binary(value: ArrayBuffer, length: number, name: string): Uint8Array {
  if (!(value instanceof ArrayBuffer) || value.byteLength !== length) throw new Error(`Invalid OMEMO ${name}.`);
  return new Uint8Array(value);
}
function base64(value: Uint8Array): string { return Buffer.from(value).toString("base64"); }
function integer(value: number, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid OMEMO ${name}.`);
  return value;
}
function integerString(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid OMEMO ${name}.`);
  return integer(Number(value), name, min, max);
}
function label(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > MAX_LABEL_BYTES) {
    throw new Error("Invalid OMEMO device label.");
  }
  return value;
}
function validateVersion(value: string): asserts value is OmemoVersion {
  if (value !== LEGACY_OMEMO && value !== OMEMO_2) throw new Error("Unsupported OMEMO version.");
}

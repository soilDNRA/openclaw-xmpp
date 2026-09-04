import { basename } from "node:path";

import { xml } from "@xmpp/client";
import type { Client } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

import { NS } from "./constants.js";

export interface UploadSlot {
  putUrl: string;
  getUrl: string;
  headers: Array<[name: string, value: string]>;
}

// XEP-0363 permits only these slot-provided headers on the HTTP PUT.
const ALLOWED_UPLOAD_HEADERS = new Map([
  ["authorization", "Authorization"],
  ["cookie", "Cookie"],
  ["expires", "Expires"]
]);

function elementChildren(element: Element, name: string, xmlns?: string): Element[] {
  return element.getChildren(name, xmlns);
}

export async function discoverUploadService(
  xmpp: Client,
  domain: string
): Promise<string> {
  const items = await xmpp.iqCaller.get(
    xml("query", { xmlns: NS.discoItems }),
    domain,
    15_000
  );
  const candidates = items
    ? elementChildren(items, "item")
        .map((item) => String(item.attrs.jid ?? ""))
        .filter(Boolean)
    : [];
  for (const candidate of candidates) {
    const info = await xmpp.iqCaller
      .get(xml("query", { xmlns: NS.discoInfo }), candidate, 15_000)
      .catch(() => undefined);
    const supportsUpload = info
      ?.getChildren("feature")
      .some((feature: Element) => feature.attrs.var === NS.httpUpload);
    if (supportsUpload) {
      return candidate;
    }
  }
  throw new Error("The XMPP server did not advertise an XEP-0363 upload service.");
}

export async function requestUploadSlot(params: {
  xmpp: Client;
  serviceJid: string;
  filename: string;
  size: number;
  contentType: string;
}): Promise<UploadSlot> {
  // XEP-0363 replies to <request/> with a differently named <slot/> child.
  // iqCaller.get() can only return a response child with the same name as the
  // request, so use the full IQ request API and select <slot/> explicitly.
  const response = await params.xmpp.iqCaller.request(
    xml(
      "iq",
      { type: "get", to: params.serviceJid },
      xml("request", {
        xmlns: NS.httpUpload,
        filename: params.filename,
        size: String(params.size),
        "content-type": params.contentType
      })
    ),
    20_000
  );
  const slot =
    response?.getChild("slot", NS.httpUpload) ?? response?.getChild("slot");
  const put = slot?.getChild("put", NS.httpUpload) ?? slot?.getChild("put");
  const get = slot?.getChild("get", NS.httpUpload) ?? slot?.getChild("get");
  const putUrl = String(put?.attrs.url ?? "");
  const getUrl = String(get?.attrs.url ?? "");
  if (!putUrl || !getUrl) {
    throw new Error("The XMPP upload service returned an invalid slot.");
  }
  const headers: UploadSlot["headers"] = [];
  for (const header of put?.getChildren("header") ?? []) {
    const rawName = String(header.attrs.name ?? "");
    const name = rawName.replace(/[\r\n]/g, "").trim().toLowerCase();
    const allowedName = ALLOWED_UPLOAD_HEADERS.get(name);
    if (!allowedName) {
      continue;
    }
    const value = header.text().replace(/[\r\n]/g, "");
    headers.push([allowedName, value]);
  }
  return { putUrl, getUrl, headers };
}

export async function uploadBuffer(params: {
  slot: UploadSlot;
  buffer: Buffer;
  contentType: string;
  signal?: AbortSignal;
}): Promise<string> {
  const headers = new Headers();
  for (const [name, value] of params.slot.headers) {
    headers.append(name, value);
  }
  headers.set("content-type", params.contentType);
  headers.set("content-length", String(params.buffer.byteLength));

  const guarded = await fetchWithSsrFGuard({
    url: params.slot.putUrl,
    requireHttps: true,
    maxRedirects: 0,
    timeoutMs: 60_000,
    capture: false,
    ...(params.signal ? { signal: params.signal } : {}),
    init: {
      method: "PUT",
      headers,
      body: new Uint8Array(params.buffer)
    },
    auditContext: "xmpp-xep0363-upload"
  });
  try {
    if (!guarded.response.ok) {
      throw new Error(
        `XMPP upload failed with HTTP ${guarded.response.status}.`
      );
    }
  } finally {
    await guarded.release();
  }
  const downloadUrl = new URL(params.slot.getUrl);
  if (downloadUrl.protocol !== "https:") {
    throw new Error("The XMPP upload service returned a non-HTTPS download URL.");
  }
  return downloadUrl.toString();
}

export function safeUploadFilename(filePath: string): string {
  const value = basename(filePath).replace(/[^A-Za-z0-9._-]+/g, "_");
  return value || "attachment";
}

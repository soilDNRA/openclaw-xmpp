import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { describe, expect, it, vi } from "vitest";

import { NS } from "../src/constants.js";
import { requestUploadSlot, uploadBuffer } from "../src/media.js";

const { fetchWithSsrFGuard } = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn()
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard
}));

describe("XEP-0363 upload slots", () => {
  it("reads the differently named slot child from the full IQ result", async () => {
    const response = xml(
      "iq",
      { type: "result", id: "upload-1" },
      xml(
        "slot",
        { xmlns: NS.httpUpload },
        xml(
          "put",
          { url: "https://upload.example.org/put" },
          xml("header", { name: "Expires" }, "60"),
          xml("header", { name: "Authori\nzation" }, "Bearer\r\n first"),
          xml("header", { name: "authorization" }, "Bearer second"),
          xml("header", { name: "Cookie" }, "session=one\n"),
          xml("header", { name: "cookie" }, "theme=dark"),
          xml("header", { name: "X-Not-Allowed" }, "ignored"),
          xml("header", { name: "Proxy-Authorization" }, "ignored")
        ),
        xml("get", { url: "https://upload.example.org/get/plot.png" })
      )
    );
    const request = vi.fn(async (_stanza: Element, _timeout: number) => response);

    const slot = await requestUploadSlot({
      xmpp: { iqCaller: { request } } as never,
      serviceJid: "upload.example.org",
      filename: "plot.png",
      size: 1234,
      contentType: "image/png"
    });

    expect(request).toHaveBeenCalledOnce();
    const [stanza, timeout] = request.mock.calls[0] ?? [];
    expect(stanza?.attrs).toMatchObject({
      type: "get",
      to: "upload.example.org"
    });
    expect(stanza?.getChild("request", NS.httpUpload)?.attrs).toMatchObject({
      filename: "plot.png",
      size: "1234",
      "content-type": "image/png"
    });
    expect(timeout).toBe(20_000);
    expect(slot).toEqual({
      putUrl: "https://upload.example.org/put",
      getUrl: "https://upload.example.org/get/plot.png",
      headers: [
        ["Expires", "60"],
        ["Authorization", "Bearer first"],
        ["Authorization", "Bearer second"],
        ["Cookie", "session=one"],
        ["Cookie", "theme=dark"]
      ]
    });
  });

  it("copies allowed headers into the PUT in repeated-value order", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuard.mockResolvedValueOnce({
      response: new Response(null, { status: 201 }),
      release
    });

    await expect(
      uploadBuffer({
        slot: {
          putUrl: "https://upload.example.org/put",
          getUrl: "https://upload.example.org/get/plot.png",
          headers: [
            ["Authorization", "Bearer first"],
            ["Authorization", "Bearer second"],
            ["Cookie", "session=one"],
            ["Cookie", "theme=dark"],
            ["Expires", "60"]
          ]
        },
        buffer: Buffer.from("png"),
        contentType: "image/png"
      })
    ).resolves.toBe("https://upload.example.org/get/plot.png");

    expect(fetchWithSsrFGuard).toHaveBeenCalledOnce();
    const request = fetchWithSsrFGuard.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      url: "https://upload.example.org/put",
      requireHttps: true,
      maxRedirects: 0,
      capture: false,
      init: {
        method: "PUT",
        body: new Uint8Array(Buffer.from("png"))
      }
    });
    expect(request?.init?.headers).toBeInstanceOf(Headers);
    const headers = request?.init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer first, Bearer second");
    expect(headers.get("cookie")).toBe("session=one; theme=dark");
    expect(headers.get("expires")).toBe("60");
    expect(headers.get("content-type")).toBe("image/png");
    expect(headers.get("content-length")).toBe("3");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects malformed slots and non-HTTPS download URLs", async () => {
    const request = vi.fn(async () => xml("iq", { type: "result" }, xml("slot", { xmlns: NS.httpUpload })));
    await expect(requestUploadSlot({
      xmpp: { iqCaller: { request } } as never,
      serviceJid: "upload.example.org",
      filename: "plot.png",
      size: 3,
      contentType: "image/png"
    })).rejects.toThrow(/invalid slot/);

    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuard.mockResolvedValueOnce({ response: new Response(null, { status: 201 }), release });
    await expect(uploadBuffer({
      slot: { putUrl: "https://upload.example.org/put", getUrl: "http://upload.example.org/file", headers: [] },
      buffer: Buffer.from("png"),
      contentType: "image/png"
    })).rejects.toThrow(/non-HTTPS download URL/);
    expect(release).toHaveBeenCalledOnce();
  });

  it("releases guarded responses when upload fails", async () => {
    const release = vi.fn(async () => undefined);
    fetchWithSsrFGuard.mockResolvedValueOnce({ response: new Response(null, { status: 401 }), release });
    await expect(uploadBuffer({
      slot: { putUrl: "https://upload.example.org/put", getUrl: "https://upload.example.org/file", headers: [] },
      buffer: Buffer.from("png"),
      contentType: "image/png"
    })).rejects.toThrow(/HTTP 401/);
    expect(release).toHaveBeenCalledOnce();
  });
});

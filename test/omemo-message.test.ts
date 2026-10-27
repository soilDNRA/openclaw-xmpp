import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Element } from "@xmpp/xml";
import { parse as parseXml } from "ltx";
import { describe, expect, it, vi } from "vitest";

import { LEGACY_OMEMO, OMEMO_2 } from "../src/omemo/engine.js";
import { OmemoInboundCoordinator, OmemoOutboundCoordinator, parseEncryptedEnvelope, serializeEncryptedEnvelope, type OmemoEncryptedEnvelope, type OmemoInboundBindings, type OmemoOutboundBindings } from "../src/omemo/message.js";
import { LibomemoStoreAdapter } from "../src/omemo/libomemo-store.js";
import { OmemoTransactionalStore } from "../src/omemo/store.js";

function parse(value: string): Element {
  return parseXml(value);
}
function binary(value: Uint8Array): string { return String.fromCharCode(...value); }
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-message-"));
  const store = new OmemoTransactionalStore({ stateDirectory: directory, clock: () => 1000 });
  const encryptedAddresses: string[] = [];
  const bindings: OmemoOutboundBindings = {
    createSessionCipher(adapter, address, version) {
      return { async encrypt(plaintext) {
        encryptedAddresses.push(address);
        adapter.storeSession(address, `advanced:${version}:${encryptedAddresses.length}`);
        return { type: address.endsWith(".9") ? 3 : 1, body: binary(plaintext), ...(version === OMEMO_2 && address.endsWith(".9") ? { kex: true } : {}) };
      } };
    }
  };
  const coordinator = new OmemoOutboundCoordinator({
    account: "alice@example.org", localDeviceId: 7, store, bindings, trustMode: "tofu",
    random: (length) => Uint8Array.from({ length }, (_, index) => index + 1), id: () => "message-1"
  });
  return { store, coordinator, encryptedAddresses };
}

describe("OMEMO encrypted-message XML", () => {
  it.each([LEGACY_OMEMO, OMEMO_2] as const)("round-trips a strict %s envelope", (version) => {
    const value: OmemoEncryptedEnvelope = {
      version, senderDeviceId: 7,
      keyGroups: version === LEGACY_OMEMO
        ? [{ keys: [{ rid: 8, data: Uint8Array.of(1, 2), keyExchange: true }] }]
        : [{ jid: "bob@example.org", keys: [{ rid: 8, data: Uint8Array.of(1, 2), keyExchange: true }] }],
      ...(version === LEGACY_OMEMO ? { iv: Uint8Array.from({ length: 12 }, () => 3) } : {}),
      payload: Uint8Array.of(4, 5, 6)
    };
    const encoded = serializeEncryptedEnvelope(value);
    expect(parseEncryptedEnvelope(version, encoded)).toEqual(value);
    expect(encoded.toString()).toContain(version === LEGACY_OMEMO ? 'prekey="true"' : 'kex="true"');
  });

  it("rejects wrong structure, noncanonical flags, duplicate recipients and invalid IVs", () => {
    const duplicate = parse(`<encrypted xmlns="${OMEMO_2}"><header sid="7"><keys jid="bob@example.org"><key rid="8">AQ==</key><key rid="8">Ag==</key></keys></header></encrypted>`);
    expect(() => parseEncryptedEnvelope(OMEMO_2, duplicate)).toThrow("duplicate recipient");
    const flag = parse(`<encrypted xmlns="${LEGACY_OMEMO}"><header sid="7"><key rid="8" prekey="1">AQ==</key><iv>AAAAAAAAAAAAAAAA</iv></header></encrypted>`);
    expect(() => parseEncryptedEnvelope(LEGACY_OMEMO, flag)).toThrow("key-exchange flag");
    expect(() => serializeEncryptedEnvelope({ version: LEGACY_OMEMO, senderDeviceId: 7, keyGroups: [{ keys: [{ rid: 8, data: Uint8Array.of(1) }] }], iv: Uint8Array.of(1) }))
      .toThrow("12-byte IV");
  });
});

describe("OMEMO outbound coordinator", () => {
  it("rechecks revocation inside the outbound transaction before any cipher mutation", async () => {
    const { store } = fixture();
    const key = new Uint8Array(33).fill(7); key[0] = 5;
    await store.updateRecords("alice@example.org", (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
      const record = adapter.trust.observeIdentity("bob@example.org.8", key.buffer);
      // Simulate a revocation committed after recipient planning.
      adapter.trust.transition("bob@example.org.8", record, "distrusted");
    });
    const createSessionCipher = vi.fn();
    const coordinator = new OmemoOutboundCoordinator({ account: "alice@example.org", localDeviceId: 7,
      store, trustMode: "tofu", requireTrustedTargets: true, bindings: { createSessionCipher } });
    const send = vi.fn();
    await expect(coordinator.encryptAndSend({ to: "bob@example.org", text: "must not leak", version: LEGACY_OMEMO,
      recipients: [{ jid: "bob@example.org", deviceIds: [8] }], send })).rejects.toThrow("distrusted");
    expect(createSessionCipher).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
    expect(store.listOutbound("alice@example.org")).toHaveLength(0);
    store.close();
  });

  it("commits exact legacy ciphertext and all ratchets before send, then acknowledges", async () => {
    const { store, coordinator, encryptedAddresses } = fixture();
    let committedBeforeSend = false;
    let sent = "";
    const result = await coordinator.encryptAndSend({
      to: "bob@example.org", text: "hello", version: LEGACY_OMEMO,
      recipients: [{ jid: "bob@example.org", deviceIds: [9, 8] }, { jid: "alice@example.org", deviceIds: [7, 6] }],
      send: async (stanza) => {
        const pending = store.listOutbound("alice@example.org");
        committedBeforeSend = pending.length === 1;
        sent = stanza.toString();
        expect(pending[0]!.stanza.toString()).toBe(sent);
      }
    });
    expect(committedBeforeSend).toBe(true);
    expect(store.listOutbound("alice@example.org")).toEqual([]);
    expect(result.pending.stanza.toString()).toBe(sent);
    expect(encryptedAddresses).toEqual(["alice@example.org.6", "bob@example.org.8", "bob@example.org.9"]);
    const envelope = parseEncryptedEnvelope(LEGACY_OMEMO, parse(sent).getChild("encrypted", LEGACY_OMEMO)!);
    const material = envelope.keyGroups[0]!.keys[0]!.data;
    const decipher = createDecipheriv("aes-128-gcm", material.subarray(0, 16), envelope.iv!, { authTagLength: 16 });
    decipher.setAuthTag(material.subarray(16));
    expect(Buffer.concat([decipher.update(envelope.payload!), decipher.final()]).toString()).toBe("hello");
    store.close();
  });

  it("produces decryptable OMEMO 2 SCE payload and kex grouping", async () => {
    const { store, coordinator } = fixture();
    let stanza = "";
    await coordinator.encryptAndSend({
      to: "bob@example.org", text: "secret", version: OMEMO_2,
      recipients: [{ jid: "bob@example.org", deviceIds: [9] }, { jid: "alice@example.org", deviceIds: [6] }],
      send: async (value) => { stanza = value.toString(); }
    });
    const envelope = parseEncryptedEnvelope(OMEMO_2, parse(stanza).getChild("encrypted", OMEMO_2)!);
    expect(envelope.keyGroups.map((group) => group.jid)).toEqual(["alice@example.org", "bob@example.org"]);
    expect(envelope.keyGroups[1]!.keys[0]!.keyExchange).toBe(true);
    const material = envelope.keyGroups[0]!.keys[0]!.data;
    const key = material.subarray(0, 32);
    const derived = Buffer.from(hkdfSync("sha256", key, Buffer.alloc(32), "OMEMO Payload", 80));
    const expectedMac = createHmac("sha256", derived.subarray(32, 64)).update(envelope.payload!).digest().subarray(0, 16);
    expect(Buffer.from(material.subarray(32))).toEqual(expectedMac);
    const decipher = createDecipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(64, 80));
    const plaintext = Buffer.concat([decipher.update(envelope.payload!), decipher.final()]).toString();
    expect(plaintext).toContain('<envelope xmlns="urn:xmpp:sce:1">');
    expect(plaintext).toContain('<body xmlns="jabber:client">secret</body>');
    store.close();
  });

  it("rolls back every ratchet and emits nothing when one device encryption fails", async () => {
    const { store } = fixture();
    const bindings: OmemoOutboundBindings = { createSessionCipher(adapter, address) { return { async encrypt() {
      adapter.storeSession(address, "advanced");
      if (address.endsWith(".9")) throw new Error("cipher failure");
      return { type: 1, body: binary(Uint8Array.of(1)) };
    } }; } };
    const coordinator = new OmemoOutboundCoordinator({ account: "alice@example.org", localDeviceId: 7, store, bindings, trustMode: "tofu", id: () => "failed" });
    const send = vi.fn();
    await expect(coordinator.encryptAndSend({ to: "bob@example.org", text: "hello", version: LEGACY_OMEMO,
      recipients: [{ jid: "bob@example.org", deviceIds: [8, 9] }], send })).rejects.toThrow("cipher failure");
    expect(send).not.toHaveBeenCalled();
    expect(store.listOutbound("alice@example.org")).toEqual([]);
    await store.updateRecords("alice@example.org", (view) => {
      expect(view.get("session", "bob@example.org.8")).toBeUndefined();
      expect(view.get("session", "bob@example.org.9")).toBeUndefined();
    });
    store.close();
  });

  it("retains committed ciphertext for retry when transport send fails", async () => {
    const { store, coordinator } = fixture();
    await expect(coordinator.encryptAndSend({ to: "bob@example.org", text: "hello", version: LEGACY_OMEMO,
      recipients: [{ jid: "bob@example.org", deviceIds: [8] }], send: async () => { throw new Error("offline"); } }))
      .rejects.toThrow("offline");
    expect(store.listOutbound("alice@example.org")).toHaveLength(1);
    await store.updateRecords("alice@example.org", (view) => {
      expect(view.get("session", "bob@example.org.8")?.toString()).toContain("advanced");
    });
    store.close();
  });
});

describe("OMEMO inbound coordinator", () => {
  async function encryptedFixture(version: typeof LEGACY_OMEMO | typeof OMEMO_2, keyExchange = false) {
    const outboundDirectory = mkdtempSync(join(tmpdir(), "openclaw-omemo-inbound-out-"));
    const outboundStore = new OmemoTransactionalStore({ stateDirectory: outboundDirectory });
    let stanza!: Element;
    const outbound = new OmemoOutboundCoordinator({
      account: "alice@example.org", localDeviceId: 7, store: outboundStore, trustMode: "tofu", id: () => "inbound-1",
      random: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
      bindings: { createSessionCipher() { return { async encrypt(value) {
        return { body: binary(value), type: keyExchange ? 3 : 1, ...(version === OMEMO_2 && keyExchange ? { kex: true } : {}) };
      } }; } }
    });
    await outbound.encryptAndSend({
      to: "bob@example.org", text: "secret inbound", version,
      recipients: [{ jid: "bob@example.org", deviceIds: [9] }],
      send: async (value) => { stanza = parse(value.toString()); stanza.attrs.from = "alice@example.org/phone"; }
    });
    outboundStore.close();
    return stanza;
  }

  it.each([LEGACY_OMEMO, OMEMO_2] as const)("commits %s ratchet and sealed plaintext before dispatch", async (version) => {
    const stanza = await encryptedFixture(version, true);
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-inbound-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory, clock: () => 2000 });
    const order: string[] = [];
    const refresh = vi.fn(async () => { order.push("refresh"); });
    const bindings: OmemoInboundBindings = { createSessionCipher(adapter, address, actualVersion) {
      expect(address).toBe("alice@example.org.7"); expect(actualVersion).toBe(version);
      return {
        async decryptWhisperMessage(value) { return decrypt(value); },
        async decryptPreKeyWhisperMessage(value) { return decrypt(value); }
      };
      function decrypt(value: Uint8Array) {
        adapter.storeSession(address, `advanced:${version}`);
        return { plaintext: value.slice().buffer };
      }
    } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu", refreshBundle: refresh });
    const message = await inbound.decryptAndDispatch(stanza, async (value) => {
      expect(store.listInbound("bob@example.org")).toHaveLength(1);
      order.push("dispatch"); expect(value.text).toBe("secret inbound");
    });
    expect(message?.from).toBe("alice@example.org");
    expect(order).toEqual(["refresh", "dispatch"]);
    expect(refresh).toHaveBeenCalledWith(version);
    expect(store.listInbound("bob@example.org")).toEqual([]);
    await store.updateRecords("bob@example.org", (view) => expect(view.get("session", "alice@example.org.7")?.toString()).toBe(`advanced:${version}`));
    store.close();
  });

  it("accepts the standard xml:lang attribute on an encrypted message", async () => {
    const stanza = await encryptedFixture(LEGACY_OMEMO);
    stanza.attrs["xml:lang"] = "en";
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-language-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const bindings: OmemoInboundBindings = { createSessionCipher() { return {
      async decryptWhisperMessage(value) { return { plaintext: value.slice().buffer }; },
      async decryptPreKeyWhisperMessage(value) { return { plaintext: value.slice().buffer }; }
    }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    const message = await inbound.decryptAndDispatch(stanza, async () => undefined);
    expect(message?.text).toBe("secret inbound");
    store.close();
  });

  it("derives a stable replay ID when an encrypted message omits its stanza ID", async () => {
    const stanza = await encryptedFixture(LEGACY_OMEMO);
    delete stanza.attrs.id;
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-derived-id-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const decrypt = vi.fn(async (value: Uint8Array) => ({ plaintext: value.slice().buffer }));
    const bindings: OmemoInboundBindings = { createSessionCipher() { return {
      decryptWhisperMessage: decrypt, decryptPreKeyWhisperMessage: decrypt
    }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    await expect(inbound.decryptAndDispatch(stanza, async () => { throw new Error("dispatcher offline"); })).rejects.toThrow("dispatcher offline");
    const [pending] = store.listInbound("bob@example.org");
    expect(pending?.id).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(inbound.decryptAndDispatch(stanza, async () => undefined)).rejects.toThrow("already pending");
    expect(decrypt).toHaveBeenCalledOnce();
    store.close();
  });

  it("commits payload-free key transport without dispatching a chat message", async () => {
    const stanza = await encryptedFixture(LEGACY_OMEMO, true);
    stanza.getChild("encrypted", LEGACY_OMEMO)!.remove(stanza.getChild("encrypted", LEGACY_OMEMO)!.getChild("payload", LEGACY_OMEMO)!);
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-key-transport-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const refresh = vi.fn(async () => undefined);
    const dispatch = vi.fn(async () => undefined);
    const bindings: OmemoInboundBindings = { createSessionCipher(adapter, address) { return {
      async decryptWhisperMessage(value) { adapter.storeSession(address, "advanced"); return { plaintext: value.slice().buffer }; },
      async decryptPreKeyWhisperMessage(value) { adapter.storeSession(address, "advanced"); return { plaintext: value.slice().buffer }; }
    }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu", refreshBundle: refresh });
    expect(await inbound.decryptAndDispatch(stanza, dispatch)).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledWith(LEGACY_OMEMO);
    expect(store.listInbound("bob@example.org")).toEqual([]);
    await store.updateRecords("bob@example.org", (view) => expect(view.get("session", "alice@example.org.7")?.toString()).toBe("advanced"));
    store.close();
  });

  it("recovers a committed payload-free key transport without dispatch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-key-transport-recovery-"));
    const faulted = new OmemoTransactionalStore({
      stateDirectory: directory,
      faultInjector(point) { if (point === "after-commit") throw new Error("crash after commit"); }
    });
    await expect(faulted.inbound("bob@example.org", "transport-1", "alice@example.org", async (view) => {
      view.set("session", "alice@example.org.7", Buffer.from("advanced"));
      return new Uint8Array();
    })).rejects.toThrow("crash after commit");
    faulted.close();

    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const bindings: OmemoInboundBindings = { createSessionCipher() { throw new Error("not used"); } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    const dispatch = vi.fn(async () => undefined);
    expect(await inbound.dispatchPending(dispatch)).toBe(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.listInbound("bob@example.org")).toEqual([]);
    await store.updateRecords("bob@example.org", (view) => expect(view.get("session", "alice@example.org.7")?.toString()).toBe("advanced"));
    store.close();
  });

  it.each(["groupchat", "headline", "invalid"])("rejects encrypted %s messages before ratchet use", async (type) => {
    const stanza = await encryptedFixture(LEGACY_OMEMO);
    stanza.attrs.type = type;
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-message-type-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const decrypt = vi.fn(async (value: Uint8Array) => ({ plaintext: value.slice().buffer }));
    const bindings: OmemoInboundBindings = { createSessionCipher() { return {
      decryptWhisperMessage: decrypt, decryptPreKeyWhisperMessage: decrypt
    }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    await expect(inbound.decryptAndDispatch(stanza, async () => undefined)).rejects.toThrow("Unsupported OMEMO message type");
    expect(decrypt).not.toHaveBeenCalled();
    expect(store.listInbound("bob@example.org")).toEqual([]);
    store.close();
  });

  it("retains a sealed delivery on dispatch failure and rejects replay without advancing the ratchet", async () => {
    const stanza = await encryptedFixture(LEGACY_OMEMO);
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-replay-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const decrypt = vi.fn(async (value: Uint8Array) => ({ plaintext: value.slice().buffer }));
    const bindings: OmemoInboundBindings = { createSessionCipher() { return { decryptWhisperMessage: decrypt, decryptPreKeyWhisperMessage: decrypt }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    await expect(inbound.decryptAndDispatch(stanza, async () => { throw new Error("dispatcher offline"); })).rejects.toThrow("dispatcher offline");
    expect(store.listInbound("bob@example.org")[0]?.plaintext.toString()).toBe("secret inbound");
    await expect(inbound.decryptAndDispatch(stanza, async () => undefined)).rejects.toThrow("already pending");
    expect(decrypt).toHaveBeenCalledOnce();
    const recovered: string[] = [];
    expect(await inbound.dispatchPending(async (value) => { recovered.push(value.text); })).toBe(1);
    expect(recovered).toEqual(["secret inbound"]);
    expect(store.listInbound("bob@example.org")).toEqual([]);
    store.close();
  });

  it("rolls back ratchet changes and dispatches nothing on authentication failure", async () => {
    const stanza = await encryptedFixture(OMEMO_2);
    const encrypted = stanza.getChild("encrypted", OMEMO_2)!;
    const payload = encrypted.getChild("payload", OMEMO_2)!;
    payload.children = [Buffer.from("tampered").toString("base64")];
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-auth-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const bindings: OmemoInboundBindings = { createSessionCipher(adapter, address) { return {
      async decryptWhisperMessage(value) { adapter.storeSession(address, "must-rollback"); return { plaintext: value.slice().buffer }; },
      async decryptPreKeyWhisperMessage(value) { return this.decryptWhisperMessage(value, "binary"); }
    }; } };
    const dispatch = vi.fn(async () => undefined);
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    await expect(inbound.decryptAndDispatch(stanza, dispatch)).rejects.toThrow("authentication failed");
    expect(dispatch).not.toHaveBeenCalled(); expect(store.listInbound("bob@example.org")).toEqual([]);
    await store.updateRecords("bob@example.org", (view) => expect(view.get("session", "alice@example.org.7")).toBeUndefined());
    store.close();
  });

  it("rejects an OMEMO 2 SCE sender that differs from the authenticated outer sender", async () => {
    const stanza = await encryptedFixture(OMEMO_2);
    stanza.attrs.from = "mallory@example.org/laptop";
    const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-sce-sender-"));
    const store = new OmemoTransactionalStore({ stateDirectory: directory });
    const bindings: OmemoInboundBindings = { createSessionCipher() { return {
      async decryptWhisperMessage(value) { return { plaintext: value.slice().buffer }; },
      async decryptPreKeyWhisperMessage(value) { return { plaintext: value.slice().buffer }; }
    }; } };
    const inbound = new OmemoInboundCoordinator({ account: "bob@example.org", localDeviceId: 9, store, bindings, trustMode: "tofu" });
    await expect(inbound.decryptAndDispatch(stanza, async () => undefined)).rejects.toThrow("SCE sender binding");
    expect(store.listInbound("bob@example.org")).toEqual([]);
    store.close();
  });
});

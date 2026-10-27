import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { xml } from "@xmpp/client";
import type { Element } from "@xmpp/xml";
import { describe, expect, it, vi } from "vitest";

import { LEGACY_OMEMO, type LibomemoEngineBindings, type OmemoVersion } from "../src/omemo/engine.js";
import { LibomemoStoreAdapter, type LibomemoKeyPair } from "../src/omemo/libomemo-store.js";
import type { OmemoInboundBindings, OmemoOutboundBindings } from "../src/omemo/message.js";
import { OmemoSession } from "../src/omemo/session.js";
import { OmemoTransactionalStore } from "../src/omemo/store.js";
import { PUBSUB, XmppOmemoPepAdapter } from "../src/omemo/xmpp-pep.js";

function pair(seed: number): LibomemoKeyPair {
  const pub = new Uint8Array(33); pub[0] = 5; pub.fill(seed, 1);
  const priv = new Uint8Array(32); priv.fill(seed + 1);
  return { pubKey: pub.buffer, privKey: priv.buffer };
}

function bindings(deviceId: number): LibomemoEngineBindings & OmemoOutboundBindings & OmemoInboundBindings {
  return {
    keyHelper: {
      async generateIdentityKeyPair() { return pair(deviceId); },
      generateRegistrationId() { return deviceId; },
      async generatePreKey(keyId) { return { keyId, keyPair: pair((keyId % 200) + 1) }; },
      async generateSignedPreKey(_identity, keyId, _version) {
        return { keyId, keyPair: pair((keyId % 200) + 1), signature: new Uint8Array(64).fill(7).buffer };
      }
    },
    async curvePubKeyToEd25519PubKey(publicKey) { return publicKey.slice(1); },
    createSessionBuilder(store: LibomemoStoreAdapter, address: string, version: OmemoVersion) {
      return { async processPreKey() { store.storeSession(address, JSON.stringify({ version })); } };
    },
    createSessionCipher(_store: LibomemoStoreAdapter, _address: string, _version: OmemoVersion) {
      return {
        async encrypt(plaintext: Uint8Array) {
          return { body: Buffer.from(plaintext).toString("binary"), type: 1 };
        },
        async decryptWhisperMessage(ciphertext: Uint8Array) { return { plaintext: Uint8Array.from(ciphertext).buffer }; },
        async decryptPreKeyWhisperMessage(ciphertext: Uint8Array) { return { plaintext: Uint8Array.from(ciphertext).buffer }; }
      };
    }
  };
}

function pepServer() {
  const items = new Map<string, Element>();
  const server = {
    items,
    failRetractionOnce: false,
    iq: { request: async (stanza: Element): Promise<Element> => {
      const owner = String(stanza.attrs.to);
      const pubsub = stanza.getChild("pubsub", PUBSUB);
      const get = pubsub?.getChild("items", PUBSUB);
      if (get) {
        const node = String(get.attrs.node);
        const id = String(get.getChild("item", PUBSUB)?.attrs.id);
        const payload = items.get(`${owner}\0${node}\0${id}`);
        if (!payload) throw Object.assign(new Error("missing"), { condition: "item-not-found" });
        return xml("iq", { type: "result" }, xml("pubsub", { xmlns: PUBSUB },
          xml("items", { node }, xml("item", { id }, payload))));
      }
      const publish = pubsub?.getChild("publish", PUBSUB);
      if (publish) {
        const node = String(publish.attrs.node);
        const item = publish.getChild("item", PUBSUB)!;
        items.set(`${owner}\0${node}\0${String(item.attrs.id)}`, item.getChildElements()[0]!);
      }
      const retract = pubsub?.getChild("retract", PUBSUB);
      if (retract) {
        if (server.failRetractionOnce) {
          server.failRetractionOnce = false;
          throw new Error("injected PEP retraction failure");
        }
        const node = String(retract.attrs.node);
        const id = String(retract.getChild("item", PUBSUB)?.attrs.id);
        items.delete(`${owner}\0${node}\0${id}`);
      }
      return xml("iq", { type: "result" });
    } }
  };
  return server;
}

function open(account: string, deviceId: number, directory: string, server: ReturnType<typeof pepServer>, deliveryPolicy: "strict-all" | "trusted-devices" = "strict-all", trustMode: "manual" | "tofu" = "tofu") {
  const store = new OmemoTransactionalStore({ stateDirectory: directory });
  const allBindings = bindings(deviceId);
  return {
    store,
    session: new OmemoSession({
      account, version: LEGACY_OMEMO, trustMode, deliveryPolicy, store,
      engineBindings: allBindings, outboundBindings: allBindings,
      inboundBindings: allBindings, pep: new XmppOmemoPepAdapter(account, server.iq)
    })
  };
}

describe("assembled OMEMO session", () => {
  it("excludes undecided, distrusted, retired and unavailable devices while retaining trusted recipients", async () => {
    const server = pepServer();
    const make = (jid: string, id: number, policy: "strict-all" | "trusted-devices" = "strict-all", mode: "manual" | "tofu" = "tofu") =>
      open(jid, id, mkdtempSync(join(tmpdir(), "omemo-plan-")), server, policy, mode);
    const alice = make("alice@example.org", 1, "trusted-devices", "manual");
    const bob = make("bob@example.org", 2);
    const unknown = make("bob@example.org", 3);
    const own = make("alice@example.org", 4);
    let wire: Element | undefined;
    for (const device of [alice, bob, unknown, own]) await device.session.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    await expect(alice.session.sendText("bob@example.org", "blocked")).rejects.toThrow("no trusted devices");
    expect(wire).toBeUndefined();
    const records = await alice.session.inspectTrust();
    expect(records).toHaveLength(3); // Discovery continues after undecided devices.
    const trusted = records.find((record) => record.address === "bob@example.org.2")!;
    const reviews = await alice.session.reviewPending("owner");
    const approval = reviews.find((record) => record.address === trusted.address)!;
    await expect(own.session.approveReview("owner", approval.code)).rejects.toThrow("Invalid");
    await alice.session.approveReview("owner", approval.code);
    await expect(alice.session.approveReview("owner", approval.code)).rejects.toThrow("Invalid");
    for (const state of ["undecided", "distrusted", "retired"] as const) {
      const current = (await alice.session.inspectTrust()).find((record) => record.address === "bob@example.org.3")!;
      await alice.session.transitionTrust(current.address, current, state);
      await alice.session.sendText("bob@example.org", "trusted only");
      expect(wire!.getChild("body")).toBeUndefined();
      const keys = wire!.getChild("encrypted", LEGACY_OMEMO)!.getChild("header", LEGACY_OMEMO)!.getChildren("key", LEGACY_OMEMO);
      expect(keys.map((key) => String(key.attrs.rid))).toEqual(["2"]);
      expect(alice.session.excludedDevices).toHaveLength(2);
    }
    server.items.delete(`bob@example.org\0${LEGACY_OMEMO}.bundles:3\0current`);
    await alice.session.sendText("bob@example.org", "missing optional bundle");
    expect(alice.session.excludedDevices).toContainEqual({ address: "bob@example.org.3", reason: "bundle-unavailable" });
    // Trusting only an own sync device never permits sending to an unknown recipient.
    const currentBob = (await alice.session.inspectTrust()).find((record) => record.address === trusted.address)!;
    await alice.session.transitionTrust(currentBob.address, currentBob, "distrusted");
    const ownRecord = (await alice.session.inspectTrust()).find((record) => record.address === "alice@example.org.4")!;
    await alice.session.transitionTrust(ownRecord.address, ownRecord, "trusted");
    await expect(alice.session.sendText("bob@example.org", "must not send")).rejects.toThrow("no trusted devices");
    for (const device of [alice, bob, unknown, own]) device.session.close();
  });

  it("rejects stale approval and keeps changed identities and corrupt records as hard failures", async () => {
    const server = pepServer();
    const alice = open("alice@example.org", 1, mkdtempSync(join(tmpdir(), "omemo-change-")), server, "trusted-devices", "manual");
    const bob = open("bob@example.org", 2, mkdtempSync(join(tmpdir(), "omemo-change-")), server);
    for (const device of [alice, bob]) await device.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    await expect(alice.session.sendText("bob@example.org", "discover")).rejects.toThrow();
    const [review] = await alice.session.reviewPending("owner");
    const [record] = await alice.session.inspectTrust();
    await alice.session.transitionTrust(record!.address, record!, "distrusted");
    await expect(alice.session.approveReview("owner", review!.code)).rejects.toThrow("changed since");
    await alice.store.updateRecords("alice@example.org", (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "manual" });
      adapter.trust.stageCandidate(record!.address, record!.fingerprint, pair(77).pubKey);
    });
    await expect(alice.session.sendText("bob@example.org", "changed")).rejects.toThrow("key changed");
    await alice.store.updateRecords("alice@example.org", (view) => view.set("trust", record!.address, Buffer.from("bad")));
    await expect(alice.session.sendText("bob@example.org", "corrupt")).rejects.toThrow();
    expect(alice.store.listOutbound("alice@example.org")).toHaveLength(0);
    alice.session.close(); bob.session.close();
  });

  it("consumes message bodies and encrypted traffic fail-closed before initialization", async () => {
    const server = pepServer();
    const value = open("alice@example.org", 99, mkdtempSync(join(tmpdir(), "omemo-starting-")), server);
    await expect(value.session.handleStanza(
      xml("message", { from: "bob@example.org/device" }, xml("encrypted", { xmlns: LEGACY_OMEMO }))
    )).resolves.toBe(true);
    await expect(value.session.handleStanza(
      xml("message", { from: "bob@example.org/device" }, xml("body", {}, "plain"))
    )).resolves.toBe(true);
    value.store.close();
  });

  it("delivers real ciphertext only to the trusted device after a second client appears", async () => {
    const lib = await import("libomemo.js") as Record<string, any>;
    const real = {
      keyHelper: lib.KeyHelper, curvePubKeyToEd25519PubKey: lib.curvePubKeyToEd25519PubKey,
      createSessionBuilder: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) => new lib.SessionBuilder(store, address, version),
      createSessionCipher: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) => new lib.SessionCipher(store, address, version)
    };
    const server = pepServer();
    const make = (account: string, manual = false) => {
      const store = new OmemoTransactionalStore({ stateDirectory: mkdtempSync(join(tmpdir(), "omemo-multi-real-")) });
      return new OmemoSession({ account, version: LEGACY_OMEMO, trustMode: manual ? "manual" : "tofu",
        deliveryPolicy: "trusted-devices", store, engineBindings: real, outboundBindings: real,
        inboundBindings: real, pep: new XmppOmemoPepAdapter(account, server.iq) });
    };
    const alice = make("alice@example.org", true), bob = make("bob@example.org"), unknown = make("bob@example.org");
    let wire: Element | undefined;
    const delivered = vi.fn(async () => undefined), excluded = vi.fn(async () => undefined);
    await alice.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    await bob.initialize({ send: async () => undefined, dispatch: delivered });
    await expect(alice.sendText("bob@example.org", "discover")).rejects.toThrow("no trusted devices");
    const [record] = await alice.inspectTrust();
    await alice.transitionTrust(record!.address, record!, "verified");
    await alice.sendText("bob@example.org", "baseline");
    wire!.attrs.from = "alice@example.org/client";
    await bob.handleStanza(wire!);
    await unknown.initialize({ send: async () => undefined, dispatch: excluded });
    await alice.sendText("bob@example.org", "still encrypted");
    expect(wire!.toString()).not.toContain("still encrypted");
    expect(wire!.getChild("body")).toBeUndefined();
    wire!.attrs.from = "alice@example.org/client";
    await bob.handleStanza(wire!);
    expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("still encrypted") }));
    expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining("awaiting approval") }));
    await expect(unknown.handleStanza(wire!)).rejects.toThrow();
    expect(excluded).not.toHaveBeenCalled();
    expect(alice.excludedDevices).toHaveLength(1);
    await alice.sendText("bob@example.org", "no repeated notice");
    wire!.attrs.from = "alice@example.org/client";
    await bob.handleStanza(wire!);
    expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ text: "no repeated notice" }));
    alice.close(); bob.close(); unknown.close();
  }, 30_000);

  it("completes a real maintained-fork round trip over mocked XMPP PEP", async () => {
    const lib = await import("libomemo.js") as Record<string, any>;
    const real = {
      keyHelper: lib.KeyHelper,
      curvePubKeyToEd25519PubKey: lib.curvePubKeyToEd25519PubKey,
      createSessionBuilder: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) =>
        new lib.SessionBuilder(store, address, version),
      createSessionCipher: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) =>
        new lib.SessionCipher(store, address, version)
    };
    const server = pepServer();
    const make = (account: string) => {
      const store = new OmemoTransactionalStore({ stateDirectory: mkdtempSync(join(tmpdir(), "omemo-real-")) });
      return { store, session: new OmemoSession({
        account, version: LEGACY_OMEMO, trustMode: "tofu", store,
        engineBindings: real, outboundBindings: real, inboundBindings: real,
        pep: new XmppOmemoPepAdapter(account, server.iq)
      }) };
    };
    const alice = make("alice@example.org");
    const bob = make("bob@example.org");
    let wire: Element | undefined;
    const delivered = vi.fn(async () => undefined);
    await alice.session.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    await bob.session.initialize({ send: async () => undefined, dispatch: delivered });
    await alice.session.sendText("bob@example.org", "real crypto round trip");
    wire!.attrs.from = "alice@example.org/openclaw";
    await bob.session.handleStanza(wire!);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ text: "real crypto round trip" }));
    alice.store.close(); bob.store.close();
  }, 30_000);

  it("exercises a manual-trust legacy activation, retirement, restart, and rollback with real bindings", async () => {
    const lib = await import("libomemo.js") as Record<string, any>;
    const real = {
      keyHelper: lib.KeyHelper,
      curvePubKeyToEd25519PubKey: lib.curvePubKeyToEd25519PubKey,
      createSessionBuilder: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) =>
        new lib.SessionBuilder(store, address, version),
      createSessionCipher: (store: LibomemoStoreAdapter, address: string, version: OmemoVersion) =>
        new lib.SessionCipher(store, address, version)
    };
    const server = pepServer();
    const aliceDirectory = mkdtempSync(join(tmpdir(), "omemo-activation-alice-"));
    const bobDirectory = mkdtempSync(join(tmpdir(), "omemo-activation-bob-"));
    const make = (account: string, directory: string) => {
      const store = new OmemoTransactionalStore({ stateDirectory: directory });
      return { store, session: new OmemoSession({
        account, version: LEGACY_OMEMO, trustMode: "manual", store,
        engineBindings: real, outboundBindings: real, inboundBindings: real,
        pep: new XmppOmemoPepAdapter(account, server.iq)
      }) };
    };
    let alice = make("alice@example.org", aliceDirectory);
    const bob = make("bob@example.org", bobDirectory);
    const delivered = vi.fn(async () => undefined);
    let wire: Element | undefined;
    await alice.session.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    await bob.session.initialize({ send: async () => undefined, dispatch: delivered });

    await expect(alice.session.sendText("bob@example.org", "activation proof"))
      .rejects.toThrow("operator review required");
    const bobIdentity = (await alice.session.inspectTrust())[0]!;
    expect(bobIdentity).toMatchObject({ state: "undecided" });
    await alice.session.transitionTrust(
      bobIdentity.address,
      { state: bobIdentity.state, fingerprint: bobIdentity.fingerprint },
      "verified"
    );
    await alice.session.sendText("bob@example.org", "activation proof");
    wire!.attrs.from = "alice@example.org/openclaw";
    await expect(bob.session.handleStanza(wire!)).rejects.toThrow("operator review required");
    // An inbound rejection rolls its transaction back, including identity
    // observation. Resolve the peer bundle through an outbound attempt so the
    // manual-trust record is committed for operator review.
    await expect(bob.session.sendText("alice@example.org", "trust discovery"))
      .rejects.toThrow("operator review required");
    const aliceIdentity = (await bob.session.inspectTrust())[0]!;
    expect(aliceIdentity).toMatchObject({ state: "undecided" });
    await bob.session.transitionTrust(
      aliceIdentity.address,
      { state: aliceIdentity.state, fingerprint: aliceIdentity.fingerprint },
      "verified"
    );
    await expect(bob.session.handleStanza(wire!)).resolves.toBe(true);
    expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ text: "activation proof" }));
    expect(alice.store.listOutbound("alice@example.org")).toHaveLength(0);
    expect(bob.store.listInbound("bob@example.org")).toHaveLength(0);

    const bundleEntry = [...server.items.entries()].find(([key]) =>
      key.startsWith(`alice@example.org\0${LEGACY_OMEMO}.bundles:`));
    expect(bundleEntry).toBeDefined();
    const [bundleKey, originalBundle] = bundleEntry!;
    const deviceId = Number(bundleKey.match(/\.bundles:(\d+)\0current$/)?.[1]);
    expect(deviceId).toBeGreaterThan(0);
    const listKey = [...server.items.keys()].find((key) =>
      key === `alice@example.org\0${LEGACY_OMEMO}.devicelist\0current`)!;

    await alice.session.retireLocalDevice(LEGACY_OMEMO, deviceId);
    expect(server.items.has(bundleKey)).toBe(false);
    expect(server.items.get(listKey)?.toString()).not.toContain(`id="${deviceId}"`);
    await expect(alice.session.sendText("bob@example.org", "blocked while retired"))
      .rejects.toThrow("local device is retired");
    alice.store.close();

    alice = make("alice@example.org", aliceDirectory);
    await alice.session.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    expect(server.items.has(bundleKey)).toBe(false);
    await alice.session.activateLocalDevice(LEGACY_OMEMO, deviceId);
    expect(server.items.get(bundleKey)?.toString()).toBe(originalBundle.toString());
    expect(server.items.get(listKey)?.toString()).toContain(`id="${deviceId}"`);
    await alice.session.sendText("bob@example.org", "rollback proof");
    wire!.attrs.from = "alice@example.org/openclaw";
    await expect(bob.session.handleStanza(wire!)).resolves.toBe(true);
    expect(delivered).toHaveBeenLastCalledWith(expect.objectContaining({ text: "rollback proof" }));
    expect(alice.store.listOutbound("alice@example.org")).toHaveLength(0);
    expect(bob.store.listInbound("bob@example.org")).toHaveLength(0);
    alice.store.close(); bob.store.close();
  }, 30_000);

  it("publishes, discovers, creates sessions, encrypts and decrypts between two accounts", async () => {
    const server = pepServer();
    const alice = open("alice@example.org", 101, mkdtempSync(join(tmpdir(), "omemo-a-")), server);
    const bob = open("bob@example.org", 202, mkdtempSync(join(tmpdir(), "omemo-b-")), server);
    const delivered = vi.fn(async () => undefined);
    let wire: Element | undefined;
    await alice.session.initialize({ send: async (stanza) => { wire = stanza; }, dispatch: async () => undefined });
    await bob.session.initialize({ send: async () => undefined, dispatch: delivered });
    const id = await alice.session.sendText("bob@example.org", "encrypted hello");
    expect(wire?.toString()).toContain(LEGACY_OMEMO);
    wire!.attrs.from = "alice@example.org/device";
    await expect(bob.session.handleStanza(wire!)).resolves.toBe(true);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ id, from: "alice@example.org", text: "encrypted hello" }));
    expect(alice.store.listOutbound("alice@example.org")).toHaveLength(0);
    expect(bob.store.listInbound("bob@example.org")).toHaveLength(0);
    alice.store.close(); bob.store.close();
  });

  it("reinitializes safely after a full reconnect and advertises only the configured profile", async () => {
    const server = pepServer();
    const value = open("alice@example.org", 212, mkdtempSync(join(tmpdir(), "omemo-reconnect-")), server);
    const firstSend = vi.fn(async () => undefined);
    const secondSend = vi.fn(async () => undefined);
    await value.session.initialize({ send: firstSend, dispatch: async () => undefined });
    const publishedNodes = [...server.items.keys()];
    expect(publishedNodes.some((key) => key.includes(LEGACY_OMEMO))).toBe(true);
    expect(publishedNodes.some((key) => key.includes("urn:xmpp:omemo:2"))).toBe(false);

    await expect(value.session.initialize({ send: secondSend, dispatch: async () => undefined })).resolves.toBeUndefined();
    value.store.close();
  });

  it("retires the exact local advertisement, blocks sends, and does not republish on reconnect", async () => {
    const server = pepServer();
    const directory = mkdtempSync(join(tmpdir(), "omemo-retire-"));
    const value = open("alice@example.org", 313, directory, server);
    await value.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    const bundleKey = [...server.items.keys()].find((key) => key.includes(`${LEGACY_OMEMO}.bundles:313`));
    const listKey = [...server.items.keys()].find((key) => key.includes(`${LEGACY_OMEMO}.devicelist`));
    expect(bundleKey).toBeDefined();
    expect(listKey).toBeDefined();

    await value.session.retireLocalDevice(LEGACY_OMEMO, 313);
    expect(server.items.has(bundleKey!)).toBe(false);
    expect(server.items.get(listKey!)?.toString()).not.toContain('id="313"');
    await expect(value.session.sendText("bob@example.org", "must not send"))
      .rejects.toThrow("local device is retired");
    await value.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    expect(server.items.has(bundleKey!)).toBe(false);
    expect(server.items.get(listKey!)?.toString()).not.toContain('id="313"');
    value.store.close();

    const restarted = open("alice@example.org", 313, directory, server);
    await restarted.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    expect(server.items.has(bundleKey!)).toBe(false);
    await expect(restarted.session.sendText("bob@example.org", "still blocked"))
      .rejects.toThrow("local device is retired");
    await restarted.session.activateLocalDevice(LEGACY_OMEMO, 313);
    expect(server.items.has(bundleKey!)).toBe(true);
    expect(server.items.get(listKey!)?.toString()).toContain('id="313"');
    restarted.store.close();
  });

  it("persists retirement before PEP failure and completes it after restart", async () => {
    const server = pepServer();
    const directory = mkdtempSync(join(tmpdir(), "omemo-retire-recovery-"));
    const first = open("alice@example.org", 314, directory, server);
    await first.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    const bundleKey = [...server.items.keys()].find((key) => key.includes(`${LEGACY_OMEMO}.bundles:314`))!;
    server.failRetractionOnce = true;
    await expect(first.session.retireLocalDevice(LEGACY_OMEMO, 314))
      .rejects.toThrow("injected PEP retraction failure");
    expect(server.items.has(bundleKey)).toBe(true);
    await expect(first.session.sendText("bob@example.org", "blocked after partial retirement"))
      .rejects.toThrow("local device is retired");
    first.store.close();

    const restarted = open("alice@example.org", 314, directory, server);
    await restarted.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    expect(server.items.has(bundleKey)).toBe(false);
    restarted.store.close();
  });

  it("replays exact committed ciphertext after restart without advancing the ratchet again", async () => {
    const server = pepServer();
    const directory = mkdtempSync(join(tmpdir(), "omemo-restart-"));
    const first = open("alice@example.org", 303, directory, server);
    await first.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    await expect(first.session.sendText("alice@example.org", "recover me")).rejects.toThrow("no trusted devices");

    // Add another account device and force a post-commit transport failure.
    const peer = open("bob@example.org", 404, mkdtempSync(join(tmpdir(), "omemo-peer-")), server);
    await peer.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    const failing = open("carol@example.org", 505, mkdtempSync(join(tmpdir(), "omemo-c-")), server);
    await failing.session.initialize({ send: async () => undefined, dispatch: async () => undefined });
    const originalSend = vi.fn(async () => { throw new Error("offline"); });
    // A separate account is used because session IO is intentionally immutable.
    const failedDir = mkdtempSync(join(tmpdir(), "omemo-failed-"));
    const failed = open("dave@example.org", 606, failedDir, server);
    await failed.session.initialize({ send: originalSend, dispatch: async () => undefined });
    await expect(failed.session.sendText("bob@example.org", "recover me")).rejects.toThrow("offline");
    const committed = failed.store.listOutbound("dave@example.org")[0]!.stanza.toString("utf8");
    failed.store.close();

    const replayed: string[] = [];
    const restarted = open("dave@example.org", 606, failedDir, server);
    await restarted.session.initialize({ send: async (stanza) => { replayed.push(stanza.toString()); }, dispatch: async () => undefined });
    expect(replayed).toEqual([committed]);
    expect(restarted.store.listOutbound("dave@example.org")).toHaveLength(0);
    first.store.close(); peer.store.close(); failing.store.close(); restarted.store.close();
  });

  it("consumes plaintext bodies while active instead of falling back to plaintext dispatch", async () => {
    const server = pepServer();
    const value = open("alice@example.org", 707, mkdtempSync(join(tmpdir(), "omemo-plain-")), server);
    const dispatch = vi.fn(async () => undefined);
    await value.session.initialize({ send: async () => undefined, dispatch });
    await expect(value.session.handleStanza(xml("message", { from: "bob@example.org" }, xml("body", {}, "plain")))).resolves.toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    value.store.close();
  });
});

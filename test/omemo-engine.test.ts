import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  LEGACY_OMEMO,
  OMEMO_2,
  OmemoEngine,
  type LibomemoEngineBindings,
  type OmemoRemoteBundle,
  type OmemoVersion
} from "../src/omemo/engine.js";
import { LibomemoStoreAdapter, type LibomemoKeyPair } from "../src/omemo/libomemo-store.js";
import { OmemoTransactionalStore } from "../src/omemo/store.js";

function keyPair(seed: number): LibomemoKeyPair {
  const pub = new Uint8Array(33);
  pub[0] = 5;
  pub.fill(seed & 0xff, 1);
  const priv = new Uint8Array(32);
  priv.fill((seed + 1) & 0xff);
  return { pubKey: pub.buffer, privKey: priv.buffer };
}

function fixture() {
  let generated = 0;
  const sessions: Array<{ address: string; version: OmemoVersion }> = [];
  const bindings: LibomemoEngineBindings = {
    keyHelper: {
      async generateIdentityKeyPair() { generated++; return keyPair(240); },
      generateRegistrationId() { return 8123; },
      async generatePreKey(id) { generated++; return { keyId: id, keyPair: keyPair(id) }; },
      async generateSignedPreKey(_identity, id, version) {
        generated++;
        const signature = new Uint8Array(64);
        signature[0] = version === LEGACY_OMEMO ? 1 : 2;
        signature[1] = id;
        return {
          keyId: id,
          keyPair: keyPair(id),
          signature: signature.buffer
        };
      }
    },
    async curvePubKeyToEd25519PubKey(publicKey) { return publicKey.slice(1); },
    createSessionBuilder(store, address, version) {
      return {
        async processPreKey(bundle) {
          store.isTrustedIdentity(address, bundle.identityKey, 1);
          store.storeSession(address, JSON.stringify({ version, registrationId: bundle.registrationId }));
          sessions.push({ address, version });
        }
      };
    }
  };
  return { bindings, sessions, generated: () => generated };
}

function openStore(directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-engine-"))) {
  return { directory, store: new OmemoTransactionalStore({ stateDirectory: directory }) };
}

describe("OmemoEngine", () => {
  it("atomically initializes one stable device and profile-specific bundles", async () => {
    const { directory, store } = openStore();
    const state = fixture();
    const engine = new OmemoEngine({
      account: "alice@example.org",
      store,
      bindings: state.bindings,
      trustMode: "tofu",
      preKeyTarget: 4,
      preKeyLowWatermark: 1,
      clock: () => 1000
    });

    const first = await engine.initialize();
    expect(first[LEGACY_OMEMO].deviceId).toBe(8123);
    expect(first[LEGACY_OMEMO].identityKey.byteLength).toBe(33);
    expect(first[OMEMO_2].identityKey.byteLength).toBe(32);
    expect(new Uint8Array(first[LEGACY_OMEMO].signedPreKey.signature).slice(0, 2)).toEqual(Uint8Array.of(1, 1));
    expect(new Uint8Array(first[OMEMO_2].signedPreKey.signature).slice(0, 2)).toEqual(Uint8Array.of(2, 6));
    expect(first[LEGACY_OMEMO].preKeys).toHaveLength(4);
    expect(first[OMEMO_2].preKeys).toHaveLength(4);
    expect(first[LEGACY_OMEMO].preKeys[0]?.publicKey.byteLength).toBe(33);
    expect(first[OMEMO_2].preKeys[0]?.publicKey.byteLength).toBe(32);
    expect(state.generated()).toBe(11);
    store.close();

    const reopened = new OmemoTransactionalStore({ stateDirectory: directory });
    const restarted = new OmemoEngine({
      account: "alice@example.org",
      store: reopened,
      bindings: state.bindings,
      trustMode: "tofu",
      preKeyTarget: 4,
      preKeyLowWatermark: 1,
      clock: () => 1000
    });
    const second = await restarted.initialize();
    expect(second).toEqual(first);
    expect(state.generated()).toBe(11);
    reopened.close();
  });

  it("replenishes only at the low watermark and never reuses consumed IDs", async () => {
    const { store } = openStore();
    const state = fixture();
    const options = {
      account: "alice@example.org", store, bindings: state.bindings, trustMode: "tofu" as const,
      preKeyTarget: 3, preKeyLowWatermark: 1, clock: () => 1000
    };
    const engine = new OmemoEngine(options);
    const initial = await engine.initialize();
    const ids = initial[LEGACY_OMEMO].preKeys.map((key) => key.id);

    await store.updateRecords("alice@example.org", (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
      adapter.removePreKey(ids[0]!);
    });
    const aboveWatermark = await engine.maintainKeys();
    expect(aboveWatermark[LEGACY_OMEMO].preKeys.map((key) => key.id)).toEqual(ids.slice(1));

    await store.updateRecords("alice@example.org", (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
      adapter.removePreKey(ids[1]!);
    });
    const replenished = await engine.maintainKeys();
    const replenishedIds = replenished[LEGACY_OMEMO].preKeys.map((key) => key.id);
    expect(replenishedIds).toHaveLength(3);
    expect(replenishedIds).toContain(ids[2]);
    expect(Math.min(...replenishedIds.filter((id) => !ids.includes(id)))).toBeGreaterThan(Math.max(...ids));
    store.close();
  });

  it("rotates aged signed prekeys while retaining the previous inbound key", async () => {
    let now = 1000;
    const { store } = openStore();
    const state = fixture();
    const engine = new OmemoEngine({
      account: "alice@example.org", store, bindings: state.bindings, trustMode: "tofu",
      preKeyTarget: 2, preKeyLowWatermark: 1, signedPreKeyMaxAgeMs: 100,
      retainedSignedPreKeys: 2, clock: () => now
    });
    const first = await engine.initialize();
    const oldId = first[LEGACY_OMEMO].signedPreKey.id;
    now = 1100;
    const second = await engine.maintainKeys();
    expect(second[LEGACY_OMEMO].signedPreKey.id).not.toBe(oldId);
    await store.updateRecords("alice@example.org", (view) => {
      expect(new LibomemoStoreAdapter(view, { mode: "tofu" }).loadSignedPreKey(oldId)).toBeDefined();
    });
    now = 1200;
    await engine.maintainKeys();
    await store.updateRecords("alice@example.org", (view) => {
      expect(new LibomemoStoreAdapter(view, { mode: "tofu" }).loadSignedPreKey(oldId)).toBeUndefined();
    });
    store.close();
  });

  it("constructs sessions within the transactional view and persists them", async () => {
    const { directory, store } = openStore();
    const state = fixture();
    const engine = new OmemoEngine({
      account: "alice@example.org", store, bindings: state.bindings, trustMode: "tofu",
      preKeyTarget: 2, preKeyLowWatermark: 1
    });
    await engine.initialize();
    const remote: OmemoRemoteBundle = {
      identityKey: keyPair(90).pubKey,
      registrationId: 9,
      signedPreKey: { keyId: 1, publicKey: keyPair(91).pubKey, signature: Uint8Array.of(1).buffer }
    };
    await engine.buildSession("bob@example.org.9", LEGACY_OMEMO, remote);
    expect(state.sessions).toEqual([{ address: "bob@example.org.9", version: LEGACY_OMEMO }]);
    store.close();

    const reopened = new OmemoTransactionalStore({ stateDirectory: directory });
    await reopened.updateRecords("alice@example.org", (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
      expect(adapter.loadSession("bob@example.org.9")).toContain(LEGACY_OMEMO);
      expect(adapter.trust.get("bob@example.org.9")?.state).toBe("trusted");
    });
    reopened.close();
  });

  it("fails closed on partial local identity state and invalid lifecycle settings", async () => {
    const { store } = openStore();
    const state = fixture();
    await store.updateRecords("alice@example.org", (view) => {
      new LibomemoStoreAdapter(view, { mode: "tofu" }).put("registrationId", 3);
    });
    const engine = new OmemoEngine({
      account: "alice@example.org", store, bindings: state.bindings, trustMode: "tofu",
      preKeyTarget: 2, preKeyLowWatermark: 1
    });
    await expect(engine.initialize()).rejects.toThrow("Corrupt OMEMO local identity");
    expect(() => new OmemoEngine({
      account: "alice@example.org", store, bindings: state.bindings, trustMode: "tofu",
      preKeyTarget: 2, preKeyLowWatermark: 2
    })).toThrow("low watermark");
    store.close();
  });

  it.each([LEGACY_OMEMO, OMEMO_2] as const)(
    "builds and uses a real maintained-fork session for %s",
    async (version) => {
      const lib = await import("libomemo.js") as Record<string, any>;
      const bindings: LibomemoEngineBindings = {
        keyHelper: lib.KeyHelper,
        curvePubKeyToEd25519PubKey: lib.curvePubKeyToEd25519PubKey,
        createSessionBuilder: (store, address, profile) => new lib.SessionBuilder(store, address, profile)
      };
      const alice = openStore();
      const bob = openStore();
      const aliceEngine = new OmemoEngine({
        account: "alice@example.org", store: alice.store, bindings, trustMode: "tofu",
        preKeyTarget: 2, preKeyLowWatermark: 1
      });
      const bobEngine = new OmemoEngine({
        account: "bob@example.org", store: bob.store, bindings, trustMode: "tofu",
        preKeyTarget: 2, preKeyLowWatermark: 1
      });
      await aliceEngine.initialize();
      const bobBundle = (await bobEngine.initialize())[version];
      const oneTime = bobBundle.preKeys[0]!;
      await aliceEngine.buildSession("bob@example.org.8123", version, {
        identityKey: bobBundle.identityKey,
        registrationId: bobBundle.deviceId,
        signedPreKey: {
          keyId: bobBundle.signedPreKey.id,
          publicKey: bobBundle.signedPreKey.publicKey,
          signature: bobBundle.signedPreKey.signature
        },
        preKey: { keyId: oneTime.id, publicKey: oneTime.publicKey }
      });

      const encrypted = await alice.store.updateRecords("alice@example.org", async (view) => {
        const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
        return new lib.SessionCipher(adapter, "bob@example.org.8123", version)
          .encrypt(new TextEncoder().encode("engine-round-trip").buffer);
      });
      const decrypted = await bob.store.updateRecords("bob@example.org", async (view) => {
        const adapter = new LibomemoStoreAdapter(view, { mode: "tofu" });
        const cipher = new lib.SessionCipher(adapter, "alice@example.org.8123", version);
        return cipher.decryptPreKeyWhisperMessage(encrypted.body, "binary");
      });
      expect(new TextDecoder().decode(decrypted.plaintext)).toBe("engine-round-trip");
      const maintained = await bobEngine.maintainKeys();
      expect(maintained[version].preKeys.map((key) => key.id)).not.toContain(oneTime.id);
      alice.store.close();
      bob.store.close();
    },
    30_000
  );
});

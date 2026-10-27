import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  formatIdentityFingerprint,
  LibomemoStoreAdapter,
  OmemoIdentityChangedError,
  OmemoTrustConflictError,
  OmemoTrustError,
  type LibomemoKeyPair
} from "../src/omemo/libomemo-store.js";
import { OmemoTransactionalStore } from "../src/omemo/store.js";

const ACCOUNT = "account";
const ADDRESS = "peer@example.test.7";
const directories: string[] = [];

function temporaryState(): string {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-xmpp-libomemo-"));
  directories.push(directory);
  return directory;
}

function bytes(length: number, fill: number): ArrayBuffer {
  return Uint8Array.from({ length }, (_, index) => index === 0 && length === 33 ? 0x05 : fill).buffer;
}

function keyPair(fill: number): LibomemoKeyPair {
  return { pubKey: bytes(33, fill), privKey: bytes(32, fill + 1) };
}

function identity(fill: number, modern = false): ArrayBuffer {
  return bytes(modern ? 32 : 33, fill);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("LibomemoStoreAdapter", () => {
  it("persists the exact libomemo.js key, session, and initialization callbacks", async () => {
    const stateDirectory = temporaryState();
    let store = new OmemoTransactionalStore({ stateDirectory });
    const localIdentity = keyPair(11);
    const preKey = keyPair(21);
    const signedPreKey = keyPair(31);

    await store.updateRecords(ACCOUNT, async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu" });
      callbacks.put("identityKey", localIdentity);
      callbacks.put("registrationId", 1337);
      callbacks.storePreKey("04", preKey);
      callbacks.storeSignedPreKey(5, signedPreKey);
      callbacks.storeSession(ADDRESS, "serialized-session");
      callbacks.storeSession("other@example.test.8", "other-session");
      expect(callbacks.store).toEqual({});
    });
    store.close();

    store = new OmemoTransactionalStore({ stateDirectory });
    await store.updateRecords(ACCOUNT, async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu" });
      expect(new Uint8Array(callbacks.getIdentityKeyPair()!.pubKey)).toEqual(new Uint8Array(localIdentity.pubKey));
      expect(callbacks.get<number>("registrationId")).toBe(1337);
      expect(new Uint8Array((await callbacks.loadPreKey("04"))!.keyPair.privKey)).toEqual(
        new Uint8Array(preKey.privKey)
      );
      expect(new Uint8Array(callbacks.loadSignedPreKey(5)!.keyPair.pubKey)).toEqual(
        new Uint8Array(signedPreKey.pubKey)
      );
      expect(callbacks.loadSession(ADDRESS)).toBe("serialized-session");
      callbacks.removePreKey("04");
      callbacks.removeSignedPreKey("5");
      callbacks.removeAllSessions("peer@example.test");
      expect(await callbacks.loadPreKey("04")).toBeUndefined();
      expect(callbacks.loadSignedPreKey(5)).toBeUndefined();
      expect(callbacks.loadSession(ADDRESS)).toBeUndefined();
      expect(callbacks.loadSession("other@example.test.8")).toBe("other-session");
    });
    store.close();
  });

  it("commits callback mutations with the exact outbound stanza", async () => {
    const stateDirectory = temporaryState();
    let store = new OmemoTransactionalStore({ stateDirectory, clock: () => 40 });

    await store.outbound(ACCOUNT, "message-1", "peer@example.test", async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 30 });
      callbacks.storeSession(ADDRESS, "ratchet-state");
      return Buffer.from("<encrypted>exact</encrypted>");
    });
    store.close();

    store = new OmemoTransactionalStore({ stateDirectory });
    expect(store.listOutbound(ACCOUNT)[0]?.stanza.toString()).toBe("<encrypted>exact</encrypted>");
    await store.updateRecords(ACCOUNT, (view) => {
      expect(new LibomemoStoreAdapter(view, { mode: "tofu" }).loadSession(ADDRESS)).toBe("ratchet-state");
    });
    store.close();
  });

  it("applies TOFU on first sight without claiming verification", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const remoteIdentity = identity(41);

    await store.updateRecords(ACCOUNT, (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 100 });
      expect(callbacks.isTrustedIdentity(ADDRESS, remoteIdentity, 1)).toBe(true);
      expect(callbacks.saveIdentity(ADDRESS, remoteIdentity)).toBe(false);
      expect(callbacks.trust.get(ADDRESS)).toEqual({
        state: "trusted",
        fingerprint: formatIdentityFingerprint(remoteIdentity),
        firstObservedAt: 100,
        lastObservedAt: 100
      });
    });

    await store.updateRecords(ACCOUNT, (view) => {
      const record = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 150 })
        .trust.observeIdentity(ADDRESS, remoteIdentity);
      expect(record.state).toBe("trusted");
      expect(record.lastObservedAt).toBe(150);
    });
    store.close();
  });

  it("blocks manual-trust identities until an exact compare-and-set decision", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const remoteIdentity = identity(51, true);
    let observedFingerprint = "";

    await store.updateRecords(ACCOUNT, (view) => {
      const record = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 200 })
        .trust.observeIdentity(ADDRESS, remoteIdentity);
      expect(record.state).toBe("undecided");
      observedFingerprint = record.fingerprint;
    });

    await expect(store.outbound(ACCOUNT, "blocked", "peer@example.test", async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 201 });
      callbacks.isTrustedIdentity(ADDRESS, remoteIdentity, 1);
      return Buffer.from("must-not-send");
    })).rejects.toMatchObject({
      name: "OmemoTrustError",
      code: "OMEMO_IDENTITY_NOT_TRUSTED",
      state: "undecided",
      direction: 1
    } satisfies Partial<OmemoTrustError>);
    expect(store.listOutbound(ACCOUNT)).toEqual([]);

    await store.updateRecords(ACCOUNT, (view) => {
      const trust = new LibomemoStoreAdapter(view, { mode: "manual" }).trust;
      expect(() => trust.transition(ADDRESS, {
        state: "trusted",
        fingerprint: observedFingerprint
      }, "verified")).toThrow(OmemoTrustConflictError);
      expect(trust.transition(ADDRESS, {
        state: "undecided",
        fingerprint: observedFingerprint
      }, "verified").state).toBe("verified");
    });

    await store.outbound(ACCOUNT, "allowed", "peer@example.test", async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 202 });
      expect(callbacks.isTrustedIdentity(ADDRESS, remoteIdentity, 1)).toBe(true);
      return Buffer.from("ciphertext");
    });
    expect(store.listOutbound(ACCOUNT).map(({ id }) => id)).toEqual(["allowed"]);
    store.close();
  });

  it("hard-fails identity changes without replacing trusted state", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const originalIdentity = identity(61);
    const changedIdentity = identity(62);

    await store.updateRecords(ACCOUNT, (view) => {
      new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 300 })
        .trust.observeIdentity(ADDRESS, originalIdentity);
    });

    await expect(store.outbound(ACCOUNT, "changed", "peer@example.test", async (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 301 });
      callbacks.isTrustedIdentity(ADDRESS, changedIdentity, 2);
      return Buffer.from("must-not-send");
    })).rejects.toMatchObject({
      name: "OmemoIdentityChangedError",
      code: "OMEMO_IDENTITY_CHANGED",
      previousFingerprint: formatIdentityFingerprint(originalIdentity),
      observedFingerprint: formatIdentityFingerprint(changedIdentity)
    } satisfies Partial<OmemoIdentityChangedError>);
    expect(store.listOutbound(ACCOUNT)).toEqual([]);

    await store.updateRecords(ACCOUNT, (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu" });
      expect(new Uint8Array(callbacks.loadIdentityKey(ADDRESS)!)).toEqual(new Uint8Array(originalIdentity));
      expect(callbacks.trust.get(ADDRESS)?.fingerprint).toBe(formatIdentityFingerprint(originalIdentity));
    });
    store.close();
  });

  it("requires exact prior trust when accepting a replacement and deletes the old session", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const originalIdentity = identity(71);
    const replacementIdentity = identity(72, true);
    let originalFingerprint = "";

    await store.updateRecords(ACCOUNT, (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 400 });
      const original = callbacks.trust.observeIdentity(ADDRESS, originalIdentity);
      originalFingerprint = original.fingerprint;
      callbacks.storeSession(ADDRESS, "old-ratchet");
    });

    await store.updateRecords(ACCOUNT, (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu", clock: () => 500 });
      expect(() => callbacks.trust.replaceIdentity(ADDRESS, {
        state: "verified",
        fingerprint: originalFingerprint
      }, replacementIdentity, formatIdentityFingerprint(replacementIdentity))).toThrow(OmemoTrustConflictError);
      expect(() => callbacks.trust.replaceIdentity(ADDRESS, {
        state: "trusted",
        fingerprint: originalFingerprint
      }, replacementIdentity, formatIdentityFingerprint(identity(99)))).toThrow(OmemoTrustConflictError);
      const replacement = callbacks.trust.replaceIdentity(ADDRESS, {
        state: "trusted",
        fingerprint: originalFingerprint
      }, replacementIdentity, formatIdentityFingerprint(replacementIdentity), "undecided");
      expect(replacement).toEqual({
        state: "undecided",
        fingerprint: formatIdentityFingerprint(replacementIdentity),
        firstObservedAt: 500,
        lastObservedAt: 500
      });
      expect(callbacks.loadSession(ADDRESS)).toBeUndefined();
    });
    store.close();
  });

  it("stages a reviewable replacement candidate without changing identity or trust", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const originalIdentity = identity(81);
    const candidateIdentity = identity(82);
    const originalFingerprint = formatIdentityFingerprint(originalIdentity);
    await store.updateRecords(ACCOUNT, (view) => {
      const trust = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 600 }).trust;
      trust.observeIdentity(ADDRESS, originalIdentity);
      const candidate = trust.stageCandidate(ADDRESS, originalFingerprint, candidateIdentity);
      expect(candidate.observedFingerprint).toBe(formatIdentityFingerprint(candidateIdentity));
      expect(trust.get(ADDRESS)?.fingerprint).toBe(originalFingerprint);
    });
    await store.updateRecords(ACCOUNT, (view) => {
      const trust = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 700 }).trust;
      const candidate = trust.candidate(ADDRESS)!;
      expect(candidate.observedAt).toBe(600);
      trust.replaceIdentity(
        ADDRESS,
        { state: "undecided", fingerprint: originalFingerprint },
        candidate.identityKey,
        candidate.observedFingerprint,
        "verified"
      );
      expect(trust.candidate(ADDRESS)).toBeUndefined();
      expect(trust.get(ADDRESS)?.state).toBe("verified");
    });
    store.close();
  });

  it("fails closed on malformed callback records and invalid key material", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    await store.updateRecords(ACCOUNT, (view) => view.set("session", ADDRESS, Uint8Array.of(0xff)));
    await expect(store.updateRecords(ACCOUNT, (view) => {
      new LibomemoStoreAdapter(view, { mode: "tofu" }).loadSession(ADDRESS);
    })).rejects.toThrow("Corrupt OMEMO session record encoding");
    await expect(store.updateRecords(ACCOUNT, (view) => {
      const callbacks = new LibomemoStoreAdapter(view, { mode: "tofu" });
      callbacks.put("identityKey", { pubKey: bytes(32, 1), privKey: bytes(32, 2) });
    })).rejects.toThrow("Invalid OMEMO public key length");
    await expect(store.updateRecords(ACCOUNT, (view) => {
      new LibomemoStoreAdapter(view, { mode: "tofu" }).get("arbitrary-key");
    })).rejects.toThrow("Unsupported libomemo.js generic store key");
    store.close();
  });
});

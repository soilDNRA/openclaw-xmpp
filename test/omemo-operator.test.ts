import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatIdentityFingerprint, LibomemoStoreAdapter } from "../src/omemo/libomemo-store.js";
import { OmemoOperator } from "../src/omemo/operator.js";
import { OmemoTransactionalStore } from "../src/omemo/store.js";

const directories: string[] = [];
const account = "alice@example.org";
const address = "bob@example.org.9";

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-omemo-operator-"));
  directories.push(directory);
  return directory;
}

function identity(fill: number): ArrayBuffer {
  const value = new Uint8Array(33);
  value[0] = 5;
  value.fill(fill, 1);
  return value.buffer;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OmemoOperator", () => {
  it("lists, compare-and-set transitions, and guarded candidate replacement atomically", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: stateDirectory() });
    const original = identity(3);
    const replacement = identity(4);
    const originalFingerprint = formatIdentityFingerprint(original);
    const replacementFingerprint = formatIdentityFingerprint(replacement);
    await store.updateRecords(account, (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "manual", clock: () => 10 });
      adapter.trust.observeIdentity(address, original);
      adapter.trust.stageCandidate(address, originalFingerprint, replacement);
      adapter.storeSession(address, "old-session");
    });
    const operator = new OmemoOperator(account, store, "manual");
    expect(await operator.inspectTrust()).toEqual([expect.objectContaining({
      address,
      state: "undecided",
      fingerprint: originalFingerprint,
      candidate: expect.objectContaining({ observedFingerprint: replacementFingerprint })
    })]);
    await expect(operator.transition(address, {
      state: "trusted", fingerprint: originalFingerprint
    }, "verified")).rejects.toThrow("changed since it was reviewed");
    await operator.transition(address, {
      state: "undecided", fingerprint: originalFingerprint
    }, "verified");
    await expect(operator.replaceIdentity(address, {
      state: "verified", fingerprint: originalFingerprint
    }, formatIdentityFingerprint(identity(5)), "undecided")).rejects.toThrow("candidate changed");
    await operator.replaceIdentity(address, {
      state: "verified", fingerprint: originalFingerprint
    }, replacementFingerprint, "undecided");
    await store.updateRecords(account, (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: "manual" });
      expect(adapter.trust.get(address)?.fingerprint).toBe(replacementFingerprint);
      expect(adapter.trust.candidate(address)).toBeUndefined();
      expect(adapter.loadSession(address)).toBeUndefined();
    });
    store.close();
  });
});

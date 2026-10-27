import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { OmemoTransactionalStore } from "../src/omemo/store.js";

const directories: string[] = [];

function temporaryState(): string {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-xmpp-omemo-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("OmemoTransactionalStore", () => {
  it("commits ratchet state and exact outbound stanza together across restart", async () => {
    const stateDirectory = temporaryState();
    let store = new OmemoTransactionalStore({ stateDirectory, clock: () => 1234 });
    await store.outbound("account", "message-1", "peer@example.test", async (view) => {
      view.set("session", "peer:7", Buffer.from("ratchet-1"));
      return Buffer.from("<encrypted>exact-ciphertext</encrypted>");
    });
    store.close();

    store = new OmemoTransactionalStore({ stateDirectory });
    expect(store.listOutbound("account")).toEqual([{
      id: "message-1",
      recipient: "peer@example.test",
      stanza: Buffer.from("<encrypted>exact-ciphertext</encrypted>"),
      createdAt: 1234
    }]);
    await store.outbound("account", "message-2", "peer@example.test", async (view) => {
      expect(view.get("session", "peer:7")?.toString()).toBe("ratchet-1");
      return Buffer.from("ciphertext-2");
    });
    store.close();
  });

  it("does not persist callback mutations when crypto fails", async () => {
    const stateDirectory = temporaryState();
    const store = new OmemoTransactionalStore({ stateDirectory });
    await expect(store.outbound("account", "failed", "peer", async (view) => {
      view.set("identity", "local", Buffer.from("must-not-commit"));
      throw new Error("crypto failed");
    })).rejects.toThrow("crypto failed");
    await store.outbound("account", "passed", "peer", async (view) => {
      expect(view.get("identity", "local")).toBeUndefined();
      return Buffer.from("ciphertext");
    });
    store.close();
  });

  it("commits and rolls back standalone record updates atomically", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    await store.updateRecords("account", (view) => view.set("trust", "peer:7", Buffer.from("trusted")));
    await expect(store.updateRecords("account", (view) => {
      view.set("trust", "peer:7", Buffer.from("must-not-commit"));
      throw new Error("review cancelled");
    })).rejects.toThrow("review cancelled");
    await store.updateRecords("account", (view) => {
      expect(view.get("trust", "peer:7")?.toString()).toBe("trusted");
    });
    store.close();
  });

  it("does not attempt rollback after a simulated post-commit failure", async () => {
    const stateDirectory = temporaryState();
    let store = new OmemoTransactionalStore({
      stateDirectory,
      faultInjector(point) {
        if (point === "after-commit") throw new Error("simulated process exit");
      }
    });
    await expect(store.updateRecords("account", (view) => {
      view.set("device", "local", Buffer.from("persisted"));
    })).rejects.toThrow("simulated process exit");
    store.close();

    store = new OmemoTransactionalStore({ stateDirectory });
    await store.updateRecords("account", (view) => {
      expect(view.get("device", "local")?.toString()).toBe("persisted");
    });
    store.close();
  });

  it("encrypts pending inbound plaintext and authenticates it after restart", async () => {
    const stateDirectory = temporaryState();
    let store = new OmemoTransactionalStore({ stateDirectory, clock: () => 99 });
    await store.inbound("account", "in-1", "peer", async (view) => {
      view.set("session", "peer:7", Buffer.from("advanced"));
      return Buffer.from("private plaintext");
    });
    store.close();
    expect(readFileSync(join(stateDirectory, "omemo.sqlite")).includes(Buffer.from("private plaintext"))).toBe(false);

    store = new OmemoTransactionalStore({ stateDirectory });
    expect(store.listInbound("account")[0]?.plaintext.toString()).toBe("private plaintext");
    store.close();
    expect(statSync(stateDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDirectory, "omemo.sqlite")).mode & 0o777).toBe(0o600);
    expect(statSync(join(stateDirectory, "pending-delivery.key")).mode & 0o777).toBe(0o600);
  });

  it("fails closed when the pending-delivery key is corrupt", () => {
    const stateDirectory = temporaryState();
    const store = new OmemoTransactionalStore({ stateDirectory });
    store.close();
    writeFileSync(join(stateDirectory, "pending-delivery.key"), Buffer.alloc(3));
    chmodSync(join(stateDirectory, "pending-delivery.key"), 0o600);
    expect(() => new OmemoTransactionalStore({ stateDirectory })).toThrow("Invalid OMEMO pending-delivery key length");
  });

  it("serializes concurrent operations for one database", async () => {
    const store = new OmemoTransactionalStore({ stateDirectory: temporaryState() });
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = store.outbound("account", "one", "peer", async () => {
      order.push("one-start");
      await gate;
      order.push("one-end");
      return Buffer.from("one");
    });
    const second = store.outbound("account", "two", "peer", async () => {
      order.push("two");
      return Buffer.from("two");
    });
    await Promise.resolve();
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["one-start", "one-end", "two"]);
    store.close();
  });

  for (const direction of ["outbound", "inbound"] as const) {
    for (const crashPoint of ["before-commit", "after-commit"] as const) {
      it(`survives SIGKILL ${crashPoint} for ${direction}`, () => {
        const stateDirectory = temporaryState();
        const worker = join(process.cwd(), "test", "fixtures", "omemo-crash-worker.ts");
        const result = spawnSync(process.execPath, ["--experimental-transform-types", worker, stateDirectory, direction, crashPoint], {
          encoding: "utf8",
          timeout: 10_000
        });
        expect(result.signal).toBe("SIGKILL");

        const store = new OmemoTransactionalStore({ stateDirectory });
        store.integrityCheck();
        const committed = crashPoint === "after-commit";
        expect(store.listOutbound("account")).toHaveLength(direction === "outbound" && committed ? 1 : 0);
        expect(store.listInbound("account")).toHaveLength(direction === "inbound" && committed ? 1 : 0);
        store.close();
      });
    }
  }
});

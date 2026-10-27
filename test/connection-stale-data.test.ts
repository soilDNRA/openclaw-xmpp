import { describe, expect, it } from "vitest";
// Regression test for the stale-data parser crash:
// socket "data" arriving after parser detach must not throw
// "TypeError: Cannot read properties of null (reading 'write')".
// The fix ships in the plugin (src/dep-guards.ts prototype wrapper), so it
// survives dependency reinstalls by OpenClaw's managed installer.
import Connection from "@xmpp/connection";
import { installDependencyGuards } from "../src/dep-guards.js";

const Conn = Connection as unknown as new (domain: string) => any;

function makeConn(): any {
  installDependencyGuards();
  return new Conn("example.com");
}

describe("XMPP stale-data guard (src/dep-guards.ts)", () => {
  it("ignores socket data after parser detach instead of throwing", () => {
    const c = makeConn();
    c.parser = null;
    expect(() => c._onData(Buffer.from("<stale/>"))).not.toThrow();
  });

  it("still forwards data to a live parser", () => {
    const c = makeConn();
    const seen: string[] = [];
    c.parser = { write: (s: string) => seen.push(s) } as any;
    c._onData(Buffer.from("<live/>"));
    expect(seen).toEqual(["<live/>"]);
  });

  it("is idempotent and wraps the prototype exactly once", () => {
    installDependencyGuards();
    const c = makeConn();
    const seen: string[] = [];
    c.parser = { write: (s: string) => seen.push(s) } as any;
    c._onData(Buffer.from("<x/>"));
    expect(seen).toEqual(["<x/>"]);
    expect((Connection.prototype as any).__openclawStaleDataGuardInstalled).toBe(true);
  });
});

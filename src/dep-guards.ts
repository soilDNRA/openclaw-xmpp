// Upstream guards for @xmpp/* defects we cannot fix in-dependency.
// These run once at plugin load and survive dependency reinstalls.

// @xmpp/connection 0.14.0 (latest upstream at time of writing) does not guard
// Client._onData against socket "data" arriving after parser detach (stream
// error, stop, see-other-host teardown). The uncaught
// "TypeError: Cannot read properties of null (reading 'write')" can terminate
// the hosting process. Upstream is unguarded, so we
// wrap the prototype method: stale data on a torn-down stream is dropped;
// protocol errors and live-parser forwarding are unaffected.
import Connection from "@xmpp/connection";

const GUARD_FLAG = "__openclawStaleDataGuardInstalled";

export function installDependencyGuards(): void {
  const proto = Connection.prototype as unknown as Record<string, any> | undefined;
  if (!proto || typeof proto._onData !== "function" || proto[GUARD_FLAG]) return;
  const original = proto._onData;
  proto[GUARD_FLAG] = true;
  proto._onData = function patchedOnData(this: { parser?: unknown }, data: Buffer): void {
    if (this.parser === null || this.parser === undefined) return;
    return original.call(this, data);
  };
}

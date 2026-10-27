// Node's built-in type stripper executes this crash fixture directly. The
// production build continues to use NodeNext's emitted `.js` specifiers.
// @ts-expect-error TypeScript disallows source `.ts` imports without an emit-specific option.
const { OmemoTransactionalStore } = await import("../../src/omemo/store.ts");

const [stateDirectory, direction, crashPoint] = process.argv.slice(2);
if (!stateDirectory || !direction || !crashPoint) throw new Error("Missing crash-worker arguments.");

const store = new OmemoTransactionalStore({
  stateDirectory,
  clock: () => 777,
  faultInjector(point) {
    if (point === crashPoint) process.kill(process.pid, "SIGKILL");
  }
});

if (direction === "outbound") {
  await store.outbound("account", "outbound", "peer", async (view) => {
    view.set("session", "peer:1", Buffer.from("outbound-ratchet"));
    return Buffer.from("exact-outbound-ciphertext");
  });
} else if (direction === "inbound") {
  await store.inbound("account", "inbound", "peer", async (view) => {
    view.set("session", "peer:1", Buffer.from("inbound-ratchet"));
    return Buffer.from("pending-inbound-plaintext");
  });
} else {
  throw new Error(`Unknown direction: ${direction}`);
}

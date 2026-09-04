import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ clients: [] as any[], request: vi.fn() }));

vi.mock("@xmpp/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xmpp/client")>();
  return {
    ...actual,
    client: () => {
      const entity = new EventEmitter() as any;
      entity.status = "online";
      entity.isSecure = () => true;
      entity.send = vi.fn(async () => undefined);
      entity.start = vi.fn(async () => entity.emit("online", { toString: () => "bot@example.org/openclaw" }));
      entity.stop = vi.fn(async () => { entity.status = "offline"; entity.emit("offline"); });
      entity.iqCaller = { request: mock.request };
      entity.reconnect = Object.assign(new EventEmitter(), { delay: 1000 });
      entity.streamManagement = Object.assign(new EventEmitter(), { enabled: true });
      mock.clients.push(entity);
      return entity;
    }
  };
});

import type { XmppConnectionConfig } from "../src/config.js";
import { XmppTransport } from "../src/transport.js";

const config: XmppConnectionConfig = {
  accountId: "default", jid: "bot@example.org", domain: "example.org", username: "bot",
  password: "test-only", resource: "openclaw", service: "example.org", dmPolicy: "disabled",
  allowFrom: [], sendReceipts: true, requestReceipts: true, sendChatStates: true,
  mediaMaxBytes: 1024, healthProbe: true, healthProbeIntervalMs: 300_000,
  healthProbeTimeoutMs: 5_000, reconnectDelayMs: 2_000
};

function create() {
  const statuses: any[] = [];
  const transport = new XmppTransport(config, {
    onMessage: async () => undefined,
    onStatus: (status) => statuses.push(status),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  });
  return { transport, statuses, client: mock.clients.at(-1)! };
}

describe("XMPP health and recovery lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); mock.request.mockReset(); mock.clients.length = 0; });
  afterEach(() => vi.useRealTimers());

  it("correlates one bounded probe and records success", async () => {
    mock.request.mockResolvedValueOnce({});
    const { transport, client } = create();
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(transport.probe()).resolves.toBe("success");
    expect(mock.request).toHaveBeenCalledOnce();
    expect(transport.status.lastProbeSuccessAt).toBeTypeOf("number");
    expect(client.reconnect.delay).toBe(2_000);
    controller.abort();
    await running;
  });

  it("allows only one outstanding probe and records a timeout", async () => {
    mock.request.mockReturnValue(new Promise(() => undefined));
    const { transport } = create();
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const first = transport.probe();
    expect(await transport.probe()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(first).resolves.toBe("timeout");
    expect(mock.request).toHaveBeenCalledOnce();
    controller.abort();
    await running;
  });

  it("surfaces reconnect and XEP-0198 resume state and removes listeners on stop", async () => {
    const { transport, client } = create();
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    client.reconnect.emit("reconnecting");
    expect(transport.status).toMatchObject({ phase: "reconnecting", reconnectAttempts: 1 });
    client.streamManagement.emit("resumed");
    expect(transport.status).toMatchObject({ phase: "online", streamManagement: "resumed" });
    controller.abort();
    await running;
    expect(client.reconnect.listenerCount("reconnecting")).toBe(0);
    expect(client.streamManagement.listenerCount("resumed")).toBe(0);
    expect(transport.status.phase).toBe("stopped");
  });
});

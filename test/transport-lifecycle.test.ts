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

function create(omemoSession?: { initialize(io: unknown): Promise<void>; resume(io: unknown): Promise<void>; handleStanza(stanza: unknown): Promise<boolean>; sendText(to: string, text: string): Promise<string>; close(): void }) {
  const statuses: any[] = [];
  const transport = new XmppTransport(omemoSession ? { ...config, omemo: { enabled: true, profile: "legacy", trustMode: "manual" } } : config, {
    onMessage: async () => undefined,
    onStatus: (status) => statuses.push(status),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  }, omemoSession ? { omemoSession: omemoSession as never } : {});
  return { transport, statuses, client: mock.clients.at(-1)! };
}

describe("XMPP health and recovery lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); mock.request.mockReset(); mock.clients.length = 0; });
  afterEach(() => vi.useRealTimers());

  it("keeps delivery failure separate from successful ping and clears it only on successful send", async () => {
    const session = { initialize: vi.fn(async () => undefined), resume: vi.fn(async () => undefined),
      handleStanza: vi.fn(async () => false), close: vi.fn(),
      excludedDevices: [{ address: "alice@example.org.3", reason: "undecided" }],
      sendText: vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error("no trusted devices")).mockResolvedValue("ok") };
    const { transport, client } = create(session);
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(transport.sendText("alice@example.org", "secret")).rejects.toThrow("no trusted devices");
    expect(transport.status).toMatchObject({ connected: true, deliveryState: "blocked", pendingDeviceCount: 1, lastDeliveryError: "no trusted devices" });
    expect(client.send.mock.calls.some(([stanza]: any[]) => stanza.getChild("active"))).toBe(true);
    mock.request.mockResolvedValueOnce({});
    await transport.probe();
    expect(transport.status.deliveryState).toBe("blocked");
    expect(transport.status.lastDeliveryError).toBe("no trusted devices");
    await transport.sendText("alice@example.org", "new reply");
    expect(transport.status).toMatchObject({ deliveryState: "degraded", excludedDeviceCount: 1 });
    expect(transport.status.lastDeliveryError).toBeUndefined();
    session.excludedDevices = [];
    await transport.sendText("alice@example.org", "fully recovered");
    expect(transport.status.deliveryState).toBe("healthy");
    controller.abort(); await running;
  });

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

  it("initializes explicitly injected OMEMO PEP before presence and consumes its events", async () => {
    const order: string[] = [];
    const session = {
      initialize: vi.fn(async () => { order.push("omemo"); }),
      resume: vi.fn(async () => { order.push("recover"); }),
      handleStanza: vi.fn(async () => true),
      sendText: vi.fn(async () => "encrypted"),
      close: vi.fn()
    };
    const { transport, client } = create(session);
    client.send.mockImplementation(async () => { order.push("presence"); });
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["omemo", "presence"]);
    client.emit("online", { toString: () => "bot@example.org/openclaw" });
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["omemo", "presence", "omemo", "presence"]);
    expect(transport.status.phase).toBe("online");
    client.reconnect.emit("reconnecting");
    client.streamManagement.emit("resumed");
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["omemo", "presence", "omemo", "presence", "recover"]);
    expect(transport.status).toMatchObject({ connected: true, phase: "online", streamManagement: "resumed" });
    client.emit("stanza", (await import("@xmpp/client")).xml("message", { type: "headline" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(session.handleStanza).toHaveBeenCalledOnce();
    controller.abort();
    await running;
  });

  it("routes text through the assembled OMEMO session and rejects switch/session mismatches", async () => {
    const session = {
      initialize: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      handleStanza: vi.fn(async () => false),
      sendText: vi.fn(async () => "encrypted-id"),
      close: vi.fn()
    };
    const { transport } = create(session);
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(transport.sendText("alice@example.org", "secret")).resolves.toEqual({
      id: "encrypted-id", to: "alice@example.org"
    });
    expect(session.sendText).toHaveBeenCalledWith("alice@example.org", "secret");
    controller.abort();
    await running;

    expect(() => new XmppTransport({ ...config, omemo: { enabled: true, profile: "legacy", trustMode: "manual" } }, {
      onMessage: async () => undefined, onStatus: () => undefined,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })).toThrow("no assembled OMEMO session");
  });

  it("constructs the production session from the client's IQ caller and closes it on stop", async () => {
    const session = {
      initialize: vi.fn(async () => undefined),
      resume: vi.fn(async () => undefined),
      handleStanza: vi.fn(async () => false),
      sendText: vi.fn(async () => "encrypted-id"),
      close: vi.fn()
    };
    const factory = vi.fn(() => session as never);
    const transport = new XmppTransport({
      ...config, omemo: { enabled: true, profile: "legacy", trustMode: "manual" }
    }, {
      onMessage: async () => undefined, onStatus: () => undefined,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    }, { omemoSessionFactory: factory });
    expect(factory).toHaveBeenCalledWith(mock.clients.at(-1)!.iqCaller);
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await running;
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("fails closed before presence when explicit OMEMO PEP initialization fails", async () => {
    const session = {
      initialize: vi.fn(async () => { throw new Error("denied"); }),
      resume: vi.fn(async () => undefined),
      handleStanza: vi.fn(async () => false),
      sendText: vi.fn(async () => "encrypted"),
      close: vi.fn()
    };
    const { transport, client } = create(session);
    const controller = new AbortController();
    const running = transport.run(controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.send).not.toHaveBeenCalled();
    expect(transport.status).toMatchObject({ connected: false, phase: "failed" });
    expect(transport.status.lastError).toContain("OMEMO initialization failed");
    controller.abort();
    await running;
  });
});

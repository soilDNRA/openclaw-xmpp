import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const xmppMock = vi.hoisted(() => ({
  secure: true,
  clients: [] as Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    authenticate: ReturnType<typeof vi.fn>;
  }>
}));

vi.mock("@xmpp/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@xmpp/client")>();

  return {
    ...actual,
    client: (options: {
      credentials: (
        authenticate: ReturnType<typeof vi.fn>,
        mechanisms: string[],
        fast: null,
        entity: { isSecure(): boolean }
      ) => Promise<void>;
    }) => {
      const events = new EventEmitter();
      const authenticate = vi.fn(async () => undefined);
      const fake = Object.assign(events, {
        isSecure: () => xmppMock.secure,
        authenticate,
        send: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        start: vi.fn(async () => {
          await options.credentials(
            authenticate,
            ["SCRAM-SHA-1", "PLAIN"],
            null,
            { isSecure: () => xmppMock.secure }
          );
          events.emit("online", { toString: () => "bot@example.org/openclaw" });
        })
      });
      xmppMock.clients.push(fake);
      return fake;
    }
  };
});

import { xmppPlugin } from "../src/channel.js";
import { resolveXmppAccount } from "../src/config.js";
import { setXmppPluginRuntime } from "../src/inbound.js";

function gatewayContext(cfg: OpenClawConfig, abortSignal: AbortSignal) {
  return {
    cfg,
    accountId: "default",
    account: resolveXmppAccount(cfg, "default"),
    abortSignal,
    channelRuntime: {},
    setStatus: vi.fn(),
    runtime: { log: vi.fn(), error: vi.fn() },
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }
  };
}

describe("Gateway security gates", () => {
  beforeEach(() => {
    setXmppPluginRuntime({} as never);
  });

  afterEach(() => {
    xmppMock.clients.length = 0;
    xmppMock.secure = true;
    vi.unstubAllEnvs();
  });

  it("refuses Gateway startup before sending credentials when TLS is unavailable", async () => {
    xmppMock.secure = false;
    const cfg = {
      channels: { xmpp: { jid: "bot@example.org", password: "test-only-secret" } }
    } as unknown as OpenClawConfig;
    const controller = new AbortController();
    const startAccount = xmppPlugin.gateway?.startAccount;

    await expect(
      startAccount?.(gatewayContext(cfg, controller.signal) as never)
    ).rejects.toThrow(/TLS is required before authentication/);

    const client = xmppMock.clients[0];
    expect(client).toBeDefined();
    expect(client?.authenticate).not.toHaveBeenCalled();
    expect(client?.send).not.toHaveBeenCalled();
    expect(client?.stop).toHaveBeenCalledOnce();
  });

  it("starts a complete Gateway account using an env SecretRef", async () => {
    vi.stubEnv("XMPP_GATEWAY_TEST_PASSWORD", "resolved-test-only-secret");
    const cfg = {
      channels: {
        xmpp: {
          jid: "bot@example.org",
          password: {
            source: "env",
            provider: "default",
            id: "XMPP_GATEWAY_TEST_PASSWORD"
          }
        }
      }
    } as unknown as OpenClawConfig;
    const controller = new AbortController();
    const ctx = gatewayContext(cfg, controller.signal);
    const startAccount = xmppPlugin.gateway?.startAccount;

    expect(typeof cfg.channels?.xmpp?.password).toBe("object");
    const running = startAccount?.(ctx as never);
    await vi.waitFor(() => {
      expect(xmppMock.clients[0]?.authenticate).toHaveBeenCalledWith(
        {
          username: "bot",
          password: "resolved-test-only-secret"
        },
        "SCRAM-SHA-1",
        expect.anything()
      );
    });
    await vi.waitFor(() => {
      expect(ctx.setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "default",
          running: true,
          connected: true
        })
      );
    });

    controller.abort();
    await running;
    expect(xmppMock.clients[0]?.stop).toHaveBeenCalledOnce();
  });
});

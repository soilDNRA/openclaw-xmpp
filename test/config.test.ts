import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  resolveXmppConnectionConfig
} from "../src/config.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("XMPP account configuration", () => {
  it("resolves a safe single account without exposing the password in snapshots", async () => {
    const cfg = {
      channels: {
        xmpp: {
          jid: "Bot@Example.ORG",
          password: "secret",
          dmPolicy: "allowlist",
          allowFrom: ["Alice@Example.ORG/phone"]
        }
      }
    } as unknown as OpenClawConfig;
    const account = resolveXmppAccount(cfg);
    expect(account).toMatchObject({
      accountId: "default",
      jid: "bot@example.org",
      configured: true,
      dmPolicy: "allowlist",
      allowFrom: ["alice@example.org"]
    });
    const connection = await resolveXmppConnectionConfig(cfg);
    expect(connection).toMatchObject({
      domain: "example.org",
      username: "bot",
      password: "secret",
      service: "example.org"
    });
  });

  it("supports named accounts and a configured default", () => {
    const cfg = {
      channels: {
        xmpp: {
          defaultAccount: "work",
          accounts: {
            personal: { jid: "me@example.org", password: "one" },
            work: { jid: "me@example.net", password: "two" }
          }
        }
      }
    } as unknown as OpenClawConfig;
    expect(listXmppAccountIds(cfg)).toEqual(["personal", "work"]);
    expect(resolveDefaultXmppAccountId(cfg)).toBe("work");
    expect(resolveXmppAccount(cfg).jid).toBe("me@example.net");
  });

  it("accepts environment setup and rejects insecure WebSockets", async () => {
    process.env.XMPP_JID = "bot@example.org";
    process.env.XMPP_PASSWORD = "secret";
    const envCfg = {} as OpenClawConfig;
    expect(resolveXmppAccount(envCfg).configured).toBe(true);

    const badCfg = {
      channels: {
        xmpp: {
          jid: "bot@example.org",
          password: "secret",
          websocketUrl: "ws://example.org/xmpp"
        }
      }
    } as unknown as OpenClawConfig;
    await expect(resolveXmppConnectionConfig(badCfg)).rejects.toThrow(
      /must use wss/
    );
  });

  it("requires dmPolicy open for a wildcard allowlist", async () => {
    const cfg = {
      channels: {
        xmpp: {
          jid: "bot@example.org",
          password: "secret",
          dmPolicy: "allowlist",
          allowFrom: ["*"]
        }
      }
    } as unknown as OpenClawConfig;
    await expect(resolveXmppConnectionConfig(cfg)).rejects.toThrow(
      /dmPolicy is not "open"/
    );
  });

  it("applies conservative bounded probe and reconnect defaults", async () => {
    const cfg = {
      channels: {
        xmpp: {
          jid: "bot@example.org",
          password: "secret",
          healthProbeIntervalSeconds: 1,
          healthProbeTimeoutSeconds: 999,
          reconnectDelaySeconds: 0
        }
      }
    } as unknown as OpenClawConfig;
    expect(resolveXmppAccount(cfg)).toMatchObject({
      healthProbe: true,
      healthProbeIntervalSeconds: 30,
      healthProbeTimeoutSeconds: 60,
      reconnectDelaySeconds: 1
    });
    expect(await resolveXmppConnectionConfig(cfg)).toMatchObject({
      healthProbe: true,
      healthProbeIntervalMs: 30_000,
      healthProbeTimeoutMs: 60_000,
      reconnectDelayMs: 1_000
    });
  });
});

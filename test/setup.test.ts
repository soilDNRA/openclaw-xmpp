import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

import { applyXmppSetupAccount, configureXmppInteractive } from "../src/setup.js";

function prompter(values: {
  texts: string[];
  policy?: "pairing" | "allowlist" | "disabled";
  healthProbe?: boolean;
}) {
  const texts = [...values.texts];
  return {
    note: vi.fn(async () => undefined),
    text: vi.fn(async () => texts.shift() ?? ""),
    select: vi.fn(async () => values.policy ?? "pairing"),
    confirm: vi.fn(async () => values.healthProbe ?? true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    intro: vi.fn(async () => undefined),
    outro: vi.fn(async () => undefined),
    plain: vi.fn(async () => undefined),
    multiselect: vi.fn(async () => [])
  };
}

describe("secure XMPP onboarding", () => {
  it("adds named accounts without replacing an existing account", () => {
    const first = applyXmppSetupAccount({
      cfg: {} as OpenClawConfig,
      accountId: "personal",
      account: { jid: "me@example.org", password: { source: "env", provider: "default", id: "XMPP_PERSONAL_PASSWORD" } }
    });
    const second = applyXmppSetupAccount({
      cfg: first,
      accountId: "work",
      account: { jid: "me@example.net", password: { source: "env", provider: "default", id: "XMPP_WORK_PASSWORD" } }
    }) as never as { channels: { xmpp: { accounts: Record<string, unknown> } } };
    expect(Object.keys(second.channels.xmpp.accounts)).toEqual(["personal", "work"]);
  });

  it("records only a SecretRef, normalizes allowlists, and validates before returning", async () => {
    const prompts = prompter({
      texts: [
        "work",
        "Bot@Example.ORG/device",
        "openclaw",
        "wss://xmpp.example.org/ws",
        "XMPP_WORK_PASSWORD",
        "Alice@Example.ORG/phone, bob@example.org"
      ],
      policy: "allowlist"
    });
    const validate = vi.fn(async () => undefined);
    const result = await configureXmppInteractive(
      { cfg: {} as OpenClawConfig, prompter: prompts as never, shouldPromptAccountIds: true },
      validate
    );
    const account = (result.cfg as never as { channels: { xmpp: { accounts: Record<string, Record<string, unknown>> } } }).channels.xmpp.accounts.work;
    expect(account).toMatchObject({
      jid: "bot@example.org",
      websocketUrl: "wss://xmpp.example.org/ws",
      dmPolicy: "allowlist",
      allowFrom: ["alice@example.org", "bob@example.org"],
      password: { source: "env", provider: "default", id: "XMPP_WORK_PASSWORD" }
    });
    expect(JSON.stringify(result.cfg)).not.toContain("secret");
    expect(validate).toHaveBeenCalledOnce();
  });

  it("returns no configuration when connection validation fails", async () => {
    const prompts = prompter({
      texts: ["bot@example.org", "openclaw", "", "XMPP_PASSWORD"],
      policy: "disabled",
      healthProbe: false
    });
    await expect(configureXmppInteractive(
      { cfg: {} as OpenClawConfig, prompter: prompts as never, shouldPromptAccountIds: false },
      async () => { throw new Error("TLS certificate rejected"); }
    )).rejects.toThrow(/TLS certificate rejected/);
  });
});

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ChannelSetupWizardAdapter,
  WizardPrompter
} from "openclaw/plugin-sdk/setup";

import {
  listXmppAccountIds,
  resolveXmppAccount,
  resolveXmppConnectionConfig,
  type XmppAccountConfig,
  type XmppDmPolicy
} from "./config.js";
import { normalizeBareJid } from "./jid.js";
import { XmppTransport } from "./transport.js";

type XmppConfig = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    xmpp?: XmppAccountConfig & {
      defaultAccount?: string;
      accounts?: Record<string, XmppAccountConfig>;
    };
  };
};

function normalizeAccountId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)
    ? normalized
    : undefined;
}

export function applyXmppSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: XmppAccountConfig;
}): OpenClawConfig {
  const next = structuredClone(params.cfg) as XmppConfig;
  next.channels ??= {};
  const channel = (next.channels.xmpp ??= {});
  channel.accounts ??= {};
  channel.accounts[params.accountId] = params.account;
  channel.defaultAccount ??= params.accountId;
  return next;
}

export async function validateXmppSetupConnection(
  cfg: OpenClawConfig,
  accountId: string
): Promise<void> {
  const connection = await resolveXmppConnectionConfig(cfg, accountId);
  const controller = new AbortController();
  let resolveOnline!: () => void;
  let rejectOnline!: (error: Error) => void;
  const online = new Promise<void>((resolve, reject) => {
    resolveOnline = resolve;
    rejectOnline = reject;
  });
  const transport = new XmppTransport(connection, {
    onMessage: async () => undefined,
    onStatus: (status) => {
      if (status.connected) resolveOnline();
      if (status.phase === "failed" && status.lastError) {
        rejectOnline(new Error(status.lastError));
      }
    },
    log: { info: () => undefined, warn: () => undefined, error: () => undefined }
  });
  const running = transport.run(controller.signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      online,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("XMPP connection validation timed out.")), 20_000);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    await running.catch(() => undefined);
  }
}

async function promptAccountId(
  prompter: WizardPrompter,
  cfg: OpenClawConfig,
  shouldPrompt: boolean
): Promise<string> {
  if (!shouldPrompt) return "default";
  const existing = listXmppAccountIds(cfg).filter(
    (id) => resolveXmppAccount(cfg, id).configured
  );
  return await prompter.text({
    message: existing.length
      ? `Account id (existing: ${existing.join(", ")})`
      : "Account id",
    initialValue: existing[0] ?? "default",
    validate: (value) => normalizeAccountId(value) ? undefined : "Use letters, numbers, _ or -, beginning with a letter or number."
  }).then((value) => normalizeAccountId(value) ?? "default");
}

export async function configureXmppInteractive(
  params: {
    cfg: OpenClawConfig;
    prompter: WizardPrompter;
    shouldPromptAccountIds: boolean;
  },
  validateConnection: (cfg: OpenClawConfig, accountId: string) => Promise<void> = validateXmppSetupConnection
): Promise<{ cfg: OpenClawConfig; accountId: string; completion: "configured" }> {
  const { prompter } = params;
  const accountId = await promptAccountId(prompter, params.cfg, params.shouldPromptAccountIds);
  const current = resolveXmppAccount(params.cfg, accountId);
  await prompter.note(
    "XMPP setup requires verified TLS. Passwords are referenced from an environment SecretRef and are never written into configuration. Group-chat options remain unavailable until the MUC security gate is complete.",
    "Secure XMPP setup"
  );
  const jid = await prompter.text({
    message: "Bot JID",
    ...(current.jid ? { initialValue: current.jid } : {}),
    placeholder: "bot@example.org",
    validate: (value) => normalizeBareJid(value) ? undefined : "Enter a valid bare XMPP JID."
  }).then((value) => normalizeBareJid(value)!);
  const resource = await prompter.text({
    message: "Resource",
    initialValue: current.resource || "openclaw",
    validate: (value) => value.trim() ? undefined : "Resource is required."
  });
  const endpoint = await prompter.text({
    message: "Secure service endpoint (leave blank for domain/SRV discovery)",
    initialValue: current.websocketUrl ?? current.service ?? "",
    placeholder: "wss://xmpp.example.org/xmpp-websocket",
    validate: (value) => {
      if (!value.trim()) return undefined;
      try {
        const url = new URL(value);
        return ["xmpp:", "xmpps:", "wss:"].includes(url.protocol)
          ? undefined
          : "Use xmpp:, xmpps:, or wss:. Insecure ws: is refused.";
      } catch {
        return "Enter a complete secure endpoint URL or leave blank.";
      }
    }
  });
  if (endpoint.trim()) {
    await prompter.note(
      "The TLS certificate must be valid for the explicit endpoint hostname; changing the host does not disable certificate-name verification.",
      "Certificate verification"
    );
  }
  const secretEnv = await prompter.text({
    message: "Environment variable containing the XMPP password",
    placeholder: accountId === "default" ? "XMPP_PASSWORD" : `XMPP_${accountId.toUpperCase()}_PASSWORD`,
    validate: (value) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.trim())
      ? undefined
      : "Enter a valid environment variable name."
  });
  const dmPolicy = await prompter.select<XmppDmPolicy>({
    message: "Direct-message access policy",
    options: [
      { value: "pairing", label: "Pairing", hint: "Approve new contacts explicitly" },
      { value: "allowlist", label: "Allowlist", hint: "Only listed bare JIDs" },
      { value: "disabled", label: "Disabled", hint: "Reject direct messages" }
    ],
    initialValue: current.dmPolicy === "open" ? "pairing" : current.dmPolicy
  });
  let allowFrom: string[] = [];
  if (dmPolicy === "allowlist") {
    const raw = await prompter.text({
      message: "Allowed bare JIDs (comma-separated)",
      initialValue: current.allowFrom.join(", "),
      validate: (value) => value.split(",").every((item) => normalizeBareJid(item))
        ? undefined
        : "Every entry must be a valid bare XMPP JID."
    });
    allowFrom = [...new Set(raw.split(",").map((item) => normalizeBareJid(item)).filter((item): item is string => Boolean(item)))];
  }
  const healthProbe = await prompter.confirm({
    message: "Enable conservative XEP-0199 health probes?",
    initialValue: current.healthProbe
  });
  await prompter.note(
    `Account: ${accountId}\nJID: ${jid}\nEndpoint: ${endpoint.trim() || "domain/SRV discovery"}\nDM policy: ${dmPolicy}${allowFrom.length ? ` (${allowFrom.join(", ")})` : ""}\nHealth probe: ${healthProbe ? "enabled" : "disabled"}`,
    "Effective XMPP configuration"
  );
  const account: XmppAccountConfig = {
    enabled: true,
    jid,
    resource: resource.trim(),
    password: { source: "env", provider: "default", id: secretEnv.trim() },
    dmPolicy,
    allowFrom,
    healthProbe,
    ...(endpoint.trim().startsWith("wss:")
      ? { websocketUrl: endpoint.trim() }
      : endpoint.trim()
        ? { service: endpoint.trim() }
        : {})
  };
  const next = applyXmppSetupAccount({ cfg: params.cfg, accountId, account });
  const progress = prompter.progress("Validating TLS, authentication, and resource binding");
  try {
    await validateConnection(next, accountId);
    progress.stop("XMPP connection validated securely.");
  } catch (error) {
    progress.stop("XMPP validation failed; no configuration was saved.");
    throw new Error(`XMPP setup validation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { cfg: next, accountId, completion: "configured" };
}

export const xmppSetupWizard: ChannelSetupWizardAdapter = {
  channel: "xmpp",
  getStatus: async ({ cfg }) => {
    const configured = listXmppAccountIds(cfg).some((id) => resolveXmppAccount(cfg, id).configured);
    return {
      channel: "xmpp",
      configured,
      statusLines: [configured ? "XMPP is configured." : "XMPP is not configured."],
      selectionHint: "Secure federated direct messaging"
    };
  },
  configure: async (ctx) => await configureXmppInteractive(ctx),
  configureInteractive: async (ctx) => await configureXmppInteractive(ctx),
  disable: (cfg) => {
    const next = structuredClone(cfg) as XmppConfig;
    if (next.channels?.xmpp) next.channels.xmpp.enabled = false;
    return next;
  }
};

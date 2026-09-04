import {
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter
} from "openclaw/plugin-sdk/channel-outbound";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";

import {
  listXmppAccountIds,
  resolveDefaultXmppAccountId,
  resolveXmppAccount,
  resolveXmppConnectionConfig,
  setXmppAccountEnabled,
  type ResolvedXmppAccount
} from "./config.js";
import { DEFAULT_TEXT_CHUNK_LIMIT } from "./constants.js";
import {
  getXmppPluginRuntime,
  handleInboundXmppMessage,
} from "./inbound.js";
import { normalizeBareJid, normalizeXmppTarget } from "./jid.js";
import {
  getLiveTransport,
  registerLiveTransport,
  XmppTransport,
  type XmppTransportStatus
} from "./transport.js";
import { xmppSetupWizard } from "./setup.js";

function resolveAccountId(cfg: OpenClawConfig, accountId?: string | null): string {
  return accountId ?? resolveDefaultXmppAccountId(cfg);
}

function requireTransport(
  cfg: OpenClawConfig,
  accountId?: string | null
): XmppTransport {
  const resolvedId = resolveAccountId(cfg, accountId);
  const transport = getLiveTransport(resolvedId);
  if (!transport) {
    throw new Error(`XMPP account "${resolvedId}" is not connected.`);
  }
  return transport;
}

function normalizeTargetOrThrow(value: string): string {
  const target = normalizeXmppTarget(value);
  if (!target) {
    throw new Error("Expected an XMPP target such as user@example.org.");
  }
  return target;
}

async function sendText(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  accountId?: string | null;
}): Promise<{ channel: "xmpp"; messageId: string; toJid: string }> {
  const to = normalizeTargetOrThrow(params.to);
  const sent = await requireTransport(params.cfg, params.accountId).sendText(
    to,
    params.text
  );
  return { channel: "xmpp", messageId: sent.id, toJid: to };
}

async function sendMedia(params: {
  cfg: OpenClawConfig;
  to: string;
  text: string;
  mediaUrl: string;
  accountId?: string | null;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  signal?: AbortSignal;
}): Promise<{ channel: "xmpp"; messageId: string; toJid: string }> {
  const to = normalizeTargetOrThrow(params.to);
  const sent = await requireTransport(params.cfg, params.accountId).sendMedia({
    to,
    text: params.text,
    mediaUrl: params.mediaUrl,
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    ...(params.signal ? { signal: params.signal } : {})
  });
  return { channel: "xmpp", messageId: sent.id, toJid: to };
}

const xmppMessageAdapter = defineChannelMessageAdapter({
  id: "xmpp",
  durableFinal: {
    capabilities: {
      text: true,
      media: true
    }
  },
  receive: {
    defaultAckPolicy: "after_agent_dispatch",
    supportedAckPolicies: ["after_agent_dispatch"]
  },
  send: {
    text: async (ctx) => {
      const result = await sendText({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {})
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [result],
          kind: "text",
          ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {})
        })
      };
    },
    media: async (ctx) => {
      const result = await sendMedia({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
        ...(ctx.mediaAccess?.readFile
          ? { mediaReadFile: ctx.mediaAccess.readFile }
          : ctx.mediaReadFile
            ? { mediaReadFile: ctx.mediaReadFile }
            : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {})
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [result],
          kind: "media",
          ...(ctx.replyToId ? { replyToId: ctx.replyToId } : {})
        })
      };
    }
  }
});

const outbound = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  textChunkLimit: DEFAULT_TEXT_CHUNK_LIMIT,
  chunkerMode: "text" as const,
  resolveTarget: ({ to }: { to?: string }) => {
    const normalized = to ? normalizeXmppTarget(to) : undefined;
    return normalized
      ? { ok: true as const, to: normalized }
      : {
          ok: false as const,
          error: new Error("Expected an XMPP target such as user@example.org.")
        };
  },
  sendText: async (ctx: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
  }) => await sendText(ctx),
  sendMedia: async (ctx: {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    mediaUrl?: string;
    accountId?: string | null;
    mediaAccess?: { readFile?: (filePath: string) => Promise<Buffer> };
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
  }) => {
    if (!ctx.mediaUrl) {
      throw new Error("XMPP media send requires mediaUrl.");
    }
    return await sendMedia({
      cfg: ctx.cfg,
      to: ctx.to,
      text: ctx.text,
      mediaUrl: ctx.mediaUrl,
      ...(ctx.accountId !== undefined ? { accountId: ctx.accountId } : {}),
      ...(ctx.mediaAccess?.readFile
        ? { mediaReadFile: ctx.mediaAccess.readFile }
        : ctx.mediaReadFile
          ? { mediaReadFile: ctx.mediaReadFile }
          : {})
    });
  }
};

const xmppMessageActions = {
  describeMessageTool: ({ cfg, accountId }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    const account = resolveXmppAccount(cfg, accountId);
    return account.enabled && account.configured
      ? { actions: ["send" as const], capabilities: [] }
      : { actions: [], capabilities: [] };
  },
  supportsAction: ({ action }: { action: string }) => action === "send",
  extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
    extractToolSend(args, "send")
};

function statusSnapshot(
  account: ResolvedXmppAccount,
  status?: XmppTransportStatus
) {
  return {
    accountId: account.accountId,
    ...(account.name ? { name: account.name } : {}),
    enabled: account.enabled,
    configured: account.configured,
    running: Boolean(status),
    connected: status?.connected ?? false,
    ...(status?.boundJid ? { bot: { jid: status.boundJid } } : {}),
    ...(status?.lastConnectedAt
      ? { lastConnectedAt: status.lastConnectedAt }
      : {}),
    ...(status?.lastDisconnectedAt
      ? { lastDisconnect: { at: status.lastDisconnectedAt } }
      : {}),
    ...(status?.lastInboundAt ? { lastInboundAt: status.lastInboundAt } : {}),
    ...(status?.lastOutboundAt
      ? { lastOutboundAt: status.lastOutboundAt }
      : {}),
    ...(status?.lastError ? { lastError: status.lastError } : {}),
    ...(status?.phase ? { phase: status.phase } : {}),
    ...(status?.reconnectAttempts !== undefined
      ? { reconnectAttempts: status.reconnectAttempts }
      : {}),
    ...(status?.lastReconnectedAt
      ? { lastReconnectedAt: status.lastReconnectedAt }
      : {}),
    ...(status?.streamManagement
      ? { streamManagement: status.streamManagement }
      : {}),
    ...(status?.lastProbeAt ? { lastProbeAt: status.lastProbeAt } : {}),
    ...(status?.lastProbeSuccessAt
      ? { lastProbeSuccessAt: status.lastProbeSuccessAt }
      : {}),
    ...(status?.lastProbeLatencyMs !== undefined
      ? { lastProbeLatencyMs: status.lastProbeLatencyMs }
      : {}),
    ...(status?.probeFailures !== undefined
      ? { probeFailures: status.probeFailures }
      : {}),
    ...(status?.lastProbeResult
      ? { lastProbeResult: status.lastProbeResult }
      : {}),
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom
  };
}

const basePlugin: Omit<
  ChannelPlugin<ResolvedXmppAccount>,
  "security" | "pairing" | "outbound"
> = {
  id: "xmpp",
  meta: {
    id: "xmpp",
    label: "XMPP",
    selectionLabel: "XMPP (plugin)",
    docsPath: "/channels/xmpp",
    docsLabel: "xmpp",
    blurb: "Open-standard federated direct messaging.",
    order: 75,
    markdownCapable: false,
    quickstartAllowFrom: true
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true
  },
  reload: {
    configPrefixes: ["channels.xmpp"]
  },
  config: {
    listAccountIds: listXmppAccountIds,
    resolveAccount: resolveXmppAccount,
    defaultAccountId: resolveDefaultXmppAccountId,
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setXmppAccountEnabled(cfg, accountId, enabled),
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    disabledReason: () => "XMPP account is disabled.",
    unconfiguredReason: () => "XMPP JID or password is not configured.",
    describeAccount: (account) => statusSnapshot(account),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveXmppAccount(cfg, accountId).allowFrom,
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeBareJid(String(entry)))
        .filter((entry): entry is string => Boolean(entry)),
    hasConfiguredState: ({ cfg }) =>
      listXmppAccountIds(cfg).some(
        (accountId) => resolveXmppAccount(cfg, accountId).configured
      )
  },
  setupWizard: xmppSetupWizard,
  messaging: {
    defaultMarkdownTableMode: "bullets",
    targetPrefixes: ["xmpp"],
    normalizeTarget: normalizeXmppTarget,
    targetResolver: {
      looksLikeId: (raw) => Boolean(normalizeXmppTarget(raw)),
      hint: "<user@example.org>"
    }
  },
  message: xmppMessageAdapter,
  actions: xmppMessageActions,
  status: {
    defaultRuntime: {
      accountId: "default",
      running: false,
      connected: false
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      ...statusSnapshot(
        account,
        runtime
          ? ({
              ...runtime,
              connected: runtime.connected ?? false,
              phase: (runtime as { phase?: XmppTransportStatus["phase"] }).phase
                ?? (runtime.connected ? "online" : "stopped")
            } as XmppTransportStatus)
          : undefined
      )
    })
  },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.channelRuntime) {
        throw new Error("OpenClaw channel runtime is unavailable.");
      }
      const connection = await resolveXmppConnectionConfig(
        ctx.cfg,
        ctx.accountId
      );
      const pluginRuntime = getXmppPluginRuntime();
      let transport!: XmppTransport;
      transport = new XmppTransport(connection, {
        log: ctx.log ?? {
          info: ctx.runtime.log,
          warn: ctx.runtime.log,
          error: ctx.runtime.error
        },
        onStatus: (next) => {
          ctx.setStatus(statusSnapshot(ctx.account, next));
        },
        onMessage: async (message) => {
          await handleInboundXmppMessage({
            cfg: ctx.cfg,
            account: connection,
            transport,
            runtime: pluginRuntime,
            message,
            log: ctx.log ?? {
              info: ctx.runtime.log,
              warn: ctx.runtime.log,
              error: ctx.runtime.error
            }
          });
        }
      });
      const unregister = registerLiveTransport(ctx.accountId, transport);
      ctx.setStatus(statusSnapshot(ctx.account, transport.status));
      try {
        await transport.run(ctx.abortSignal);
      } finally {
        unregister();
      }
    },
    stopAccount: async (ctx) => {
      await getLiveTransport(ctx.accountId)?.stop();
    }
  },
  heartbeat: {
    checkReady: async ({ cfg, accountId }) => {
      const resolvedId = resolveAccountId(cfg, accountId);
      const transport = getLiveTransport(resolvedId);
      if (!transport?.status.connected) {
        return { ok: false, reason: "not connected" };
      }
      if (!transport.config.healthProbe) {
        return { ok: true, reason: "connected; health probe disabled" };
      }
      const result = await transport.probe();
      return result === undefined || result === "success" || result === "unsupported"
        ? { ok: true, reason: result === "success" ? "probe succeeded" : result === "unsupported" ? "connected; server does not support XEP-0199" : "connected; health probe in progress" }
        : { ok: false, reason: `health probe ${result ?? "already running"}` };
    },
    sendTyping: async ({ cfg, to, accountId }) => {
      await requireTransport(cfg, accountId).sendChatState(
        normalizeTargetOrThrow(to),
        "composing"
      );
    },
    clearTyping: async ({ cfg, to, accountId }) => {
      await requireTransport(cfg, accountId).sendChatState(
        normalizeTargetOrThrow(to),
        "active"
      );
    }
  },
  doctor: {
    dmAllowFromMode: "topOrNested",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: false,
    warnOnEmptyGroupSenderAllowlist: false
  }
};

export const xmppPlugin = createChatChannelPlugin({
  base: basePlugin,
  security: {
    dm: {
      channelKey: "xmpp",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      defaultPolicy: "pairing",
      normalizeEntry: (raw) => normalizeBareJid(raw) ?? raw.trim()
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (account.dmPolicy === "open") {
        warnings.push(
          `XMPP account "${account.accountId}" accepts direct messages from anyone.`
        );
      }
      if (!account.enabled || !account.configured) {
        return warnings;
      }
      if (account.service?.startsWith("ws:")) {
        warnings.push("Insecure XMPP WebSocket URLs are not supported.");
      }
      return warnings;
    }
  },
  pairing: {
    text: {
      idLabel: "XMPP JID",
      message: "Your XMPP account has been approved for OpenClaw.",
      normalizeAllowEntry: (raw) => normalizeBareJid(raw) ?? raw.trim(),
      notify: async ({ cfg, id, accountId, message }) => {
        await requireTransport(cfg, accountId).sendText(
          normalizeTargetOrThrow(id),
          message
        );
      }
    }
  },
  outbound
});

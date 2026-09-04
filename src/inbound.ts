import { readLocalFileFromRoots } from "@openclaw/fs-safe/advanced";
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  dispatchInboundDirectDmWithRuntime
} from "openclaw/plugin-sdk/channel-inbound";
import {
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit
} from "openclaw/plugin-sdk/reply-chunking";
import {
  createChannelIngressResolver,
  defineStableChannelIngressIdentity
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  getAgentScopedMediaLocalRootsForSources
} from "openclaw/plugin-sdk/media-local-roots";

import type { XmppConnectionConfig, XmppDmConfig, XmppThreadBindingsConfig } from "./config.js";
import { CHANNEL_ID, DEFAULT_TEXT_CHUNK_LIMIT } from "./constants.js";
import { normalizeBareJid } from "./jid.js";
import type { InboundXmppMessage } from "./stanzas.js";
import type { XmppTransport } from "./transport.js";

export type XmppInboundRuntime = PluginRuntime;

let xmppPluginRuntime: PluginRuntime | undefined;

export function setXmppPluginRuntime(runtime: PluginRuntime): void {
  xmppPluginRuntime = runtime;
}

export function getXmppPluginRuntime(): PluginRuntime {
  if (!xmppPluginRuntime) {
    throw new Error("OpenClaw plugin runtime is unavailable for XMPP.");
  }
  return xmppPluginRuntime;
}

export function chunkXmppReplyText(params: {
  cfg: OpenClawConfig;
  accountId: string;
  text: string;
}): string[] {
  const limit = resolveTextChunkLimit(
    params.cfg,
    CHANNEL_ID,
    params.accountId,
    { fallbackLimit: DEFAULT_TEXT_CHUNK_LIMIT }
  );
  const mode = resolveChunkMode(params.cfg, CHANNEL_ID, params.accountId);
  return chunkTextWithMode(params.text, limit, mode);
}

const MARKDOWN_MEDIA_LINE_WRAPPERS = [
  ["**", "**"],
  ["__", "__"],
  ["~~", "~~"],
  ["`", "`"],
  ["*", "*"],
  ["_", "_"]
] as const;

function markdownFenceMarker(line: string):
  | { marker: "`" | "~"; length: number }
  | undefined {
  const stripped = line.trimStart();
  if (!stripped.startsWith("`") && !stripped.startsWith("~")) {
    return undefined;
  }
  const marker = stripped[0] as "`" | "~";
  let length = 0;
  while (stripped[length] === marker) {
    length += 1;
  }
  return length >= 3 ? { marker, length } : undefined;
}

function unwrapMatchingQuote(value: string): string {
  const trimmed = value.trim();
  const first = trimmed[0];
  if (
    trimmed.length >= 2 &&
    first === trimmed.at(-1) &&
    (first === "`" || first === "\"" || first === "'")
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function unwrapMarkdownMediaDirectiveLine(line: string): string | undefined {
  let candidate = line.trim();
  let unwrapped = false;
  for (let depth = 0; depth < 4; depth += 1) {
    for (const [opener, closer] of MARKDOWN_MEDIA_LINE_WRAPPERS) {
      if (
        candidate.startsWith(opener) &&
        candidate.endsWith(closer) &&
        candidate.length > opener.length + closer.length
      ) {
        candidate = candidate.slice(opener.length, -closer.length).trim();
        unwrapped = true;
        break;
      }
    }
    if (unwrapped && candidate.toUpperCase().startsWith("MEDIA:")) {
      return candidate;
    }
  }
  return undefined;
}

function isRecoverableMediaSource(source: string): boolean {
  if (source.startsWith("/") || source.startsWith("file://")) {
    return true;
  }
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function recoverMarkdownWrappedMediaDirectives(text: string): {
  text: string;
  mediaSources: string[];
} {
  const keptLines: string[] = [];
  const mediaSources: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (const line of text.split("\n")) {
    const marker = markdownFenceMarker(line);
    if (marker) {
      if (!fence) {
        fence = marker;
      } else if (marker.marker === fence.marker && marker.length >= fence.length) {
        fence = undefined;
      }
      keptLines.push(line);
      continue;
    }
    if (fence) {
      keptLines.push(line);
      continue;
    }
    const directive = unwrapMarkdownMediaDirectiveLine(line);
    const source = directive
      ? unwrapMatchingQuote(directive.slice("MEDIA:".length))
      : "";
    if (!source || !isRecoverableMediaSource(source)) {
      keptLines.push(line);
      continue;
    }
    mediaSources.push(source);
  }

  return {
    text: keptLines.join("\n").trim(),
    mediaSources
  };
}

const xmppIngressIdentity = defineStableChannelIngressIdentity({
  kind: "plugin:xmpp-jid",
  normalize: (value) => normalizeBareJid(value),
  isWildcardEntry: (value) => value.trim() === "*",
  entryIdPrefix: "xmpp-jid"
});

const pairingReplyAt = new Map<string, number>();
const PAIRING_REPLY_COOLDOWN_MS = 5 * 60 * 1000;

function shouldSendPairingReply(key: string, now = Date.now()): boolean {
  const previous = pairingReplyAt.get(key) ?? 0;
  if (now - previous < PAIRING_REPLY_COOLDOWN_MS) {
    return false;
  }
  pairingReplyAt.set(key, now);
  return true;
}

function commandAuthorized(
  sender: string,
  effectiveAllowFrom: readonly string[]
): boolean {
  const normalized = normalizeBareJid(sender);
  if (!normalized) {
    return false;
  }
  return effectiveAllowFrom
    .filter((entry) => entry !== "*")
    .some((entry) => normalizeBareJid(entry) === normalized);
}

function mediaReader(params: {
  cfg: OpenClawConfig;
  agentId: string;
  mediaSources: readonly string[];
}): (path: string) => Promise<Buffer> {
  const roots = getAgentScopedMediaLocalRootsForSources({
    cfg: params.cfg,
    agentId: params.agentId,
    mediaSources: params.mediaSources
  });
  return async (path) => {
    const result = await readLocalFileFromRoots({
      filePath: path,
      roots,
      label: "XMPP outbound media",
      symlinks: "follow-within-root",
      hardlinks: "allow",
      maxBytes: 100 * 1024 * 1024
    });
    if (!result) {
      throw new Error("XMPP outbound media is outside approved local roots.");
    }
    return result.buffer;
  };
}

export async function handleInboundXmppMessage(params: {
  cfg: OpenClawConfig;
  account: XmppConnectionConfig;
  transport: XmppTransport;
  runtime: XmppInboundRuntime;
  message: InboundXmppMessage;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
  };
}): Promise<void> {
  const { account, message, transport, runtime } = params;
  const access = await createChannelIngressResolver({
    channelId: "xmpp",
    accountId: account.accountId,
    identity: xmppIngressIdentity,
    useDefaultPairingStore: true,
    defaultDmPolicy: "pairing"
  }).message({
    subject: { stableId: message.fromBare },
    conversation: { kind: "direct", id: message.fromBare },
    event: { kind: "message", authMode: "inbound", mayPair: true },
    dmPolicy: account.dmPolicy,
    groupPolicy: "disabled",
    allowFrom: account.allowFrom,
    command: false
  });

  if (access.ingress.decision !== "allow") {
    if (access.ingress.admission === "pairing-required") {
      const pairingKey = `${account.accountId}\u0000${message.fromBare}`;
      const pairing = await runtime.channel.pairing.upsertPairingRequest({
        channel: "xmpp",
        id: message.fromBare,
        accountId: account.accountId,
        meta: { jid: message.fromBare }
      });
      if (shouldSendPairingReply(pairingKey)) {
        const text = runtime.channel.pairing.buildPairingReply({
          channel: "xmpp",
          idLine: `Your XMPP JID: ${message.fromBare}`,
          code: pairing.code
        });
        await transport.sendText(
          message.from,
          pairing.created
            ? text
            : `${text}\n\nPairing request is still pending approval.`
        );
      }
    } else {
      params.log.warn(
        `[${account.accountId}] blocked XMPP DM from ${message.fromBare} (${access.ingress.reasonCode})`
      );
    }
    if (message.receiptRequested && message.receiptId) {
      await transport.sendReceipt(message.from, message.receiptId);
    }
    return;
  }

  const peer = { kind: "direct" as const, id: message.fromBare };
  const route = runtime.channel.routing.resolveAgentRoute({
    cfg: params.cfg,
    channel: "xmpp",
    accountId: account.accountId,
    peer
  });
  await transport.sendChatState(message.from, "composing").catch(() => undefined);
  try {
    await dispatchInboundDirectDmWithRuntime({
      cfg: params.cfg,
      runtime,
      channel: "xmpp",
      channelLabel: "XMPP",
      accountId: account.accountId,
      peer,
      senderId: message.fromBare,
      senderAddress: `xmpp:${message.fromBare}`,
      recipientAddress: `xmpp:${account.jid}`,
      conversationLabel: message.fromBare,
      rawBody: message.body,
      bodyForAgent: message.body,
      commandBody: message.body,
      messageId: message.id,
      ...(message.timestamp ? { timestamp: message.timestamp } : {}),
      commandAuthorized: commandAuthorized(
        message.fromBare,
        access.senderAccess.effectiveAllowFrom
      ),
      provider: "xmpp",
      surface: "xmpp",
      originatingChannel: "xmpp",
      originatingTo: message.fromBare,
      extraContext: {
        NativeDirectUserId: message.fromBare,
        XMPPFullJid: message.from
      },
      deliver: async (payload) => {
        const recovered = recoverMarkdownWrappedMediaDirectives(
          payload.text ?? ""
        );
        const mediaUrls = [...new Set([
          ...(payload.mediaUrls ?? []),
          ...(payload.mediaUrl ? [payload.mediaUrl] : []),
          ...recovered.mediaSources
        ].filter(Boolean))];
        const text = recovered.text;
        if (mediaUrls.length === 0) {
          const chunks = chunkXmppReplyText({
            cfg: params.cfg,
            accountId: account.accountId,
            text
          });
          if (chunks.length > 1) {
            params.log.info(
              `[${account.accountId}] split ${text.length}-character XMPP reply into ${chunks.length} messages`
            );
          }
          for (const chunk of chunks) {
            await transport.sendText(message.from, chunk);
          }
          return;
        }
        const readFile = mediaReader({
          cfg: params.cfg,
          agentId: route.agentId,
          mediaSources: mediaUrls
        });
        for (const [index, mediaUrl] of mediaUrls.entries()) {
          await transport.sendMedia({
            to: message.from,
            text: index === 0 ? text : "",
            mediaUrl,
            mediaReadFile: readFile
          });
        }
      },
      onRecordError: (error) => {
        params.log.warn(
          `[${account.accountId}] failed to record XMPP inbound session: ${String(
            error
          )}`
        );
      },
      onDispatchError: (error, info) => {
        params.log.error(
          `[${account.accountId}] XMPP ${info.kind} reply failed: ${String(error)}`
        );
      }
    });
    if (message.receiptRequested && message.receiptId) {
      await transport.sendReceipt(message.from, message.receiptId);
    }
  } finally {
    await transport.sendChatState(message.from, "active").catch(() => undefined);
  }
}

export function resetInboundStateForTests(): void {
  pairingReplyAt.clear();
}

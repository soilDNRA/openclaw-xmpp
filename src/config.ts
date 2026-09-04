import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { SecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  hasConfiguredSecretInput,
  resolveConfiguredSecretInputString
} from "openclaw/plugin-sdk/secret-input-runtime";

import {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_MEDIA_MAX_MB,
  DEFAULT_RESOURCE
} from "./constants.js";
import {
  jidDomain,
  jidLocalpart,
  normalizeBareJid
} from "./jid.js";

export type XmppDmPolicy = "pairing" | "allowlist" | "open" | "disabled";

export type XmppDmSessionScope = "per-user" | "per-channel-peer" | "per-account-channel-peer";
export type XmppThreadReplies = "off" | "inbound" | "always";

export interface XmppDmConfig {
  sessionScope?: XmppDmSessionScope;
  threadReplies?: XmppThreadReplies;
}

export interface XmppThreadBindingsConfig {
  enabled?: boolean;
  idleHours?: number;
  maxAgeHours?: number;
  spawnSessions?: boolean;
}

export interface XmppAccountConfig {
  enabled?: boolean;
  name?: string;
  jid?: string;
  password?: SecretInput;
  resource?: string;
  service?: string;
  websocketUrl?: string;
  dmPolicy?: XmppDmPolicy;
  allowFrom?: string[];
  sendReceipts?: boolean;
  requestReceipts?: boolean;
  sendChatStates?: boolean;
  textChunkLimit?: number;
  mediaMaxMb?: number;
  healthProbe?: boolean;
  healthProbeIntervalSeconds?: number;
  healthProbeTimeoutSeconds?: number;
  reconnectDelaySeconds?: number;
  dm?: XmppDmConfig;
  threadBindings?: XmppThreadBindingsConfig;
}

export interface XmppChannelConfig extends XmppAccountConfig {
  defaultAccount?: string;
  accounts?: Record<string, XmppAccountConfig>;
}

export interface ResolvedXmppAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  jid?: string;
  password?: SecretInput;
  resource: string;
  service?: string;
  websocketUrl?: string;
  dmPolicy: XmppDmPolicy;
  allowFrom: string[];
  sendReceipts: boolean;
  requestReceipts: boolean;
  sendChatStates: boolean;
  mediaMaxMb: number;
  healthProbe: boolean;
  healthProbeIntervalSeconds: number;
  healthProbeTimeoutSeconds: number;
  reconnectDelaySeconds: number;
  dm?: XmppDmConfig;
  threadBindings?: XmppThreadBindingsConfig;
}

export interface XmppConnectionConfig {
  accountId: string;
  jid: string;
  domain: string;
  username: string;
  password: string;
  resource: string;
  service: string;
  dmPolicy: XmppDmPolicy;
  allowFrom: string[];
  sendReceipts: boolean;
  requestReceipts: boolean;
  sendChatStates: boolean;
  mediaMaxBytes: number;
  healthProbe: boolean;
  healthProbeIntervalMs: number;
  healthProbeTimeoutMs: number;
  reconnectDelayMs: number;
}

type ConfigWithChannels = OpenClawConfig & {
  channels?: OpenClawConfig["channels"] & {
    xmpp?: XmppChannelConfig;
  };
};

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, value))
    : fallback;
}

function channelConfig(cfg: OpenClawConfig): XmppChannelConfig {
  return (cfg as ConfigWithChannels).channels?.xmpp ?? {};
}

function normalizeAccountId(value: string | null | undefined): string {
  const normalized = cleanString(value)?.toLowerCase();
  return normalized || DEFAULT_ACCOUNT_ID;
}

function envAccountPrefix(accountId: string): string {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return "XMPP";
  }
  return `XMPP_${accountId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
}

function envValue(accountId: string, key: string): string | undefined {
  return cleanString(process.env[`${envAccountPrefix(accountId)}_${key}`]);
}

function accountEntry(cfg: OpenClawConfig, accountId: string): XmppAccountConfig {
  const section = channelConfig(cfg);
  if (section.accounts?.[accountId]) {
    return {
      ...section,
      accounts: undefined,
      defaultAccount: undefined,
      ...section.accounts[accountId]
    } as XmppAccountConfig;
  }
  return section;
}

export function listXmppAccountIds(cfg: OpenClawConfig): string[] {
  const section = channelConfig(cfg);
  const ids = Object.keys(section.accounts ?? {}).map(normalizeAccountId);
  if (ids.length > 0) {
    return [...new Set(ids)].sort();
  }
  if (
    cleanString(section.jid) ||
    cleanString(process.env.XMPP_JID) ||
    hasConfiguredSecretInput(section.password)
  ) {
    return [DEFAULT_ACCOUNT_ID];
  }
  return [DEFAULT_ACCOUNT_ID];
}

export function resolveDefaultXmppAccountId(cfg: OpenClawConfig): string {
  const section = channelConfig(cfg);
  const configuredDefault = normalizeAccountId(section.defaultAccount);
  const ids = listXmppAccountIds(cfg);
  if (section.defaultAccount && ids.includes(configuredDefault)) {
    return configuredDefault;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveXmppAccount(
  cfg: OpenClawConfig,
  requestedAccountId?: string | null
): ResolvedXmppAccount {
  const accountId = requestedAccountId
    ? normalizeAccountId(requestedAccountId)
    : resolveDefaultXmppAccountId(cfg);
  const raw = accountEntry(cfg, accountId);
  const jidValue = normalizeBareJid(raw.jid ?? envValue(accountId, "JID") ?? "");
  const password = raw.password ?? envValue(accountId, "PASSWORD");
  const websocketUrl =
    cleanString(raw.websocketUrl) ?? envValue(accountId, "WEBSOCKET_URL");
  const service = cleanString(raw.service) ?? envValue(accountId, "SERVICE");
  const allowFrom = (raw.allowFrom ?? [])
    .map((entry) => normalizeBareJid(entry))
    .filter((entry): entry is string => Boolean(entry));
  const name = cleanString(raw.name);

  return {
    accountId,
    ...(name ? { name } : {}),
    enabled: raw.enabled !== false,
    configured: Boolean(jidValue && hasConfiguredSecretInput(password)),
    ...(jidValue ? { jid: jidValue } : {}),
    ...(password !== undefined ? { password } : {}),
    resource: cleanString(raw.resource) ?? DEFAULT_RESOURCE,
    ...(service ? { service } : {}),
    ...(websocketUrl ? { websocketUrl } : {}),
    dmPolicy: raw.dmPolicy ?? "pairing",
    allowFrom,
    sendReceipts: raw.sendReceipts !== false,
    requestReceipts: raw.requestReceipts !== false,
    sendChatStates: raw.sendChatStates !== false,
    mediaMaxMb:
      typeof raw.mediaMaxMb === "number" && Number.isFinite(raw.mediaMaxMb)
        ? Math.max(1, Math.min(100, raw.mediaMaxMb))
        : DEFAULT_MEDIA_MAX_MB,
    healthProbe: raw.healthProbe !== false,
    healthProbeIntervalSeconds: boundedNumber(
      raw.healthProbeIntervalSeconds,
      300,
      30,
      3600
    ),
    healthProbeTimeoutSeconds: boundedNumber(
      raw.healthProbeTimeoutSeconds,
      15,
      5,
      60
    ),
    reconnectDelaySeconds: boundedNumber(
      raw.reconnectDelaySeconds,
      1,
      1,
      60
    ),
    ...(raw.dm ? { dm: raw.dm } : {}),
    ...(raw.threadBindings ? { threadBindings: raw.threadBindings } : {})
  };
}

function validateService(account: ResolvedXmppAccount): string {
  if (!account.jid) {
    throw new Error("XMPP JID is not configured.");
  }
  if (account.websocketUrl) {
    const url = new URL(account.websocketUrl);
    if (url.protocol !== "wss:") {
      throw new Error("XMPP WebSocket URLs must use wss:.");
    }
    return url.toString();
  }
  if (account.service) {
    if (!account.service.includes("://")) {
      return account.service;
    }
    const url = new URL(account.service);
    if (!["xmpp:", "xmpps:", "wss:"].includes(url.protocol)) {
      throw new Error("XMPP service must use xmpp:, xmpps:, or wss:.");
    }
    return url.toString();
  }
  return jidDomain(account.jid);
}

export async function resolveXmppConnectionConfig(
  cfg: OpenClawConfig,
  requestedAccountId?: string | null,
  env: NodeJS.ProcessEnv = process.env
): Promise<XmppConnectionConfig> {
  const account = resolveXmppAccount(cfg, requestedAccountId);
  if (!account.enabled) {
    throw new Error(`XMPP account "${account.accountId}" is disabled.`);
  }
  if (!account.jid || !account.password) {
    throw new Error(`XMPP account "${account.accountId}" is not configured.`);
  }
  if (account.allowFrom.includes("*") && account.dmPolicy !== "open") {
    throw new Error(
      `XMPP account "${account.accountId}" uses allowFrom "*" but dmPolicy is not "open".`
    );
  }
  const passwordPath =
    account.accountId === DEFAULT_ACCOUNT_ID
      ? "channels.xmpp.password"
      : `channels.xmpp.accounts.${account.accountId}.password`;
  const resolved = await resolveConfiguredSecretInputString({
    config: cfg,
    env,
    value: account.password,
    path: passwordPath,
    unresolvedReasonStyle: "detailed"
  });
  const password = cleanString(resolved.value);
  if (!password) {
    throw new Error(
      resolved.unresolvedRefReason ??
        `XMPP password for account "${account.accountId}" could not be resolved.`
    );
  }
  return {
    accountId: account.accountId,
    jid: account.jid,
    domain: jidDomain(account.jid),
    username: jidLocalpart(account.jid),
    password,
    resource: account.resource,
    service: validateService(account),
    dmPolicy: account.dmPolicy,
    allowFrom: account.allowFrom,
    sendReceipts: account.sendReceipts,
    requestReceipts: account.requestReceipts,
    sendChatStates: account.sendChatStates,
    mediaMaxBytes: Math.floor(account.mediaMaxMb * 1024 * 1024),
    healthProbe: account.healthProbe,
    healthProbeIntervalMs: Math.floor(account.healthProbeIntervalSeconds * 1000),
    healthProbeTimeoutMs: Math.floor(account.healthProbeTimeoutSeconds * 1000),
    reconnectDelayMs: Math.floor(account.reconnectDelaySeconds * 1000)
  };
}

export function setXmppAccountEnabled(
  cfg: OpenClawConfig,
  accountId: string,
  enabled: boolean
): OpenClawConfig {
  const next = structuredClone(cfg) as ConfigWithChannels;
  next.channels ??= {};
  const section = (next.channels.xmpp ??= {});
  if (accountId === DEFAULT_ACCOUNT_ID && !section.accounts) {
    section.enabled = enabled;
    return next;
  }
  section.accounts ??= {};
  section.accounts[accountId] = {
    ...section.accounts[accountId],
    enabled
  };
  return next;
}

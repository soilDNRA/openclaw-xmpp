import { jid } from "@xmpp/client";

const TARGET_PREFIX = /^(?:xmpp:)/i;

export function normalizeBareJid(value: string): string | undefined {
  const raw = value.trim().replace(TARGET_PREFIX, "");
  if (!raw || raw === "*") {
    return raw || undefined;
  }
  try {
    const parsed = jid(raw);
    if (!parsed.local || !parsed.domain) {
      return undefined;
    }
    return `${parsed.getLocal(true)}@${parsed.domain.toLowerCase()}`;
  } catch {
    return undefined;
  }
}

export function normalizeFullJid(value: string): string | undefined {
  const raw = value.trim().replace(TARGET_PREFIX, "");
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = jid(raw);
    if (!parsed.local || !parsed.domain) {
      return undefined;
    }
    const bare = `${parsed.getLocal(true)}@${parsed.domain.toLowerCase()}`;
    return parsed.resource ? `${bare}/${parsed.resource}` : bare;
  } catch {
    return undefined;
  }
}

export function jidDomain(value: string): string {
  const normalized = normalizeBareJid(value);
  if (!normalized || normalized === "*") {
    throw new Error("A valid XMPP JID is required.");
  }
  return normalized.slice(normalized.indexOf("@") + 1);
}

export function jidLocalpart(value: string): string {
  const normalized = normalizeBareJid(value);
  if (!normalized || normalized === "*") {
    throw new Error("A valid XMPP JID is required.");
  }
  return normalized.slice(0, normalized.indexOf("@"));
}

export function normalizeXmppTarget(raw: string): string | undefined {
  const normalized = normalizeBareJid(raw);
  return normalized && normalized !== "*" ? normalized : undefined;
}

export function matchesAllowFrom(sender: string, entries: readonly string[]): boolean {
  const normalizedSender = normalizeBareJid(sender);
  if (!normalizedSender) {
    return false;
  }
  return entries.some((entry) => {
    const normalizedEntry = normalizeBareJid(String(entry));
    return normalizedEntry === "*" || normalizedEntry === normalizedSender;
  });
}

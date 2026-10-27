import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult
} from "openclaw/plugin-sdk/core";

import { getLiveTransport } from "../transport.js";
import { LEGACY_OMEMO, OMEMO_2, type OmemoVersion } from "./engine.js";
import type { OmemoTrustState } from "./libomemo-store.js";

const TRUST_STATES = new Set<OmemoTrustState>([
  "undecided", "trusted", "verified", "distrusted", "retired"
]);

export function registerOmemoOperatorCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "xmpp-omemo",
    description: "Review OMEMO trust and perform guarded device lifecycle operations",
    acceptsArgs: true,
    requireAuth: true,
    requiredScopes: ["operator.admin"],
    exposeSenderIsOwner: true,
    handler: handleOmemoOperatorCommand
  });
}

export async function handleOmemoOperatorCommand(
  context: PluginCommandContext
): Promise<PluginCommandResult> {
  if (context.senderIsOwner !== true) {
    return { text: "This OMEMO operator command is restricted to the Gateway owner." };
  }
  try {
    const args = tokenize(context.args ?? "");
    const operation = args.shift();
    const accountId = args.shift();
    if (!operation || !accountId) return { text: usage() };
    const transport = getLiveTransport(accountId);
    const session = transport?.omemoSession;
    if (!transport?.status.connected || !session) {
      return { text: `XMPP account ${accountId} does not have an active connected OMEMO session.` };
    }

    if ((operation === "review" && args.length === 0) || (operation === "approve" && args.length === 1)) {
      // The host command context does not attest an OMEMO sender device.
      // Never let a bare XMPP owner JID substitute for verified-device proof.
      if (context.channel === "xmpp" || context.channelId === "xmpp") {
        return { text: "Use the authenticated Gateway admin review (xmpp.omemo.review), or another authenticated owner channel. XMPP device approval is not available without verified sender-device provenance." };
      }
      if (!context.isAuthorizedSender || !context.senderId) throw new Error("Authenticated reviewer identity is required.");
      const owner = JSON.stringify([context.channel, context.senderId]);
      if (operation === "approve") {
        const record = await session.approveReview(owner, args[0]!);
        return { text: `Device approved as trusted (not fingerprint-verified): ${record.fingerprint}` };
      }
      const records = await session.reviewPending(owner);
      return { text: records.length ? records.map((record) => [
        `${record.address}: awaiting approval`,
        `Fingerprint: ${record.fingerprint}`,
        `First observed: ${new Date(record.firstObservedAt).toISOString()}`,
        `Policy: ${session.deliveryPolicy}. Approve only if you recognise this device.`,
        `/xmpp-omemo approve ${accountId} ${record.code}`,
        "Code expires in 10 minutes. Approval grants trust, not independent verification."
      ].join("\n")).join("\n\n") : "No new devices awaiting approval. Use list to inspect rejected devices or changed identities." };
    }

    if (operation === "list" && args.length === 0) {
      const records = await session.inspectTrust();
      if (records.length === 0) return { text: `No OMEMO remote identities are recorded for ${accountId}.` };
      return { text: records.map((record) => [
        `${record.address} ${record.state}`,
        `fingerprint ${compactFingerprint(record.fingerprint)}`,
        ...(record.candidate ? [
          `replacement-candidate ${compactFingerprint(record.candidate.observedFingerprint)}`,
          `candidate-observed-at ${new Date(record.candidate.observedAt).toISOString()}`
        ] : [])
      ].join("\n")).join("\n\n") };
    }

    if (operation === "trust" && args.length === 4) {
      const [address, expectedStateText, expectedFingerprint, nextStateText] = args as [string, string, string, string];
      const expectedState = trustState(expectedStateText);
      const nextState = trustState(nextStateText);
      const result = await session.transitionTrust(
        address, { state: expectedState, fingerprint: normalizeFingerprint(expectedFingerprint) }, nextState
      );
      return { text: `OMEMO trust updated for ${address}: ${result.state} ${result.fingerprint}` };
    }

    if (operation === "replace" && args.length === 5) {
      const [address, expectedStateText, expectedFingerprint, observedFingerprint, nextStateText] =
        args as [string, string, string, string, string];
      const result = await session.replaceIdentity(
        address,
        { state: trustState(expectedStateText), fingerprint: normalizeFingerprint(expectedFingerprint) },
        normalizeFingerprint(observedFingerprint),
        trustState(nextStateText)
      );
      return { text: `OMEMO identity replaced for ${address}: ${result.state} ${result.fingerprint}` };
    }

    if (operation === "retire-device" && args.length === 2) {
      const [profile, deviceIdText] = args as [string, string];
      const version = profileVersion(profile);
      const deviceId = Number(deviceIdText);
      if (!Number.isSafeInteger(deviceId) || deviceId < 1 || deviceId > 0x7fffffff) {
        throw new Error("Invalid OMEMO device ID.");
      }
      await session.retireLocalDevice(version, deviceId);
      return { text: `OMEMO ${profile} device ${deviceId} is no longer advertised; its bundle item was retracted. Local state was retained for rollback.` };
    }
    if (operation === "activate-device" && args.length === 2) {
      const [profile, deviceIdText] = args as [string, string];
      const version = profileVersion(profile);
      const deviceId = Number(deviceIdText);
      if (!Number.isSafeInteger(deviceId) || deviceId < 1 || deviceId > 0x7fffffff) {
        throw new Error("Invalid OMEMO device ID.");
      }
      await session.activateLocalDevice(version, deviceId);
      return { text: `OMEMO ${profile} device ${deviceId} bundle and advertisement were restored.` };
    }
    return { text: usage() };
  } catch (error) {
    return { text: `OMEMO operator command failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function tokenize(value: string): string[] {
  const tokens = value.trim() ? value.trim().split(/\s+/) : [];
  if (tokens.some((token) => token.length > 1024) || tokens.length > 8) {
    throw new Error("Invalid OMEMO operator command arguments.");
  }
  return tokens;
}

function trustState(value: string): OmemoTrustState {
  if (!TRUST_STATES.has(value as OmemoTrustState)) throw new Error("Invalid OMEMO trust state.");
  return value as OmemoTrustState;
}

function profileVersion(value: string): OmemoVersion {
  if (value === "legacy") return LEGACY_OMEMO;
  if (value === "omemo2") return OMEMO_2;
  throw new Error("Invalid OMEMO profile; expected legacy or omemo2.");
}

function normalizeFingerprint(value: string): string {
  const compact = value.replace(/[:-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(compact)) throw new Error("Invalid OMEMO fingerprint.");
  return compact.match(/.{8}/g)!.join(" ");
}

function compactFingerprint(value: string): string {
  return value.replace(/\s/g, "");
}

function usage(): string {
  return [
    "Usage:",
    "/xmpp-omemo list <account>",
    "/xmpp-omemo review <account>",
    "/xmpp-omemo approve <account> <review-code>",
    "/xmpp-omemo trust <account> <jid.device> <expected-state> <expected-fingerprint> <next-state>",
    "/xmpp-omemo replace <account> <jid.device> <expected-state> <old-fingerprint> <new-fingerprint> <next-state>",
    "/xmpp-omemo retire-device <account> <legacy|omemo2> <local-device-id>",
    "/xmpp-omemo activate-device <account> <legacy|omemo2> <local-device-id>"
  ].join("\n");
}

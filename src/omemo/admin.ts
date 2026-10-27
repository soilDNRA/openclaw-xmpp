import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getLiveTransport } from "../transport.js";

/** Host-authenticated admin actions; never reachable through model tools or XMPP. */
export function registerOmemoAdmin(api: OpenClawPluginApi): void {
  for (const operation of ["review", "approve"] as const) {
    api.registerGatewayMethod(`xmpp.omemo.${operation}`, async ({ client, params, respond }) => {
      try {
        if (!client || client.connect.role !== "operator" || !client.connect.scopes?.includes("operator.admin")) {
          throw new Error("Authenticated operator.admin access is required.");
        }
        // Prefer a verified user identity, otherwise bind to this authenticated
        // connection. No caller-supplied owner field or unverified client label.
        const principal = client.authenticatedUserId ?? client.connId;
        if (!principal) throw new Error("Authenticated reviewer identity is unavailable.");
        const owner = JSON.stringify(["gateway-admin", client.authenticatedUserId ? "user" : "connection", principal]);
        const accountId = params.accountId;
        if (typeof accountId !== "string" || !accountId || accountId.length > 256) throw new Error("Invalid XMPP account ID.");
        if (Object.keys(params).some((key) => !["accountId", ...(operation === "approve" ? ["code"] : [])].includes(key))) throw new Error("Unexpected review arguments.");
        const transport = getLiveTransport(accountId);
        const session = transport?.omemoSession;
        if (!session) throw new Error("No active OMEMO session for this account.");
        if (operation === "review") {
          respond(true, { accountId, policy: session.deliveryPolicy, status: transport.status,
            excludedDevices: session.excludedDevices,
            devices: await session.inspectTrust(), approvals: await session.reviewPending(owner),
            warning: "Approve only devices you recognise. Approval grants trust, not fingerprint verification." });
        } else {
          if (typeof params.code !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(params.code)) throw new Error("Invalid review code.");
          respond(true, { accountId, trust: await session.approveReview(owner, params.code) });
        }
      } catch (error) {
        respond(false, undefined, { code: "INVALID_REQUEST", message: error instanceof Error ? error.message : "OMEMO admin action failed." });
      }
    }, { scope: "operator.admin" });
  }
}

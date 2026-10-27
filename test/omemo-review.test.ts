import { describe, expect, it, vi } from "vitest";
import { OmemoReviewTickets } from "../src/omemo/review.js";
import { registerLiveTransport } from "../src/transport.js";
import { registerOmemoAdmin } from "../src/omemo/admin.js";

const record = { address: "peer@example.org.42", state: "undecided" as const,
  fingerprint: "a".repeat(64), firstObservedAt: 1, lastObservedAt: 2 };

describe("OMEMO review capabilities", () => {
  it("binds single-use approvals to the reviewer, device, fingerprint, state and expiry", () => {
    let now = 100;
    const tickets = new OmemoReviewTickets(() => now);
    const [review] = tickets.issue("owner", [record]);
    expect(review!.action).toBe("trusted");
    expect(() => tickets.consume("other", review!.code)).toThrow("mismatched");
    expect(tickets.consume("owner", review!.code)).toMatchObject({ address: record.address, expected: { state: "undecided", fingerprint: record.fingerprint } });
    expect(() => tickets.consume("owner", review!.code)).toThrow("Invalid");
    const [expired] = tickets.issue("owner", [record]);
    now += 600_000;
    expect(() => tickets.consume("owner", expired!.code)).toThrow("expired");
  });

  it("invalidates refreshed reviews and never issues approval for replacement or revoked identities", () => {
    const tickets = new OmemoReviewTickets();
    const [first] = tickets.issue("owner", [record]);
    tickets.issue("owner", []);
    expect(() => tickets.consume("owner", first!.code)).toThrow();
    expect(tickets.issue("owner", [
      { ...record, state: "retired" }, { ...record, state: "distrusted" },
      { ...record, candidate: { previousFingerprint: "a", observedFingerprint: "b", observedAt: 1 } }
    ])).toEqual([]);
    const [pending] = tickets.issue("owner", [record]);
    tickets.clear();
    expect(() => tickets.consume("owner", pending!.code)).toThrow();
    expect(() => new OmemoReviewTickets().consume("owner", pending!.code)).toThrow();
  });

  it("registers both admin RPCs with explicit admin scope and denies unauthenticated or read-only callers", async () => {
    const handlers = new Map<string, any>();
    registerOmemoAdmin({ registerGatewayMethod: (name: string, handler: unknown, opts: unknown) => {
      expect(opts).toEqual({ scope: "operator.admin" }); handlers.set(name, handler);
    } } as never);
    expect(handlers.size).toBe(2);
    for (const handler of handlers.values()) {
      for (const client of [null, { connect: { role: "operator", scopes: ["operator.read"] } }, { connect: { role: "node", scopes: ["operator.admin"] } }]) {
        const respond = vi.fn();
        await handler({ client, params: { accountId: "default" }, respond });
        expect(respond).toHaveBeenCalledWith(false, undefined, expect.objectContaining({ message: expect.stringContaining("operator.admin") }));
      }
    }
  });
  it("routes authenticated admin reviews and approvals with server-derived principals", async () => {
    const handlers = new Map<string, any>();
    registerOmemoAdmin({ registerGatewayMethod: (name: string, handler: unknown) => handlers.set(name, handler) } as never);
    const reviewPending = vi.fn(async () => []);
    const approveReview = vi.fn(async () => ({ state: "trusted" }));
    const unregister = registerLiveTransport("review-test", {
      status: { connected: true },
      omemoSession: { deliveryPolicy: "trusted-devices", excludedDevices: [],
        inspectTrust: async () => [], reviewPending, approveReview }
    } as never);
    try {
      const client = { connect: { role: "operator", scopes: ["operator.admin"] }, authenticatedUserId: "owner", connId: "connection" };
      const respond = vi.fn();
      await handlers.get("xmpp.omemo.review")({ client, params: { accountId: "review-test" }, respond });
      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ policy: "trusted-devices" }));
      const owner = JSON.stringify(["gateway-admin", "user", "owner"]);
      expect(reviewPending).toHaveBeenCalledWith(owner);
      await handlers.get("xmpp.omemo.approve")({ client, params: { accountId: "review-test", code: "a".repeat(16) }, respond });
      expect(approveReview).toHaveBeenCalledWith(owner, "a".repeat(16));
      approveReview.mockClear();
      await handlers.get("xmpp.omemo.approve")({ client, params: { accountId: "review-test", code: "a".repeat(16), owner: "forged" }, respond });
      expect(approveReview).not.toHaveBeenCalled();
      expect(respond).toHaveBeenLastCalledWith(false, undefined, expect.objectContaining({ message: "Unexpected review arguments." }));
    } finally { unregister(); }
  });

});

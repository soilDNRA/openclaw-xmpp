import { afterEach, describe, expect, it, vi } from "vitest";

import { handleOmemoOperatorCommand } from "../src/omemo/command.js";
import { LEGACY_OMEMO } from "../src/omemo/engine.js";
import { registerLiveTransport, resetLiveTransportsForTests } from "../src/transport.js";

afterEach(() => resetLiveTransportsForTests());

function context(args: string, senderIsOwner = true) {
  return { args, senderIsOwner, isAuthorizedSender: true, channel: "webchat", commandBody: `/xmpp-omemo ${args}` } as never;
}

describe("OMEMO operator command", () => {
  it("offers short approvals only to an authenticated non-XMPP owner", async () => {
    const reviewPending = vi.fn(async () => [{ address: "peer@example.org.1", fingerprint: "a".repeat(64), firstObservedAt: 1, code: "abcdefghijklmnop" }]);
    const approveReview = vi.fn(async () => ({ state: "trusted", fingerprint: "a".repeat(64) }));
    registerLiveTransport("default", { status: { connected: true }, omemoSession: { reviewPending, approveReview, deliveryPolicy: "trusted-devices" } } as never);
    const owner = { args: "review default", senderIsOwner: true, senderId: "owner", isAuthorizedSender: true, channel: "matrix" };
    expect((await handleOmemoOperatorCommand(owner as never)).text).toContain("approve default abcdefghijklmnop");
    expect((await handleOmemoOperatorCommand({ ...owner, args: "approve default abcdefghijklmnop" } as never)).text).toContain("not fingerprint-verified");
    reviewPending.mockClear(); approveReview.mockClear();
    for (const args of ["review default", "approve default abcdefghijklmnop"]) {
      expect((await handleOmemoOperatorCommand({ ...owner, channel: "xmpp", args } as never)).text).toContain("sender-device provenance");
      await handleOmemoOperatorCommand({ ...owner, senderIsOwner: false, args } as never);
    }
    expect(reviewPending).not.toHaveBeenCalled(); expect(approveReview).not.toHaveBeenCalled();
  });

  it("returns a controlled failure for malformed argument input", async () => {
    const result = await handleOmemoOperatorCommand(context(`list default ${"x".repeat(1025)}`));
    expect(result.text).toBe("OMEMO operator command failed: Invalid OMEMO operator command arguments.");
  });

  it("is owner-gated and drives exact trust and local-retirement operations", async () => {
    const inspectTrust = vi.fn(async () => [{
      address: "bob@example.org.9",
      state: "undecided" as const,
      fingerprint: "aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff 00000000 11111111",
      firstObservedAt: 1,
      lastObservedAt: 2
    }]);
    const transitionTrust = vi.fn(async () => ({
      state: "verified" as const, fingerprint: "aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff 00000000 11111111", firstObservedAt: 1, lastObservedAt: 2
    }));
    const retireLocalDevice = vi.fn(async () => undefined);
    const activateLocalDevice = vi.fn(async () => undefined);
    registerLiveTransport("default", {
      status: { connected: true },
      omemoSession: { inspectTrust, transitionTrust, retireLocalDevice, activateLocalDevice }
    } as never);

    expect((await handleOmemoOperatorCommand(context("list default", false))).text).toContain("Gateway owner");
    expect((await handleOmemoOperatorCommand(context("list default"))).text).toContain("bob@example.org.9 undecided");
    const fingerprint = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111";
    await handleOmemoOperatorCommand(context(`trust default bob@example.org.9 undecided ${fingerprint} verified`));
    expect(transitionTrust).toHaveBeenCalledWith(
      "bob@example.org.9",
      { state: "undecided", fingerprint: "aaaaaaaa bbbbbbbb cccccccc dddddddd eeeeeeee ffffffff 00000000 11111111" },
      "verified"
    );
    await handleOmemoOperatorCommand(context("retire-device default legacy 8123"));
    expect(retireLocalDevice).toHaveBeenCalledWith(LEGACY_OMEMO, 8123);
    await handleOmemoOperatorCommand(context("activate-device default legacy 8123"));
    expect(activateLocalDevice).toHaveBeenCalledWith(LEGACY_OMEMO, 8123);
  });
});

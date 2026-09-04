import { describe, expect, it, vi } from "vitest";

import { createTlsRequiredCredentials } from "../src/transport.js";

describe("XMPP transport authentication", () => {
  it("does not offer credentials before TLS is active", async () => {
    const authenticate = vi.fn();
    const credentials = createTlsRequiredCredentials({
      username: "bot",
      password: "secret"
    });
    await expect(
      credentials(
        authenticate,
        ["PLAIN"],
        null,
        { isSecure: () => false } as never
      )
    ).rejects.toThrow(/TLS is required before authentication/);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("authenticates after TLS and excludes ANONYMOUS", async () => {
    const authenticate = vi.fn(async () => undefined);
    const credentials = createTlsRequiredCredentials({
      username: "bot",
      password: "secret"
    });
    await credentials(
      authenticate,
      ["ANONYMOUS", "SCRAM-SHA-1", "PLAIN"],
      null,
      { isSecure: () => true } as never
    );
    expect(authenticate).toHaveBeenCalledOnce();
    expect(authenticate).toHaveBeenCalledWith(
      {
        username: "bot",
        password: "secret"
      },
      "SCRAM-SHA-1",
      expect.anything()
    );
  });
});

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  KeyHelper,
  SessionBuilder,
  SessionCipher,
  curvePubKeyToEd25519PubKey
} from "libomemo.js";

import type { XmppConnectionConfig } from "../config.js";
import { LEGACY_OMEMO, OMEMO_2, type OmemoVersion } from "./engine.js";
import type { LibomemoStoreAdapter } from "./libomemo-store.js";
import { OmemoSession } from "./session.js";
import { OmemoTransactionalStore } from "./store.js";
import { XmppOmemoPepAdapter, type OmemoIqCaller } from "./xmpp-pep.js";

const PRIVATE_DIRECTORY_MODE = 0o700;

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  chmodSync(path, PRIVATE_DIRECTORY_MODE);
}

export function resolveOmemoStateDirectory(stateRoot: string, accountId: string): string {
  const slug = accountId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "account";
  const suffix = createHash("sha256").update(accountId).digest("hex").slice(0, 12);
  const channel = join(stateRoot, "xmpp");
  const accounts = join(channel, "accounts");
  const account = join(accounts, `${slug}-${suffix}`);
  const omemo = join(account, "omemo");
  for (const directory of [channel, accounts, account, omemo]) privateDirectory(directory);
  return omemo;
}

export function createProductionOmemoSession(params: {
  config: XmppConnectionConfig;
  stateRoot: string;
  iq: OmemoIqCaller;
}): OmemoSession {
  const omemo = params.config.omemo;
  if (!omemo?.enabled) throw new Error("Cannot create an OMEMO session while OMEMO is disabled.");
  const version: OmemoVersion = omemo.profile === "omemo2" ? OMEMO_2 : LEGACY_OMEMO;
  const store = new OmemoTransactionalStore({
    stateDirectory: resolveOmemoStateDirectory(params.stateRoot, params.config.accountId)
  });
  const bindings = {
    keyHelper: KeyHelper,
    curvePubKeyToEd25519PubKey,
    createSessionBuilder: (adapter: LibomemoStoreAdapter, address: string, profile: OmemoVersion) =>
      new SessionBuilder(adapter, address, profile),
    createSessionCipher: (adapter: LibomemoStoreAdapter, address: string, profile: OmemoVersion) =>
      new SessionCipher(adapter, address, profile)
  };
  try {
    return new OmemoSession({
      account: params.config.jid,
      version,
      trustMode: omemo.trustMode,
      deliveryPolicy: omemo.deliveryPolicy ?? "strict-all",
      store,
      engineBindings: bindings,
      outboundBindings: bindings,
      inboundBindings: bindings,
      pep: new XmppOmemoPepAdapter(params.config.jid, params.iq)
    });
  } catch (error) {
    store.close();
    throw error;
  }
}

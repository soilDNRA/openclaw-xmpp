import {
  LibomemoStoreAdapter,
  OmemoIdentityChangedError,
  type LibomemoKeyPair,
  type OmemoTrustMode
} from "./libomemo-store.js";
import { type OmemoRecordView, OmemoTransactionalStore } from "./store.js";

export const LEGACY_OMEMO = "eu.siacs.conversations.axolotl";
export const OMEMO_2 = "urn:xmpp:omemo:2";
export type OmemoVersion = typeof LEGACY_OMEMO | typeof OMEMO_2;

const LIFECYCLE_KEY = "$key-lifecycle";
const LIFECYCLE_VERSION = 1;
const DEFAULT_PREKEY_TARGET = 100;
const DEFAULT_PREKEY_LOW_WATERMARK = 25;
const DEFAULT_SIGNED_PREKEY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETAINED_SIGNED_PREKEYS = 2;

interface GeneratedPreKey { keyId: number; keyPair: LibomemoKeyPair }
interface GeneratedSignedPreKey extends GeneratedPreKey { signature: ArrayBuffer }

export interface LibomemoEngineBindings {
  keyHelper: {
    generateIdentityKeyPair(): Promise<LibomemoKeyPair>;
    generateRegistrationId(): number;
    generatePreKey(keyId: number): Promise<GeneratedPreKey>;
    generateSignedPreKey(
      identityKeyPair: LibomemoKeyPair,
      signedKeyId: number,
      version: OmemoVersion
    ): Promise<GeneratedSignedPreKey>;
  };
  curvePubKeyToEd25519PubKey(publicKey: ArrayBuffer): Promise<ArrayBuffer>;
  createSessionBuilder(
    store: LibomemoStoreAdapter,
    address: string,
    version: OmemoVersion
  ): { processPreKey(bundle: OmemoRemoteBundle): Promise<void> };
}

export interface OmemoRemoteBundle {
  identityKey: ArrayBuffer;
  signedPreKey: { publicKey: ArrayBuffer; signature: ArrayBuffer; keyId: number };
  preKey?: { publicKey?: ArrayBuffer; keyId: number };
  registrationId: number;
}

export interface OmemoPublishedBundle {
  version: OmemoVersion;
  deviceId: number;
  identityKey: ArrayBuffer;
  signedPreKey: { id: number; publicKey: ArrayBuffer; signature: ArrayBuffer };
  preKeys: Array<{ id: number; publicKey: ArrayBuffer }>;
}

interface SignedPreKeyMetadata { id: number; createdAt: number; signature: string }
interface ProfileLifecycle {
  signedPreKeys: SignedPreKeyMetadata[];
  preKeyIds: number[];
}
interface LifecycleRecord {
  version: 1;
  nextKeyId: number;
  profiles: Record<OmemoVersion, ProfileLifecycle>;
}

export interface OmemoEngineOptions {
  account: string;
  store: OmemoTransactionalStore;
  bindings: LibomemoEngineBindings;
  trustMode: OmemoTrustMode;
  preKeyTarget?: number;
  preKeyLowWatermark?: number;
  signedPreKeyMaxAgeMs?: number;
  retainedSignedPreKeys?: number;
  clock?: () => number;
}

/** Transport-independent local-device, bundle and session lifecycle. */
export class OmemoEngine {
  readonly #account: string;
  readonly #store: OmemoTransactionalStore;
  readonly #bindings: LibomemoEngineBindings;
  readonly #trustMode: OmemoTrustMode;
  readonly #preKeyTarget: number;
  readonly #preKeyLowWatermark: number;
  readonly #signedPreKeyMaxAgeMs: number;
  readonly #retainedSignedPreKeys: number;
  readonly #clock: () => number;

  constructor(options: OmemoEngineOptions) {
    if (!options.account) throw new Error("OMEMO account must not be empty.");
    this.#account = options.account;
    this.#store = options.store;
    this.#bindings = options.bindings;
    this.#trustMode = options.trustMode;
    this.#preKeyTarget = positiveInteger(options.preKeyTarget ?? DEFAULT_PREKEY_TARGET, "prekey target");
    this.#preKeyLowWatermark = nonNegativeInteger(
      options.preKeyLowWatermark ?? DEFAULT_PREKEY_LOW_WATERMARK,
      "prekey low watermark"
    );
    if (this.#preKeyLowWatermark >= this.#preKeyTarget) {
      throw new Error("OMEMO prekey low watermark must be below the target.");
    }
    this.#signedPreKeyMaxAgeMs = positiveInteger(
      options.signedPreKeyMaxAgeMs ?? DEFAULT_SIGNED_PREKEY_MAX_AGE_MS,
      "signed-prekey maximum age"
    );
    this.#retainedSignedPreKeys = positiveInteger(
      options.retainedSignedPreKeys ?? DEFAULT_RETAINED_SIGNED_PREKEYS,
      "retained signed-prekey count"
    );
    this.#clock = options.clock ?? Date.now;
  }

  async initialize(): Promise<Record<OmemoVersion, OmemoPublishedBundle>> {
    return this.#store.updateRecords(this.#account, async (view) => {
      const adapter = this.#adapter(view);
      let identity = adapter.getIdentityKeyPair();
      let registrationId = adapter.getLocalRegistrationId();
      if ((identity === undefined) !== (registrationId === undefined)) {
        throw new Error("Corrupt OMEMO local identity initialization state.");
      }
      if (!identity) {
        identity = await this.#bindings.keyHelper.generateIdentityKeyPair();
        registrationId = this.#bindings.keyHelper.generateRegistrationId();
        adapter.put("identityKey", identity);
        adapter.put("registrationId", registrationId);
      }
      const lifecycle = decodeLifecycle(view.get("device", LIFECYCLE_KEY));
      await this.#maintainProfile(adapter, lifecycle, identity, LEGACY_OMEMO);
      await this.#maintainProfile(adapter, lifecycle, identity, OMEMO_2);
      view.set("device", LIFECYCLE_KEY, encodeLifecycle(lifecycle));
      return this.#bundles(adapter, lifecycle, identity, registrationId!);
    });
  }

  /** Replenish consumed one-time keys and rotate aged signed prekeys. */
  async maintainKeys(): Promise<Record<OmemoVersion, OmemoPublishedBundle>> {
    return this.initialize();
  }

  /** Establish a sending session from a validated, parsed remote PEP bundle. */
  async buildSession(address: string, version: OmemoVersion, bundle: OmemoRemoteBundle): Promise<void> {
    validateVersion(version);
    await this.observeIdentity(address, bundle.identityKey);
    await this.#store.updateRecords(this.#account, async (view) => {
      const adapter = this.#adapter(view);
      if (!adapter.getIdentityKeyPair() || adapter.getLocalRegistrationId() === undefined) {
        throw new Error("OMEMO local device is not initialized.");
      }
      await this.#bindings.createSessionBuilder(adapter, address, version).processPreKey(bundle);
    });
  }

  /** Discover identities without constructing a session or granting trust. */
  async observeIdentity(address: string, identityKey: ArrayBuffer): Promise<void> {
    try {
      await this.#store.updateRecords(this.#account, (view) => {
        this.#adapter(view).trust.observeIdentity(address, identityKey);
      });
    } catch (error) {
      if (error instanceof OmemoIdentityChangedError) {
        await this.#store.updateRecords(this.#account, (view) => {
          this.#adapter(view).trust.stageCandidate(address, error.previousFingerprint, identityKey);
        });
      }
      throw error;
    }
  }

  async hasSession(address: string): Promise<boolean> {
    return await this.#store.updateRecords(this.#account, (view) =>
      new LibomemoStoreAdapter(view, { mode: this.#trustMode, clock: this.#clock })
        .loadSession(address) !== undefined
    );
  }

  #adapter(view: OmemoRecordView): LibomemoStoreAdapter {
    return new LibomemoStoreAdapter(view, { mode: this.#trustMode, clock: this.#clock });
  }

  async #maintainProfile(
    adapter: LibomemoStoreAdapter,
    lifecycle: LifecycleRecord,
    identity: LibomemoKeyPair,
    version: OmemoVersion
  ): Promise<void> {
    const profile = lifecycle.profiles[version];
    const availablePreKeyIds: number[] = [];
    for (const id of profile.preKeyIds) {
      if (await adapter.loadPreKey(id)) availablePreKeyIds.push(id);
    }
    profile.preKeyIds = availablePreKeyIds;
    profile.signedPreKeys = profile.signedPreKeys.filter((key) => adapter.loadSignedPreKey(key.id));
    const now = validTimestamp(this.#clock());
    const current = profile.signedPreKeys.at(-1);
    if (!current || now - current.createdAt >= this.#signedPreKeyMaxAgeMs) {
      const id = lifecycle.nextKeyId++;
      const generated = await this.#bindings.keyHelper.generateSignedPreKey(identity, id, version);
      if (generated.keyId !== id) throw new Error("libomemo.js returned an unexpected signed-prekey ID.");
      adapter.storeSignedPreKey(id, generated.keyPair);
      profile.signedPreKeys.push({ id, createdAt: now, signature: bytesToBase64(generated.signature) });
    }
    while (profile.signedPreKeys.length > this.#retainedSignedPreKeys) {
      const expired = profile.signedPreKeys.shift();
      if (expired) adapter.removeSignedPreKey(expired.id);
    }
    if (profile.preKeyIds.length <= this.#preKeyLowWatermark) {
      while (profile.preKeyIds.length < this.#preKeyTarget) {
        const id = lifecycle.nextKeyId++;
        const generated = await this.#bindings.keyHelper.generatePreKey(id);
        if (generated.keyId !== id) throw new Error("libomemo.js returned an unexpected prekey ID.");
        adapter.storePreKey(id, generated.keyPair);
        profile.preKeyIds.push(id);
      }
    }
  }

  async #bundles(
    adapter: LibomemoStoreAdapter,
    lifecycle: LifecycleRecord,
    identity: LibomemoKeyPair,
    registrationId: number
  ): Promise<Record<OmemoVersion, OmemoPublishedBundle>> {
    const result = {} as Record<OmemoVersion, OmemoPublishedBundle>;
    for (const version of [LEGACY_OMEMO, OMEMO_2] as const) {
      const profile = lifecycle.profiles[version];
      const signed = profile.signedPreKeys.at(-1);
      if (!signed) throw new Error("OMEMO signed-prekey lifecycle is empty.");
      const signedPair = adapter.loadSignedPreKey(signed.id)?.keyPair;
      if (!signedPair) throw new Error("OMEMO signed-prekey record is missing.");
      const preKeys = await Promise.all(profile.preKeyIds.map(async (id) => {
        const pair = (await adapter.loadPreKey(id))?.keyPair;
        if (!pair) throw new Error("OMEMO prekey record is missing.");
        return { id, publicKey: wirePreKey(pair.pubKey, version) };
      }));
      result[version] = {
        version,
        deviceId: registrationId,
        identityKey: version === OMEMO_2
          ? await this.#bindings.curvePubKeyToEd25519PubKey(identity.pubKey)
          : identity.pubKey.slice(0),
        signedPreKey: {
          id: signed.id,
          publicKey: wirePreKey(signedPair.pubKey, version),
          signature: base64ToBytes(signed.signature)
        },
        preKeys
      };
    }
    return result;
  }
}

function emptyProfile(): ProfileLifecycle { return { signedPreKeys: [], preKeyIds: [] }; }

function decodeLifecycle(encoded: Uint8Array | undefined): LifecycleRecord {
  if (!encoded) return {
    version: LIFECYCLE_VERSION,
    nextKeyId: 1,
    profiles: { [LEGACY_OMEMO]: emptyProfile(), [OMEMO_2]: emptyProfile() }
  };
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)); }
  catch { throw new Error("Corrupt OMEMO key-lifecycle record encoding."); }
  if (!value || typeof value !== "object") throw new Error("Corrupt OMEMO key-lifecycle record.");
  const record = value as Partial<LifecycleRecord>;
  if (record.version !== LIFECYCLE_VERSION || !Number.isSafeInteger(record.nextKeyId) ||
      (record.nextKeyId ?? 0) < 1 || !record.profiles) {
    throw new Error("Corrupt OMEMO key-lifecycle record.");
  }
  const allocatedIds: number[] = [];
  for (const version of [LEGACY_OMEMO, OMEMO_2] as const) {
    const profile = record.profiles[version];
    validateProfile(profile);
    allocatedIds.push(...profile.preKeyIds, ...profile.signedPreKeys.map((key) => key.id));
  }
  if (new Set(allocatedIds).size !== allocatedIds.length ||
      allocatedIds.some((id) => id >= record.nextKeyId!)) {
    throw new Error("Corrupt OMEMO key-lifecycle allocation state.");
  }
  return record as LifecycleRecord;
}

function validateProfile(value: unknown): asserts value is ProfileLifecycle {
  if (!value || typeof value !== "object") throw new Error("Corrupt OMEMO profile lifecycle.");
  const profile = value as Partial<ProfileLifecycle>;
  if (!Array.isArray(profile.preKeyIds) || !Array.isArray(profile.signedPreKeys) ||
      profile.preKeyIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(profile.preKeyIds).size !== profile.preKeyIds.length) {
    throw new Error("Corrupt OMEMO profile lifecycle.");
  }
  for (const key of profile.signedPreKeys) {
    if (!key || !Number.isSafeInteger(key.id) || key.id < 1 || !Number.isSafeInteger(key.createdAt) ||
        key.createdAt < 0 || typeof key.signature !== "string" ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(key.signature) || Buffer.from(key.signature, "base64").byteLength !== 64) {
      throw new Error("Corrupt OMEMO signed-prekey lifecycle.");
    }
  }
}

function encodeLifecycle(record: LifecycleRecord): Buffer { return Buffer.from(JSON.stringify(record), "utf8"); }
function wirePreKey(key: ArrayBuffer, version: OmemoVersion): ArrayBuffer {
  if (!(key instanceof ArrayBuffer) || key.byteLength !== 33 || new Uint8Array(key)[0] !== 0x05) {
    throw new Error("Invalid OMEMO generated public key.");
  }
  return version === OMEMO_2 ? key.slice(1) : key.slice(0);
}
function bytesToBase64(value: ArrayBuffer): string {
  if (!(value instanceof ArrayBuffer) || value.byteLength === 0) throw new Error("Invalid OMEMO signature.");
  return Buffer.from(value).toString("base64");
}
function base64ToBytes(value: string): ArrayBuffer { return Uint8Array.from(Buffer.from(value, "base64")).buffer; }
function validateVersion(value: string): asserts value is OmemoVersion {
  if (value !== LEGACY_OMEMO && value !== OMEMO_2) throw new Error("Unsupported OMEMO version.");
}
function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid OMEMO ${name}.`);
  return value;
}
function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid OMEMO ${name}.`);
  return value;
}
function validTimestamp(value: number): number { return nonNegativeInteger(value, "timestamp"); }

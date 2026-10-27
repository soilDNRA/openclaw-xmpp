import { timingSafeEqual } from "node:crypto";

import { type OmemoRecordView } from "./store.js";

const LOCAL_IDENTITY_KEY = "$local";
const REGISTRATION_ID_KEY = "$registration-id";
const KEY_PAIR_VERSION = 1;
const TRUST_RECORD_VERSION = 1;
const PUBLIC_KEY_BYTES = 33;
const PRIVATE_KEY_BYTES = 32;
const MAX_REGISTRATION_ID = 0x3fff;
const MAX_SESSION_BYTES = 16 * 1024 * 1024;

export type LibomemoKeyId = number | string;
export type LibomemoDirection = 1 | 2;

export interface LibomemoKeyPair {
  pubKey: ArrayBuffer;
  privKey: ArrayBuffer;
}

/** Structural copy of the callback contract published by libomemo.js 3.0.0. */
export interface LibomemoStoreCallbacks {
  store: Record<string, unknown>;
  put(key: string, value: unknown): void;
  get<T = unknown>(key: string, defaultValue?: T): T | undefined;
  remove(key: string): void;
  isTrustedIdentity(address: string, identityKey: ArrayBuffer, direction: LibomemoDirection): boolean;
  loadIdentityKey(address: string): ArrayBuffer | undefined;
  saveIdentity(address: string, identityKey: ArrayBuffer): boolean;
  loadPreKey(keyId: LibomemoKeyId): Promise<{ keyPair: LibomemoKeyPair } | undefined>;
  storePreKey(keyId: LibomemoKeyId, keyPair: LibomemoKeyPair): void;
  removePreKey(keyId: LibomemoKeyId): void;
  loadSignedPreKey(keyId: number): { keyPair: LibomemoKeyPair } | undefined;
  storeSignedPreKey(keyId: LibomemoKeyId, keyPair: LibomemoKeyPair): void;
  removeSignedPreKey(keyId: LibomemoKeyId): void;
  loadSession(address: string): string | undefined;
  removeAllSessions(jid: string): void;
  removeSession(address: string): void;
  storeSession(address: string, record: string): void;
  getIdentityKeyPair(): LibomemoKeyPair | undefined;
  getLocalRegistrationId(): number | undefined;
}

export type OmemoTrustMode = "tofu" | "manual";
export type OmemoTrustState = "undecided" | "trusted" | "verified" | "distrusted" | "retired";

export interface OmemoTrustRecord {
  state: OmemoTrustState;
  fingerprint: string;
  firstObservedAt: number;
  lastObservedAt: number;
}

export interface OmemoExpectedTrust {
  state: OmemoTrustState;
  fingerprint: string;
}

export interface OmemoIdentityCandidate {
  previousFingerprint: string;
  observedFingerprint: string;
  identityKey: ArrayBuffer;
  observedAt: number;
}

export class OmemoTrustError extends Error {
  readonly code = "OMEMO_IDENTITY_NOT_TRUSTED";

  constructor(
    readonly address: string,
    readonly state: Exclude<OmemoTrustState, "trusted" | "verified">,
    readonly fingerprint: string,
    readonly direction: LibomemoDirection
  ) {
    super(`OMEMO identity is ${state}; operator review required. Device: ${address}; fingerprint: ${fingerprint}`);
    this.name = "OmemoTrustError";
  }
}

export class OmemoIdentityChangedError extends Error {
  readonly code = "OMEMO_IDENTITY_CHANGED";

  constructor(
    readonly address: string,
    readonly previousFingerprint: string,
    readonly observedFingerprint: string
  ) {
    super(`OMEMO identity key changed; operator review required. Device: ${address}; previous: ${previousFingerprint}; observed: ${observedFingerprint}`);
    this.name = "OmemoIdentityChangedError";
  }
}

export class OmemoTrustConflictError extends Error {
  readonly code = "OMEMO_TRUST_CONFLICT";

  constructor(readonly address: string) {
    super("OMEMO trust record changed since it was reviewed.");
    this.name = "OmemoTrustConflictError";
  }
}

export interface OmemoTrustPolicyOptions {
  mode: OmemoTrustMode;
  clock?: () => number;
}

/** Explicit trust policy layered over the operation-local transactional view. */
export class OmemoTrustPolicyAdapter {
  readonly #view: OmemoRecordView;
  readonly #mode: OmemoTrustMode;
  readonly #clock: () => number;

  constructor(view: OmemoRecordView, options: OmemoTrustPolicyOptions) {
    this.#view = view;
    this.#mode = options.mode;
    this.#clock = options.clock ?? Date.now;
  }

  get(address: string): OmemoTrustRecord | undefined {
    validateDeviceAddress(address);
    const identity = this.#view.get("identity", address);
    const encoded = this.#view.get("trust", address);
    if (!identity && !encoded) return undefined;
    if (!identity || !encoded) throw new Error("Corrupt OMEMO identity/trust record pair.");

    const record = decodeTrustRecord(encoded);
    if (record.fingerprint !== formatIdentityFingerprint(toArrayBuffer(identity))) {
      throw new Error("OMEMO trust fingerprint does not match the stored identity.");
    }
    return record;
  }

  candidate(address: string): OmemoIdentityCandidate | undefined {
    validateDeviceAddress(address);
    const encoded = this.#view.get("candidate", address);
    return encoded ? decodeIdentityCandidate(encoded) : undefined;
  }

  stageCandidate(
    address: string,
    previousFingerprint: string,
    identityKey: ArrayBuffer
  ): OmemoIdentityCandidate {
    validateDeviceAddress(address);
    const current = this.get(address);
    if (!current || current.fingerprint !== previousFingerprint) {
      throw new OmemoTrustConflictError(address);
    }
    const observed = identityKeyBuffer(identityKey);
    const candidate: OmemoIdentityCandidate = {
      previousFingerprint,
      observedFingerprint: formatIdentityFingerprint(toArrayBuffer(observed)),
      identityKey: toArrayBuffer(observed),
      observedAt: validTimestamp(this.#clock())
    };
    if (candidate.observedFingerprint === current.fingerprint) {
      throw new Error("OMEMO replacement candidate matches the current identity.");
    }
    this.#view.set("candidate", address, encodeIdentityCandidate(candidate));
    return candidate;
  }

  observeIdentity(address: string, identityKey: ArrayBuffer): OmemoTrustRecord {
    validateDeviceAddress(address);
    const observed = identityKeyBuffer(identityKey);
    const observedFingerprint = formatIdentityFingerprint(toArrayBuffer(observed));
    const currentIdentity = this.#view.get("identity", address);

    if (!currentIdentity) {
      if (this.#view.get("trust", address)) throw new Error("Corrupt OMEMO trust record without identity.");
      const now = validTimestamp(this.#clock());
      const record: OmemoTrustRecord = {
        state: this.#mode === "tofu" ? "trusted" : "undecided",
        fingerprint: observedFingerprint,
        firstObservedAt: now,
        lastObservedAt: now
      };
      this.#view.set("identity", address, observed);
      this.#view.set("trust", address, encodeTrustRecord(record));
      return { ...record };
    }

    const currentFingerprint = formatIdentityFingerprint(toArrayBuffer(currentIdentity));
    if (!equalBytes(currentIdentity, observed)) {
      throw new OmemoIdentityChangedError(address, currentFingerprint, observedFingerprint);
    }

    const record = this.get(address);
    if (!record) throw new Error("Corrupt OMEMO identity/trust record pair.");
    const lastObservedAt = Math.max(record.lastObservedAt, validTimestamp(this.#clock()));
    const updated = { ...record, lastObservedAt };
    this.#view.set("trust", address, encodeTrustRecord(updated));
    return updated;
  }

  assertTrusted(
    address: string,
    identityKey: ArrayBuffer,
    direction: LibomemoDirection
  ): OmemoTrustRecord {
    validateDirection(direction);
    const record = this.observeIdentity(address, identityKey);
    const candidate = this.candidate(address);
    if (candidate) throw new OmemoIdentityChangedError(address, record.fingerprint, candidate.observedFingerprint);
    if (record.state === "trusted" || record.state === "verified") return record;
    throw new OmemoTrustError(address, record.state, record.fingerprint, direction);
  }

  transition(
    address: string,
    expected: OmemoExpectedTrust,
    nextState: OmemoTrustState
  ): OmemoTrustRecord {
    validateTrustState(nextState);
    const current = this.get(address);
    if (!current || current.state !== expected.state || current.fingerprint !== expected.fingerprint) {
      throw new OmemoTrustConflictError(address);
    }
    const updated = { ...current, state: nextState };
    this.#view.set("trust", address, encodeTrustRecord(updated));
    return updated;
  }

  replaceIdentity(
    address: string,
    expected: OmemoExpectedTrust,
    observedIdentityKey: ArrayBuffer,
    expectedObservedFingerprint: string,
    nextState: OmemoTrustState = "undecided"
  ): OmemoTrustRecord {
    validateTrustState(nextState);
    const current = this.get(address);
    if (!current || current.state !== expected.state || current.fingerprint !== expected.fingerprint) {
      throw new OmemoTrustConflictError(address);
    }

    const observed = identityKeyBuffer(observedIdentityKey);
    const observedFingerprint = formatIdentityFingerprint(toArrayBuffer(observed));
    if (observedFingerprint !== expectedObservedFingerprint) throw new OmemoTrustConflictError(address);
    const currentIdentity = this.#view.get("identity", address);
    if (!currentIdentity) throw new Error("Corrupt OMEMO identity/trust record pair.");
    if (equalBytes(currentIdentity, observed)) {
      throw new Error("OMEMO replacement identity matches the current identity.");
    }
    const now = validTimestamp(this.#clock());
    const replacement: OmemoTrustRecord = {
      state: nextState,
      fingerprint: observedFingerprint,
      firstObservedAt: now,
      lastObservedAt: now
    };
    this.#view.set("identity", address, observed);
    this.#view.set("trust", address, encodeTrustRecord(replacement));
    this.#view.delete("session", address);
    this.#view.delete("candidate", address);
    return replacement;
  }
}

const IDENTITY_CANDIDATE_VERSION = 1;

function encodeIdentityCandidate(candidate: OmemoIdentityCandidate): Buffer {
  return Buffer.from(JSON.stringify({
    version: IDENTITY_CANDIDATE_VERSION,
    previousFingerprint: candidate.previousFingerprint,
    observedFingerprint: candidate.observedFingerprint,
    identityKey: Buffer.from(candidate.identityKey).toString("base64"),
    observedAt: candidate.observedAt
  }), "utf8");
}

function decodeIdentityCandidate(encoded: Uint8Array): OmemoIdentityCandidate {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded)); }
  catch { throw new Error("Corrupt OMEMO identity-candidate encoding."); }
  if (!value || typeof value !== "object") throw new Error("Corrupt OMEMO identity candidate.");
  const record = value as Record<string, unknown>;
  if (record.version !== IDENTITY_CANDIDATE_VERSION ||
      typeof record.previousFingerprint !== "string" ||
      typeof record.observedFingerprint !== "string" ||
      typeof record.identityKey !== "string" ||
      !Number.isSafeInteger(record.observedAt) || Number(record.observedAt) < 0) {
    throw new Error("Corrupt OMEMO identity candidate.");
  }
  const identityKey = Buffer.from(record.identityKey, "base64");
  if ((identityKey.byteLength !== 32 && identityKey.byteLength !== PUBLIC_KEY_BYTES) ||
      identityKey.toString("base64") !== record.identityKey) {
    throw new Error("Corrupt OMEMO identity candidate.");
  }
  const observedFingerprint = formatIdentityFingerprint(toArrayBuffer(identityKey));
  if (observedFingerprint !== record.observedFingerprint) throw new Error("Corrupt OMEMO identity candidate.");
  return {
    previousFingerprint: record.previousFingerprint,
    observedFingerprint,
    identityKey: toArrayBuffer(identityKey),
    observedAt: Number(record.observedAt)
  };
}

export interface LibomemoStoreAdapterOptions extends OmemoTrustPolicyOptions {}

/**
 * libomemo.js callbacks backed only by an OmemoRecordView.
 *
 * Construct a fresh adapter inside each OmemoTransactionalStore operation.
 * The compatibility `store` property is deliberately frozen: callback methods
 * are the only supported mutation path, so writes cannot escape the transaction.
 */
export class LibomemoStoreAdapter implements LibomemoStoreCallbacks {
  readonly store: Record<string, unknown> = Object.freeze(Object.create(null) as Record<string, unknown>);
  readonly trust: OmemoTrustPolicyAdapter;
  readonly #view: OmemoRecordView;

  constructor(view: OmemoRecordView, options: LibomemoStoreAdapterOptions) {
    this.#view = view;
    this.trust = new OmemoTrustPolicyAdapter(view, options);
  }

  put(key: string, value: unknown): void {
    if (key === "identityKey") {
      this.#view.set("identity", LOCAL_IDENTITY_KEY, encodeKeyPair(requireKeyPair(value)));
      return;
    }
    if (key === "registrationId") {
      this.#view.set("device", REGISTRATION_ID_KEY, encodeRegistrationId(value));
      return;
    }
    throw new Error(`Unsupported libomemo.js generic store key: ${key}`);
  }

  get<T = unknown>(key: string, defaultValue?: T): T | undefined {
    let value: unknown;
    if (key === "identityKey") value = this.getIdentityKeyPair();
    else if (key === "registrationId") value = this.getLocalRegistrationId();
    else throw new Error(`Unsupported libomemo.js generic store key: ${key}`);
    return (value === undefined ? defaultValue : value) as T | undefined;
  }

  remove(key: string): void {
    if (key === "identityKey") this.#view.delete("identity", LOCAL_IDENTITY_KEY);
    else if (key === "registrationId") this.#view.delete("device", REGISTRATION_ID_KEY);
    else throw new Error(`Unsupported libomemo.js generic store key: ${key}`);
  }

  getIdentityKeyPair(): LibomemoKeyPair | undefined {
    const encoded = this.#view.get("identity", LOCAL_IDENTITY_KEY);
    return encoded ? decodeKeyPair(encoded) : undefined;
  }

  getLocalRegistrationId(): number | undefined {
    const encoded = this.#view.get("device", REGISTRATION_ID_KEY);
    return encoded ? decodeRegistrationId(encoded) : undefined;
  }

  isTrustedIdentity(
    address: string,
    identityKey: ArrayBuffer,
    direction: LibomemoDirection
  ): boolean {
    this.trust.assertTrusted(address, identityKey, direction);
    return true;
  }

  loadIdentityKey(address: string): ArrayBuffer | undefined {
    validateDeviceAddress(address);
    const encoded = this.#view.get("identity", address);
    return encoded ? toArrayBuffer(identityKeyBuffer(toArrayBuffer(encoded))) : undefined;
  }

  saveIdentity(address: string, identityKey: ArrayBuffer): boolean {
    this.trust.observeIdentity(address, identityKey);
    return false;
  }

  async loadPreKey(keyId: LibomemoKeyId): Promise<{ keyPair: LibomemoKeyPair } | undefined> {
    const encoded = this.#view.get("prekey", normalizeKeyId(keyId));
    return encoded ? { keyPair: decodeKeyPair(encoded) } : undefined;
  }

  storePreKey(keyId: LibomemoKeyId, keyPair: LibomemoKeyPair): void {
    this.#view.set("prekey", normalizeKeyId(keyId), encodeKeyPair(keyPair));
  }

  removePreKey(keyId: LibomemoKeyId): void {
    this.#view.delete("prekey", normalizeKeyId(keyId));
  }

  loadSignedPreKey(keyId: number): { keyPair: LibomemoKeyPair } | undefined {
    const encoded = this.#view.get("signed-prekey", normalizeKeyId(keyId));
    return encoded ? { keyPair: decodeKeyPair(encoded) } : undefined;
  }

  storeSignedPreKey(keyId: LibomemoKeyId, keyPair: LibomemoKeyPair): void {
    this.#view.set("signed-prekey", normalizeKeyId(keyId), encodeKeyPair(keyPair));
  }

  removeSignedPreKey(keyId: LibomemoKeyId): void {
    this.#view.delete("signed-prekey", normalizeKeyId(keyId));
  }

  loadSession(address: string): string | undefined {
    validateDeviceAddress(address);
    const encoded = this.#view.get("session", address);
    if (!encoded) return undefined;
    if (encoded.byteLength > MAX_SESSION_BYTES) throw new Error("OMEMO session record exceeds the size limit.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded);
    } catch {
      throw new Error("Corrupt OMEMO session record encoding.");
    }
  }

  storeSession(address: string, record: string): void {
    validateDeviceAddress(address);
    if (typeof record !== "string" || record.length === 0) throw new Error("Invalid OMEMO session record.");
    const encoded = Buffer.from(record, "utf8");
    if (encoded.byteLength > MAX_SESSION_BYTES) throw new Error("OMEMO session record exceeds the size limit.");
    this.#view.set("session", address, encoded);
  }

  removeSession(address: string): void {
    validateDeviceAddress(address);
    this.#view.delete("session", address);
  }

  removeAllSessions(jid: string): void {
    validateAddress(jid);
    const prefix = `session\u0000${jid}.`;
    for (const [combined] of this.#view.entries()) {
      if (combined.startsWith(prefix)) this.#view.delete("session", combined.slice("session\u0000".length));
    }
  }
}

export function formatIdentityFingerprint(identityKey: ArrayBuffer): string {
  const key = identityKeyBuffer(identityKey);
  const raw = key.byteLength === PUBLIC_KEY_BYTES ? key.subarray(1) : key;
  return raw.toString("hex").match(/.{8}/g)?.join(" ") ?? "";
}

function encodeKeyPair(keyPair: LibomemoKeyPair): Buffer {
  const value = requireKeyPair(keyPair);
  const publicKey = Buffer.from(value.pubKey);
  const privateKey = Buffer.from(value.privKey);
  const encoded = Buffer.alloc(1 + PUBLIC_KEY_BYTES + PRIVATE_KEY_BYTES);
  encoded[0] = KEY_PAIR_VERSION;
  publicKey.copy(encoded, 1);
  privateKey.copy(encoded, 1 + PUBLIC_KEY_BYTES);
  return encoded;
}

function decodeKeyPair(encoded: Uint8Array): LibomemoKeyPair {
  if (encoded.byteLength !== 1 + PUBLIC_KEY_BYTES + PRIVATE_KEY_BYTES || encoded[0] !== KEY_PAIR_VERSION) {
    throw new Error("Corrupt OMEMO key-pair record.");
  }
  const value = Buffer.from(encoded);
  const pubKey = value.subarray(1, 1 + PUBLIC_KEY_BYTES);
  const privKey = value.subarray(1 + PUBLIC_KEY_BYTES);
  return { pubKey: toArrayBuffer(pubKey), privKey: toArrayBuffer(privKey) };
}

function requireKeyPair(value: unknown): LibomemoKeyPair {
  if (!value || typeof value !== "object") throw new Error("Invalid OMEMO key pair.");
  const candidate = value as Partial<LibomemoKeyPair>;
  if (!(candidate.pubKey instanceof ArrayBuffer) || candidate.pubKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error("Invalid OMEMO public key length.");
  }
  if (!(candidate.privKey instanceof ArrayBuffer) || candidate.privKey.byteLength !== PRIVATE_KEY_BYTES) {
    throw new Error("Invalid OMEMO private key length.");
  }
  if (new Uint8Array(candidate.pubKey)[0] !== 0x05) throw new Error("Invalid OMEMO public key prefix.");
  return candidate as LibomemoKeyPair;
}

function identityKeyBuffer(value: ArrayBuffer): Buffer {
  if (!(value instanceof ArrayBuffer) || (value.byteLength !== 32 && value.byteLength !== PUBLIC_KEY_BYTES)) {
    throw new Error("Invalid OMEMO identity key length.");
  }
  const key = Buffer.from(value);
  if (key.byteLength === PUBLIC_KEY_BYTES && key[0] !== 0x05) {
    throw new Error("Invalid OMEMO identity key prefix.");
  }
  return key;
}

function encodeRegistrationId(value: unknown): Buffer {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_REGISTRATION_ID) {
    throw new Error("Invalid OMEMO registration ID.");
  }
  const encoded = Buffer.alloc(2);
  encoded.writeUInt16BE(value as number);
  return encoded;
}

function decodeRegistrationId(encoded: Uint8Array): number {
  if (encoded.byteLength !== 2) throw new Error("Corrupt OMEMO registration ID record.");
  const value = Buffer.from(encoded).readUInt16BE(0);
  if (value > MAX_REGISTRATION_ID) throw new Error("Corrupt OMEMO registration ID record.");
  return value;
}

function normalizeKeyId(value: LibomemoKeyId): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid OMEMO key ID.");
    return String(value);
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\u0000")) {
    throw new Error("Invalid OMEMO key ID.");
  }
  return value;
}

function encodeTrustRecord(record: OmemoTrustRecord): Buffer {
  return Buffer.from(JSON.stringify({
    version: TRUST_RECORD_VERSION,
    state: record.state,
    fingerprint: record.fingerprint,
    firstObservedAt: record.firstObservedAt,
    lastObservedAt: record.lastObservedAt
  }), "utf8");
}

function decodeTrustRecord(encoded: Uint8Array): OmemoTrustRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(encoded));
  } catch {
    throw new Error("Corrupt OMEMO trust record encoding.");
  }
  if (!value || typeof value !== "object") throw new Error("Corrupt OMEMO trust record.");
  const record = value as Record<string, unknown>;
  validateTrustState(record.state);
  if (record.version !== TRUST_RECORD_VERSION || typeof record.fingerprint !== "string" ||
      !/^[0-9a-f]{8}( [0-9a-f]{8}){7}$/.test(record.fingerprint) ||
      !Number.isSafeInteger(record.firstObservedAt) || !Number.isSafeInteger(record.lastObservedAt) ||
      (record.firstObservedAt as number) < 0 || (record.lastObservedAt as number) < (record.firstObservedAt as number)) {
    throw new Error("Corrupt OMEMO trust record.");
  }
  return {
    state: record.state,
    fingerprint: record.fingerprint,
    firstObservedAt: record.firstObservedAt as number,
    lastObservedAt: record.lastObservedAt as number
  };
}

function validateTrustState(value: unknown): asserts value is OmemoTrustState {
  if (value !== "undecided" && value !== "trusted" && value !== "verified" &&
      value !== "distrusted" && value !== "retired") {
    throw new Error("Invalid OMEMO trust state.");
  }
}

function validateDirection(value: number): asserts value is LibomemoDirection {
  if (value !== 1 && value !== 2) throw new Error("Invalid OMEMO message direction.");
}

function validateAddress(value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 || value.includes("\u0000")) {
    throw new Error("Invalid OMEMO address.");
  }
}

function validateDeviceAddress(value: string): void {
  validateAddress(value);
  const separator = value.lastIndexOf(".");
  const deviceId = value.slice(separator + 1);
  if (separator < 1 || !/^(0|[1-9]\d*)$/.test(deviceId) || !Number.isSafeInteger(Number(deviceId))) {
    throw new Error("Invalid libomemo.js device address.");
  }
}

function validTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid OMEMO observation timestamp.");
  return value;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer;
}

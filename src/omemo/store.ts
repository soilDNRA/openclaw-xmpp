import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, openSync, readFileSync, writeFileSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export type OmemoRecordKind =
  | "identity"
  | "prekey"
  | "signed-prekey"
  | "session"
  | "trust"
  | "candidate"
  | "device";

export interface PendingOutbound {
  id: string;
  recipient: string;
  stanza: Buffer;
  createdAt: number;
}

export interface PendingInbound {
  id: string;
  sender: string;
  plaintext: Buffer;
  createdAt: number;
}

export class OmemoRecordView {
  readonly #records: Map<string, Buffer>;

  constructor(records: Map<string, Buffer>) {
    this.#records = records;
  }

  get(kind: OmemoRecordKind, key: string): Buffer | undefined {
    const value = this.#records.get(recordKey(kind, key));
    return value ? Buffer.from(value) : undefined;
  }

  set(kind: OmemoRecordKind, key: string, value: Uint8Array): void {
    validateKey(key);
    if (value.byteLength === 0) throw new Error("OMEMO records must not be empty.");
    this.#records.set(recordKey(kind, key), Buffer.from(value));
  }

  delete(kind: OmemoRecordKind, key: string): void {
    this.#records.delete(recordKey(kind, key));
  }

  entries(): IterableIterator<[string, Buffer]> {
    return this.#records.entries();
  }
}

export interface OmemoStoreOptions {
  stateDirectory: string;
  clock?: () => number;
  /** Test-only crash/fault injection; production callers must omit this. */
  faultInjector?: (point: "before-commit" | "after-commit") => void;
}

/**
 * Crash-consistent persistence boundary for OMEMO ratchet operations.
 *
 * libomemo callbacks mutate only the supplied in-memory view. State and the
 * exact outbound stanza or encrypted pending inbound delivery are then
 * committed together. Callers may send/dispatch only after the method returns.
 */
export class OmemoTransactionalStore {
  readonly #db: DatabaseSync;
  readonly #key: Buffer;
  readonly #clock: () => number;
  readonly #faultInjector: OmemoStoreOptions["faultInjector"];
  #tail: Promise<void> = Promise.resolve();

  constructor(options: OmemoStoreOptions) {
    mkdirSync(options.stateDirectory, { recursive: true, mode: 0o700 });
    chmodSync(options.stateDirectory, 0o700);
    const keyPath = join(options.stateDirectory, "pending-delivery.key");
    this.#key = loadOrCreateKey(keyPath);
    const databasePath = join(options.stateDirectory, "omemo.sqlite");
    this.#db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.#clock = options.clock ?? Date.now;
    this.#faultInjector = options.faultInjector;
    this.#initialize();
  }

  close(): void {
    this.#db.close();
    this.#key.fill(0);
  }

  async outbound(
    account: string,
    id: string,
    recipient: string,
    operation: (view: OmemoRecordView) => Promise<Uint8Array>
  ): Promise<PendingOutbound> {
    return this.#serialize(async () => {
      const records = this.#loadRecords(account);
      const stanza = Buffer.from(await operation(new OmemoRecordView(records)));
      if (stanza.byteLength === 0) throw new Error("OMEMO outbound stanza must not be empty.");
      const createdAt = this.#clock();
      this.#transaction(() => {
        this.#replaceRecords(account, records, createdAt);
        this.#db.prepare(
          "INSERT INTO outbox(account, id, recipient, stanza, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(account, id, recipient, stanza, createdAt);
      });
      return { id, recipient, stanza, createdAt };
    });
  }

  async inbound(
    account: string,
    id: string,
    sender: string,
    operation: (view: OmemoRecordView) => Promise<Uint8Array>
  ): Promise<PendingInbound> {
    return this.#serialize(async () => {
      const duplicate = this.#db.prepare(
        "SELECT 1 AS found FROM inbox WHERE account = ? AND id = ?"
      ).get(account, id) as { found: number } | undefined;
      if (duplicate) throw new Error("OMEMO inbound delivery is already pending.");
      const records = this.#loadRecords(account);
      const plaintext = Buffer.from(await operation(new OmemoRecordView(records)));
      const sealed = seal(this.#key, plaintext);
      const createdAt = this.#clock();
      this.#transaction(() => {
        this.#replaceRecords(account, records, createdAt);
        this.#db.prepare(
          "INSERT INTO inbox(account, id, sender, sealed_plaintext, created_at) VALUES (?, ?, ?, ?, ?)"
        ).run(account, id, sender, sealed, createdAt);
      });
      return { id, sender, plaintext, createdAt };
    });
  }

  /** Commit non-delivery state changes such as key initialization or trust decisions. */
  async updateRecords<T>(
    account: string,
    operation: (view: OmemoRecordView) => Promise<T> | T
  ): Promise<T> {
    return this.#serialize(async () => {
      const records = this.#loadRecords(account);
      const result = await operation(new OmemoRecordView(records));
      const updatedAt = this.#clock();
      this.#transaction(() => this.#replaceRecords(account, records, updatedAt));
      return result;
    });
  }

  listOutbound(account: string): PendingOutbound[] {
    const rows = this.#db.prepare(
      "SELECT id, recipient, stanza, created_at FROM outbox WHERE account = ? ORDER BY created_at, id"
    ).all(account) as Array<{ id: string; recipient: string; stanza: Uint8Array; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      recipient: row.recipient,
      stanza: Buffer.from(row.stanza),
      createdAt: row.created_at
    }));
  }

  listInbound(account: string): PendingInbound[] {
    const rows = this.#db.prepare(
      "SELECT id, sender, sealed_plaintext, created_at FROM inbox WHERE account = ? ORDER BY created_at, id"
    ).all(account) as Array<{ id: string; sender: string; sealed_plaintext: Uint8Array; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      sender: row.sender,
      plaintext: open(this.#key, Buffer.from(row.sealed_plaintext)),
      createdAt: row.created_at
    }));
  }

  acknowledgeOutbound(account: string, id: string): void {
    this.#db.prepare("DELETE FROM outbox WHERE account = ? AND id = ?").run(account, id);
  }

  acknowledgeInbound(account: string, id: string): void {
    this.#db.prepare("DELETE FROM inbox WHERE account = ? AND id = ?").run(account, id);
  }

  integrityCheck(): void {
    const row = this.#db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    if (row?.integrity_check !== "ok") throw new Error("OMEMO state database integrity check failed.");
  }

  #initialize(): void {
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records(
        account TEXT NOT NULL, kind TEXT NOT NULL, record_key TEXT NOT NULL,
        value BLOB NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(account, kind, record_key)
      );
      CREATE TABLE IF NOT EXISTS outbox(
        account TEXT NOT NULL, id TEXT NOT NULL, recipient TEXT NOT NULL,
        stanza BLOB NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(account, id)
      );
      CREATE TABLE IF NOT EXISTS inbox(
        account TEXT NOT NULL, id TEXT NOT NULL, sender TEXT NOT NULL,
        sealed_plaintext BLOB NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(account, id)
      );
    `);
    const version = this.#db.prepare("SELECT value FROM metadata WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (!version) {
      this.#db.prepare("INSERT INTO metadata(key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
    } else if (version.value !== String(SCHEMA_VERSION)) {
      throw new Error(`Unsupported OMEMO state schema version: ${version.value}`);
    }
    this.integrityCheck();
  }

  #loadRecords(account: string): Map<string, Buffer> {
    const rows = this.#db.prepare(
      "SELECT kind, record_key, value FROM records WHERE account = ?"
    ).all(account) as Array<{ kind: OmemoRecordKind; record_key: string; value: Uint8Array }>;
    return new Map(rows.map((row) => [recordKey(row.kind, row.record_key), Buffer.from(row.value)]));
  }

  #replaceRecords(account: string, records: Map<string, Buffer>, now: number): void {
    this.#db.prepare("DELETE FROM records WHERE account = ?").run(account);
    const insert = this.#db.prepare(
      "INSERT INTO records(account, kind, record_key, value, updated_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const [combined, value] of records) {
      const separator = combined.indexOf("\u0000");
      insert.run(account, combined.slice(0, separator), combined.slice(separator + 1), value, now);
    }
  }

  #transaction(operation: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      operation();
      this.#faultInjector?.("before-commit");
      this.#db.exec("COMMIT");
      committed = true;
      this.#faultInjector?.("after-commit");
    } catch (error) {
      if (!committed) this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

function recordKey(kind: OmemoRecordKind, key: string): string {
  validateKey(key);
  return `${kind}\u0000${key}`;
}

function validateKey(key: string): void {
  if (!key || key.includes("\u0000") || key.length > 1024) throw new Error("Invalid OMEMO record key.");
}

function loadOrCreateKey(path: string): Buffer {
  try {
    const key = readFileSync(path);
    if (key.byteLength !== KEY_BYTES) throw new Error("Invalid OMEMO pending-delivery key length.");
    chmodSync(path, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const descriptor = openSync(path, "wx", 0o600);
    try {
      const key = randomBytes(KEY_BYTES);
      writeFileSync(descriptor, key);
      return key;
    } finally {
      closeSync(descriptor);
    }
  }
}

function seal(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function open(key: Buffer, sealed: Buffer): Buffer {
  if (sealed.byteLength < NONCE_BYTES + TAG_BYTES) throw new Error("Corrupt OMEMO pending delivery.");
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("OMEMO pending delivery authentication failed.");
  }
}

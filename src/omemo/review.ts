import { randomBytes } from "node:crypto";
import type { OmemoExpectedTrust } from "./libomemo-store.js";
import type { OmemoTrustInspection } from "./operator.js";

interface Ticket {
  owner: string;
  address: string;
  expected: OmemoExpectedTrust;
  expiresAt: number;
}

/** Session-local approval capabilities. Restart invalidates all outstanding codes. */
export class OmemoReviewTickets {
  readonly #tickets = new Map<string, Ticket>();
  constructor(readonly clock: () => number = Date.now) {}

  issue(owner: string, records: OmemoTrustInspection[]) {
    if (!owner || owner.length > 1024) throw new Error("Authenticated reviewer identity is required.");
    this.#prune();
    // Refresh invalidates this reviewer's previous snapshot, keeping memory bounded.
    for (const [code, ticket] of this.#tickets) if (ticket.owner === owner) this.#tickets.delete(code);
    const pending = records.filter((record) => record.state === "undecided" && !record.candidate);
    if (this.#tickets.size + pending.length > 256) throw new Error("Too many pending OMEMO reviews.");
    return pending.map((record) => {
      const code = randomBytes(12).toString("base64url");
      const ticket: Ticket = { owner, address: record.address,
        expected: { state: record.state, fingerprint: record.fingerprint },
        expiresAt: this.clock() + 10 * 60_000 };
      this.#tickets.set(code, ticket);
      return { ...record, code, expiresAt: ticket.expiresAt, action: "trusted" as const };
    });
  }

  consume(owner: string, code: string): Ticket {
    this.#prune();
    const ticket = this.#tickets.get(code);
    if (!ticket || ticket.owner !== owner) throw new Error("Invalid, expired, or mismatched OMEMO review code; request a fresh review.");
    // Consume before awaiting the CAS: concurrent or failed reuse is forbidden.
    this.#tickets.delete(code);
    return ticket;
  }

  clear() { this.#tickets.clear(); }
  #prune() {
    for (const [code, ticket] of this.#tickets) if (ticket.expiresAt <= this.clock()) this.#tickets.delete(code);
  }
}

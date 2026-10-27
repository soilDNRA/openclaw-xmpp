import {
  LibomemoStoreAdapter,
  type OmemoExpectedTrust,
  type OmemoIdentityCandidate,
  type OmemoTrustMode,
  type OmemoTrustRecord,
  type OmemoTrustState
} from "./libomemo-store.js";
import type { OmemoTransactionalStore } from "./store.js";

export interface OmemoTrustInspection extends OmemoTrustRecord {
  address: string;
  candidate?: Omit<OmemoIdentityCandidate, "identityKey">;
}

export class OmemoOperator {
  constructor(
    readonly account: string,
    readonly store: OmemoTransactionalStore,
    readonly trustMode: OmemoTrustMode
  ) {}

  async inspectTrust(): Promise<OmemoTrustInspection[]> {
    return await this.store.updateRecords(this.account, (view) => {
      const adapter = new LibomemoStoreAdapter(view, { mode: this.trustMode });
      const addresses = [...view.entries()]
        .filter(([key]) => key.startsWith("trust\u0000"))
        .map(([key]) => key.slice("trust\u0000".length))
        .sort();
      return addresses.map((address) => {
        const trust = adapter.trust.get(address);
        if (!trust) throw new Error("Corrupt OMEMO trust index.");
        const candidate = adapter.trust.candidate(address);
        return {
          address,
          ...trust,
          ...(candidate ? { candidate: {
            previousFingerprint: candidate.previousFingerprint,
            observedFingerprint: candidate.observedFingerprint,
            observedAt: candidate.observedAt
          } } : {})
        };
      });
    });
  }

  async transition(address: string, expected: OmemoExpectedTrust, nextState: OmemoTrustState): Promise<OmemoTrustRecord> {
    return await this.store.updateRecords(this.account, (view) =>
      new LibomemoStoreAdapter(view, { mode: this.trustMode }).trust.transition(address, expected, nextState));
  }

  async replaceIdentity(
    address: string,
    expected: OmemoExpectedTrust,
    expectedObservedFingerprint: string,
    nextState: OmemoTrustState = "undecided"
  ): Promise<OmemoTrustRecord> {
    return await this.store.updateRecords(this.account, (view) => {
      const trust = new LibomemoStoreAdapter(view, { mode: this.trustMode }).trust;
      const candidate = trust.candidate(address);
      if (!candidate || candidate.previousFingerprint !== expected.fingerprint ||
          candidate.observedFingerprint !== expectedObservedFingerprint) {
        throw new Error("OMEMO identity candidate changed since it was reviewed.");
      }
      return trust.replaceIdentity(
        address, expected, candidate.identityKey, expectedObservedFingerprint, nextState
      );
    });
  }
}

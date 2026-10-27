import { parse as parseXml } from "ltx";
import type { Element } from "@xmpp/xml";

import {
  LEGACY_OMEMO,
  OMEMO_2,
  OmemoEngine,
  type LibomemoEngineBindings,
  type OmemoPublishedBundle,
  type OmemoVersion
} from "./engine.js";
import { LibomemoStoreAdapter, OmemoIdentityChangedError, OmemoTrustError } from "./libomemo-store.js";
import type { OmemoTrustMode } from "./libomemo-store.js";
import type { OmemoExpectedTrust, OmemoTrustState } from "./libomemo-store.js";
import { OmemoOperator, type OmemoTrustInspection } from "./operator.js";
import {
  OmemoInboundCoordinator,
  OmemoOutboundCoordinator,
  type OmemoInboundBindings,
  type OmemoInboundMessage,
  type OmemoOutboundBindings,
  type OmemoRecipientDevices
} from "./message.js";
import type { OmemoTransactionalStore } from "./store.js";
import { parseBundle, parseDeviceList } from "./xml.js";
import { OmemoPepSession, XmppOmemoPepAdapter } from "./xmpp-pep.js";

import { OmemoReviewTickets } from "./review.js";

const RETIRED_DEVICE_PREFIX = "$retired-device:";

export interface OmemoSessionIo {
  send(stanza: Element): Promise<void>;
  dispatch(message: OmemoInboundMessage): Promise<void>;
}

export interface OmemoSessionOptions {
  account: string;
  version: OmemoVersion;
  trustMode: OmemoTrustMode;
  deliveryPolicy?: "strict-all" | "trusted-devices";
  store: OmemoTransactionalStore;
  engineBindings: LibomemoEngineBindings;
  outboundBindings: OmemoOutboundBindings;
  inboundBindings: OmemoInboundBindings;
  pep: XmppOmemoPepAdapter;
}

/**
 * Inactive-by-default assembly of key lifecycle, PEP, session construction,
 * transactional encryption/decryption, and durable delivery recovery.
 */
export class OmemoSession {
  readonly #account: string;
  readonly #version: OmemoVersion;
  readonly #store: OmemoTransactionalStore;
  readonly #engine: OmemoEngine;
  readonly #pep: XmppOmemoPepAdapter;
  readonly #outboundBindings: OmemoOutboundBindings;
  readonly #inboundBindings: OmemoInboundBindings;
  readonly #trustMode: OmemoTrustMode;
  readonly #operator: OmemoOperator;
  #outbound: OmemoOutboundCoordinator | undefined;
  #inbound: OmemoInboundCoordinator | undefined;
  readonly #bundles = new Map<OmemoVersion, OmemoPublishedBundle>();
  #pepSession: OmemoPepSession | undefined;
  #io: OmemoSessionIo | undefined;
  #localDeviceId: number | undefined;
  #retired = false;
  readonly #reviews = new OmemoReviewTickets();
  readonly #noticeAt = new Map<string, number>();
  #sendTail: Promise<unknown> = Promise.resolve();
  readonly deliveryPolicy: "strict-all" | "trusted-devices";
  #excluded: Array<{ address: string; reason: string }> = [];
  get excludedDevices() { return this.#excluded.map((item) => ({ ...item })); }

  constructor(options: OmemoSessionOptions) {
    if (options.version !== LEGACY_OMEMO && options.version !== OMEMO_2) {
      throw new Error("Unsupported OMEMO session profile.");
    }
    this.deliveryPolicy = options.deliveryPolicy ?? "strict-all";
    if (!["strict-all", "trusted-devices"].includes(this.deliveryPolicy)) throw new Error("Invalid OMEMO delivery policy.");
    this.#account = options.account;
    this.#version = options.version;
    this.#store = options.store;
    this.#pep = options.pep;
    this.#outboundBindings = options.outboundBindings;
    this.#inboundBindings = options.inboundBindings;
    this.#trustMode = options.trustMode;
    this.#operator = new OmemoOperator(options.account, options.store, options.trustMode);
    this.#engine = new OmemoEngine({
      account: options.account,
      store: options.store,
      bindings: options.engineBindings,
      trustMode: options.trustMode
    });
  }

  async initialize(io: OmemoSessionIo): Promise<void> {
    if (this.#io) {
      // A full XMPP reconnect binds a new stream on the same transport. Re-run
      // publication and recovery before presence without recreating local key
      // material or rejecting the reconnect as a duplicate initialization.
      this.#io = io;
      await this.#pepSession!.initialize();
      await this.#recover();
      return;
    }
    const bundles = await this.#engine.initialize();
    // Advertise only the explicitly configured profile. The engine retains
    // profile-specific local material, but an unselected profile must not be
    // presented to other clients as supported.
    this.#bundles.set(this.#version, bundles[this.#version]);
    const localDeviceId = bundles[this.#version].deviceId;
    this.#localDeviceId = localDeviceId;
    // Coordinators must use the restart-stable registration ID, not a placeholder.
    this.#outbound = new OmemoOutboundCoordinator({
      account: this.#account, localDeviceId, store: this.#store,
      bindings: this.#outboundBindings, trustMode: this.#trustMode, requireTrustedTargets: true
    });
    this.#inbound = new OmemoInboundCoordinator({
      account: this.#account, localDeviceId, store: this.#store,
      bindings: this.#inboundBindings, trustMode: this.#trustMode,
      refreshBundle: async (version) => await this.#refreshBundle(version)
    });
    this.#retired = await this.#store.updateRecords(this.#account, (view) => {
      const marker = view.get("device", `${RETIRED_DEVICE_PREFIX}${this.#version}`);
      if (!marker) return false;
      if (new TextDecoder("utf-8", { fatal: true }).decode(marker) !== String(localDeviceId)) {
        throw new Error("Corrupt OMEMO retired-device marker.");
      }
      return true;
    });
    this.#pepSession = new OmemoPepSession(
      this.#pep,
      this.#bundles,
      new Map(),
      this.#retired ? new Set([this.#version]) : new Set()
    );
    await this.#pepSession.initialize();
    // Complete an interrupted deactivation before presence. The durable marker
    // is written before the remote mutation, so a crash cannot republish a
    // device that the operator intended to retire.
    if (this.#retired) await this.#pepSession.retire(this.#version, localDeviceId);
    this.#io = io;
    await this.#recover();
  }

  async handleStanza(stanza: Element): Promise<boolean> {
    if (await this.#pepSession?.handleEvent(stanza)) return true;
    const encrypted = stanza.is("message") && (
      stanza.getChild("encrypted", LEGACY_OMEMO) !== undefined ||
      stanza.getChild("encrypted", OMEMO_2) !== undefined
    );
    // Connection-level stanzas can arrive after bind but before PEP
    // initialization completes. Consume encrypted traffic fail-closed during
    // that window instead of attempting plaintext handling or throwing.
    if (encrypted && !this.#io) return true;
    if (encrypted) {
      await this.#requireInbound().decryptAndDispatch(stanza, this.#requireIo().dispatch);
      return true;
    }
    // Once enabled, an ordinary body must never silently enter OpenClaw as a
    // fallback for an undecryptable or unencrypted chat message.
    return stanza.is("message") && stanza.getChild("body") !== undefined;
  }

  async sendText(to: string, text: string): Promise<string> {
    const result = this.#sendTail.then(() => this.#sendText(to, text));
    this.#sendTail = result.catch(() => undefined);
    return await result;
  }

  async #sendText(to: string, text: string): Promise<string> {
    if (this.#retired) throw new Error("OMEMO local device is retired; restart with OMEMO disabled.");
    const io = this.#requireIo();
    const recipients = await this.#resolveRecipients(to);
    const pending = this.#excluded.filter((item) => item.reason === "undecided").length;
    const notice = pending > 0 && Date.now() - (this.#noticeAt.get(to) ?? 0) >= 10 * 60_000;
    const outgoingText = notice ? `${text}\n\n[OMEMO: ${pending} new device(s) awaiting approval and excluded from this encrypted reply. Review devices in the Gateway admin interface or use /xmpp-omemo review on an authenticated owner channel.]` : text;
    const result = await this.#requireOutbound().encryptAndSend({
      to, text: outgoingText, version: this.#version, recipients, send: io.send
    });
    if (notice) {
      if (this.#noticeAt.size >= 128) this.#noticeAt.delete(this.#noticeAt.keys().next().value!);
      this.#noticeAt.set(to, Date.now());
    }
    return result.id;
  }

  /** Replay committed deliveries after XEP-0198 resumes the existing stream. */
  async resume(io: OmemoSessionIo): Promise<void> {
    if (!this.#io) throw new Error("OMEMO session is not initialized.");
    this.#io = io;
    await this.#recover();
  }

  async inspectTrust(): Promise<OmemoTrustInspection[]> {
    return await this.#operator.inspectTrust();
  }

  async reviewPending(owner: string) {
    return this.#reviews.issue(owner, await this.inspectTrust());
  }

  async approveReview(owner: string, code: string) {
    const ticket = this.#reviews.consume(owner, code);
    return await this.#store.updateRecords(this.#account, (view) => {
      const trust = new LibomemoStoreAdapter(view, { mode: this.#trustMode }).trust;
      if (trust.candidate(ticket.address)) throw new Error("OMEMO identity changed since review; explicit replacement review is required.");
      return trust.transition(ticket.address, ticket.expected, "trusted");
    });
  }

  async transitionTrust(
    address: string,
    expected: OmemoExpectedTrust,
    nextState: OmemoTrustState
  ) {
    return await this.#operator.transition(address, expected, nextState);
  }

  async replaceIdentity(
    address: string,
    expected: OmemoExpectedTrust,
    observedFingerprint: string,
    nextState: OmemoTrustState
  ) {
    return await this.#operator.replaceIdentity(address, expected, observedFingerprint, nextState);
  }

  /** Retire only the exact initialized local device; local keys remain for rollback. */
  async retireLocalDevice(version: OmemoVersion, expectedDeviceId: number): Promise<void> {
    if (!this.#io || !this.#pepSession || this.#localDeviceId === undefined) {
      throw new Error("OMEMO session is not initialized.");
    }
    if (version !== this.#version || expectedDeviceId !== this.#localDeviceId) {
      throw new Error("OMEMO retirement target does not match the active local device.");
    }
    await this.#store.updateRecords(this.#account, (view) => {
      view.set("device", `${RETIRED_DEVICE_PREFIX}${version}`, Buffer.from(String(expectedDeviceId), "utf8"));
    });
    this.#retired = true;
    await this.#pepSession.retire(version, expectedDeviceId);
  }

  async activateLocalDevice(version: OmemoVersion, expectedDeviceId: number): Promise<void> {
    if (!this.#io || !this.#pepSession || this.#localDeviceId === undefined) {
      throw new Error("OMEMO session is not initialized.");
    }
    if (version !== this.#version || expectedDeviceId !== this.#localDeviceId) {
      throw new Error("OMEMO activation target does not match the active local device.");
    }
    if (!this.#retired) throw new Error("OMEMO local device is already active.");
    await this.#pepSession.activate(version, expectedDeviceId);
    await this.#store.updateRecords(this.#account, (view) => {
      view.delete("device", `${RETIRED_DEVICE_PREFIX}${version}`);
    });
    this.#retired = false;
  }

  close(): void {
    this.#reviews.clear();
    this.#store.close();
    this.#io = undefined;
    this.#pepSession = undefined;
    this.#outbound = undefined;
    this.#inbound = undefined;
  }

  async #resolveRecipients(to: string): Promise<OmemoRecipientDevices[]> {
    const result: OmemoRecipientDevices[] = [];
    this.#excluded = [];
    let inspected = 0;
    for (const jid of [...new Set([to, this.#account])]) {
      const adapter = jid === this.#account ? this.#pep : new XmppOmemoPepAdapter(jid, this.#pep.iq);
      const item = await adapter.fetchDeviceList(this.#version);
      if (!item?.payload) throw new Error(`OMEMO device list is unavailable for ${jid}.`);
      const devices = parseDeviceList(this.#version, item.payload);
      const selected: number[] = [];
      for (const device of devices) {
        if (jid === this.#account && device.id === this.#localDeviceId) continue;
        if (++inspected > 128) throw new Error("OMEMO device discovery limit exceeded (128).");
        const address = `${jid}.${device.id}`;
        // Corruption and already observed replacements remain hard failures,
        // even if the device subsequently removes its bundle.
        await this.#store.updateRecords(this.#account, (view) => {
          const trust = new LibomemoStoreAdapter(view, { mode: this.#trustMode }).trust;
          const current = trust.get(address);
          const candidate = trust.candidate(address);
          if (candidate) throw new OmemoIdentityChangedError(address, current!.fingerprint, candidate.observedFingerprint);
        });
        // Refresh advertised identities even with a cached session: a known
        // replacement must never become an ordinary excluded/unknown device.
        const bundle = await adapter.fetchBundle(this.#version, device.id);
        if (!bundle?.payload) {
          if (this.deliveryPolicy === "strict-all") throw new Error(`OMEMO bundle is unavailable for ${address}.`);
          this.#excluded.push({ address, reason: "bundle-unavailable" });
          continue;
        }
        const parsed = parseBundle(this.#version, device.id, bundle.payload);
        await this.#engine.observeIdentity(address, parsed.identityKey);
        const record = await this.#store.updateRecords(this.#account, (view) => {
          const trust = new LibomemoStoreAdapter(view, { mode: this.#trustMode }).trust;
          const current = trust.get(address)!;
          const candidate = trust.candidate(address);
          if (candidate) throw new OmemoIdentityChangedError(address, current.fingerprint, candidate.observedFingerprint);
          return current;
        });
        if (record.state !== "trusted" && record.state !== "verified") {
          this.#excluded.push({ address, reason: record.state });
          if (this.deliveryPolicy === "strict-all") throw new OmemoTrustError(address, record.state, record.fingerprint, 1);
          continue;
        }
        if (!await this.#engine.hasSession(address)) {
          await this.#engine.buildSession(address, this.#version, parsed);
        }
        selected.push(device.id);
      }
      result.push({ jid, deviceIds: selected });
    }
    if (!result.some((item) => item.jid === to && item.deviceIds.length > 0)) {
      throw new Error("OMEMO delivery blocked: recipient has no trusted devices; review pending identities in the admin interface.");
    }
    return result;
  }

  async #refreshBundle(version: OmemoVersion): Promise<void> {
    const bundles = await this.#engine.maintainKeys();
    this.#bundles.set(version, bundles[version]);
    await new OmemoPepSession(this.#pep, new Map([[version, bundles[version]]])).initialize();
  }

  async #recover(): Promise<void> {
    const io = this.#requireIo();
    for (const pending of this.#store.listOutbound(this.#account)) {
      const stanza = parseXml(new TextDecoder("utf-8", { fatal: true }).decode(pending.stanza)) as Element;
      await io.send(stanza);
      this.#store.acknowledgeOutbound(this.#account, pending.id);
    }
    await this.#requireInbound().dispatchPending(async (message) => await io.dispatch({
      ...message, version: this.#version, senderDeviceId: 0
    }));
  }

  #requireIo(): OmemoSessionIo {
    if (!this.#io) throw new Error("OMEMO session is not initialized.");
    return this.#io;
  }

  #requireOutbound(): OmemoOutboundCoordinator {
    if (!this.#outbound) throw new Error("OMEMO session is not initialized.");
    return this.#outbound;
  }

  #requireInbound(): OmemoInboundCoordinator {
    if (!this.#inbound) throw new Error("OMEMO session is not initialized.");
    return this.#inbound;
  }
}

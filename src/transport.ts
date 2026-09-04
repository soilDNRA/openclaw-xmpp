import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { client, xml } from "@xmpp/client";
import type { Client, Options as XmppClientOptions } from "@xmpp/client";
import type { Element } from "@xmpp/xml";

import type { XmppConnectionConfig } from "./config.js";
import { ExpiringDedupe } from "./dedupe.js";
import {
  discoverUploadService,
  requestUploadSlot,
  safeUploadFilename,
  uploadBuffer
} from "./media.js";
import {
  buildChatState,
  buildReceipt,
  buildTextMessage,
  parseInboundMessage,
  type InboundXmppMessage,
  type SharedFileMetadata
} from "./stanzas.js";

export interface XmppTransportStatus {
  connected: boolean;
  phase: "starting" | "online" | "degraded" | "reconnecting" | "stopped" | "failed";
  boundJid?: string;
  lastConnectedAt?: number;
  lastDisconnectedAt?: number;
  lastInboundAt?: number;
  lastOutboundAt?: number;
  lastError?: string | undefined;
  reconnectAttempts?: number;
  lastReconnectedAt?: number;
  streamManagement?: "enabled" | "resumed" | "failed" | "unavailable";
  lastProbeAt?: number;
  lastProbeSuccessAt?: number;
  lastProbeLatencyMs?: number;
  probeFailures?: number;
  lastProbeResult?: "success" | "timeout" | "unsupported" | "aborted" | "error";
}

export interface XmppTransportHandlers {
  onMessage(message: InboundXmppMessage): Promise<void>;
  onStatus(status: XmppTransportStatus): void;
  log: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
  };
}

interface XmppClientExtensions {
  reconnect?: { delay: number; on(event: string, listener: () => void): void; removeListener(event: string, listener: () => void): void };
  streamManagement?: { enabled?: boolean; on(event: string, listener: (...args: unknown[]) => void): void; removeListener(event: string, listener: (...args: unknown[]) => void): void };
  iqCaller?: { request(stanza: Element, timeout?: number): Promise<Element> };
}

export interface SendMediaInput {
  to: string;
  text: string;
  mediaUrl: string;
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  contentType?: string;
  signal?: AbortSignal;
}

export interface SentXmppMessage {
  id: string;
  to: string;
  url?: string;
}

type XmppCredentialsFactory = Extract<
  NonNullable<XmppClientOptions["credentials"]>,
  (...args: never[]) => unknown
>;

function errorText(error: unknown, password?: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const sanitized = password ? raw.split(password).join("[redacted]") : raw;
  return sanitized.replace(/\s+/g, " ").slice(0, 500);
}

function localPathFromMediaUrl(mediaUrl: string): string | undefined {
  try {
    const parsed = new URL(mediaUrl);
    if (parsed.protocol === "file:") {
      return fileURLToPath(parsed);
    }
    return undefined;
  } catch {
    return mediaUrl.startsWith("/") ? mediaUrl : undefined;
  }
}

function inferContentType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".ogg") || lower.endsWith(".opus")) return "audio/ogg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  return "application/octet-stream";
}

function remoteFilename(url: URL): string {
  try {
    return safeUploadFilename(decodeURIComponent(url.pathname));
  } catch {
    return safeUploadFilename(url.pathname);
  }
}

export function createTlsRequiredCredentials(
  config: Pick<XmppConnectionConfig, "username" | "password">
): XmppCredentialsFactory {
  return async (authenticate, mechanisms, _fast, entity) => {
    if (!entity.isSecure()) {
      throw new Error("XMPP TLS is required before authentication.");
    }
    const mechanism = mechanisms.find((candidate) => candidate !== "ANONYMOUS");
    if (!mechanism) {
      throw new Error("The XMPP server offered no supported authenticated SASL mechanism.");
    }
    await authenticate(
      {
        username: config.username,
        password: config.password
      },
      mechanism,
      xml("user-agent", { id: randomUUID() })
    );
  };
}

export class XmppTransport {
  readonly #xmpp: Client;
  readonly #dedupe = new ExpiringDedupe();
  #status: XmppTransportStatus = { connected: false, phase: "starting" };
  #uploadService: string | undefined;
  #stopped = false;
  #probeTimer: ReturnType<typeof setTimeout> | undefined;
  #probeInFlight = false;
  readonly #onReconnecting = () => {
    this.#clearProbeTimer();
    this.#updateStatus({
      connected: false,
      phase: "reconnecting",
      reconnectAttempts: (this.#status.reconnectAttempts ?? 0) + 1
    });
  };
  readonly #onReconnected = () => {
    this.#updateStatus({ lastReconnectedAt: Date.now() });
  };
  readonly #onResumed = () => {
    this.#updateStatus({
      connected: true,
      phase: "online",
      lastReconnectedAt: Date.now(),
      streamManagement: "resumed",
      lastError: undefined
    });
    this.#scheduleProbe();
  };
  readonly #onStreamManagementFail = () => {
    this.#updateStatus({ streamManagement: "failed" });
  };

  constructor(
    readonly config: XmppConnectionConfig,
    private readonly handlers: XmppTransportHandlers
  ) {
    this.#xmpp = client({
      service: config.service,
      domain: config.domain,
      resource: config.resource,
      credentials: createTlsRequiredCredentials(config),
      timeout: 15_000
    });
    const extensions = this.#extensions();
    if (extensions.reconnect) {
      extensions.reconnect.delay = config.reconnectDelayMs;
      extensions.reconnect.on("reconnecting", this.#onReconnecting);
      extensions.reconnect.on("reconnected", this.#onReconnected);
    }
    if (extensions.streamManagement) {
      extensions.streamManagement.on("resumed", this.#onResumed);
      extensions.streamManagement.on("fail", this.#onStreamManagementFail);
    }
    this.#xmpp.on("error", (error) => {
      const message = errorText(error, config.password);
      this.#updateStatus({ lastError: message });
      handlers.log.error(`[${config.accountId}] XMPP error: ${message}`);
    });
    this.#xmpp.on("status", (status) => {
      handlers.log.debug?.(`[${config.accountId}] XMPP status: ${status}`);
    });
    this.#xmpp.on("online", async (address) => {
      if (!this.#xmpp.isSecure()) {
        const message = "XMPP connection did not negotiate TLS; closing.";
        this.#updateStatus({ connected: false, lastError: message });
        handlers.log.error(`[${config.accountId}] ${message}`);
        await this.#xmpp.stop().catch(() => undefined);
        return;
      }
      const boundJid = address.toString();
      const recoveredWithFullBind = (this.#status.reconnectAttempts ?? 0) > 0;
      this.#updateStatus({
        connected: true,
        phase: "online",
        boundJid,
        lastConnectedAt: Date.now(),
        reconnectAttempts: 0,
        streamManagement: recoveredWithFullBind
          ? "failed"
          : extensions.streamManagement?.enabled
            ? "enabled"
            : "unavailable",
        lastError: undefined
      });
      handlers.log.info(`[${config.accountId}] XMPP connected as ${boundJid}`);
      await this.#xmpp.send(xml("presence"));
      this.#scheduleProbe();
    });
    this.#xmpp.on("disconnect", () => {
      this.#clearProbeTimer();
      this.#uploadService = undefined;
      this.#updateStatus({
        connected: false,
        phase: this.#stopped ? "stopped" : "reconnecting",
        lastDisconnectedAt: Date.now()
      });
    });
    this.#xmpp.on("stanza", (stanza) => {
      void this.#handleStanza(stanza);
    });
  }

  get status(): XmppTransportStatus {
    return { ...this.#status };
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = () => {
      void this.stop();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      try {
        await this.#xmpp.start();
      } catch (error) {
        this.#updateStatus({
          connected: false,
          phase: "failed",
          lastError: errorText(error, this.config.password)
        });
        throw error;
      }
      if (!this.#xmpp.isSecure()) {
        throw new Error("XMPP TLS negotiation was required but did not succeed.");
      }
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    } finally {
      signal.removeEventListener("abort", stop);
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#clearProbeTimer();
    const extensions = this.#extensions();
    extensions.reconnect?.removeListener("reconnecting", this.#onReconnecting);
    extensions.reconnect?.removeListener("reconnected", this.#onReconnected);
    extensions.streamManagement?.removeListener("resumed", this.#onResumed);
    extensions.streamManagement?.removeListener("fail", this.#onStreamManagementFail);
    await this.#xmpp.stop().catch(() => undefined);
    this.#updateStatus({
      connected: false,
      phase: "stopped",
      lastDisconnectedAt: Date.now()
    });
  }

  async probe(signal?: AbortSignal): Promise<XmppTransportStatus["lastProbeResult"]> {
    if (!this.config.healthProbe || this.#probeInFlight) {
      return this.#status.lastProbeResult;
    }
    this.#assertConnected();
    const extensions = this.#extensions();
    if (!extensions.iqCaller) {
      this.#recordProbe("unsupported");
      return "unsupported";
    }
    this.#probeInFlight = true;
    const startedAt = Date.now();
    this.#updateStatus({ lastProbeAt: startedAt });
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const races: Promise<unknown>[] = [
        extensions.iqCaller.request(
          xml("iq", { type: "get", to: this.config.domain },
            xml("ping", { xmlns: "urn:xmpp:ping" }))
          , this.config.healthProbeTimeoutMs
        ),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            reject(new Error("XMPP health probe timed out."));
          }, this.config.healthProbeTimeoutMs);
          timeout.unref?.();
        })
      ];
      if (signal) {
        races.push(new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("XMPP health probe aborted."));
          signal.addEventListener("abort", onAbort, { once: true });
        }));
      }
      await Promise.race(races);
      this.#recordProbe("success", Date.now() - startedAt);
      return "success";
    } catch (error) {
      const text = errorText(error, this.config.password).toLowerCase();
      const result = signal?.aborted
        ? "aborted"
        : timedOut || text.includes("timeout")
          ? "timeout"
          : /service-unavailable|feature-not-implemented|item-not-found/.test(text)
            ? "unsupported"
            : "error";
      this.#recordProbe(result);
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      this.#probeInFlight = false;
      this.#scheduleProbe();
    }
  }

  async sendText(
    to: string,
    text: string,
    options: {
      requestReceipt?: boolean;
      oobUrl?: string;
      sharedFile?: SharedFileMetadata;
    } = {}
  ): Promise<SentXmppMessage> {
    this.#assertConnected();
    const built = buildTextMessage({
      to,
      text,
      requestReceipt:
        options.requestReceipt ?? this.config.requestReceipts,
      ...(options.oobUrl ? { oobUrl: options.oobUrl } : {}),
      ...(options.sharedFile ? { sharedFile: options.sharedFile } : {})
    });
    await this.#xmpp.send(built.stanza);
    this.#updateStatus({ lastOutboundAt: Date.now() });
    return {
      id: built.id,
      to,
      ...(options.oobUrl ? { url: options.oobUrl } : {})
    };
  }

  async sendReceipt(to: string, id: string): Promise<void> {
    if (!this.config.sendReceipts || !this.#status.connected) {
      return;
    }
    await this.#xmpp.send(buildReceipt({ to, id }));
    this.#updateStatus({ lastOutboundAt: Date.now() });
  }

  async sendChatState(
    to: string,
    state: "active" | "composing" | "paused" | "inactive" | "gone"
  ): Promise<void> {
    if (!this.config.sendChatStates || !this.#status.connected) {
      return;
    }
    await this.#xmpp.send(buildChatState({ to, state }));
  }

  async sendMedia(input: SendMediaInput): Promise<SentXmppMessage> {
    const localPath = localPathFromMediaUrl(input.mediaUrl);
    if (!localPath) {
      const url = new URL(input.mediaUrl);
      if (url.protocol !== "https:") {
        throw new Error("XMPP outbound media must be a local file or HTTPS URL.");
      }
      const name = remoteFilename(url);
      return await this.#sendInlineMedia({
        to: input.to,
        caption: input.text,
        sharedFile: {
          url: url.toString(),
          name,
          mediaType: input.contentType ?? inferContentType(name)
        }
      });
    }
    if (!input.mediaReadFile) {
      throw new Error(
        "OpenClaw did not provide a validated media reader for the local file."
      );
    }
    const buffer = await input.mediaReadFile(localPath);
    if (buffer.byteLength > this.config.mediaMaxBytes) {
      throw new Error(
        `XMPP media exceeds the configured ${Math.floor(
          this.config.mediaMaxBytes / 1024 / 1024
        )} MB limit.`
      );
    }
    const service =
      this.#uploadService ??
      (this.#uploadService = await discoverUploadService(
        this.#xmpp,
        this.config.domain
      ));
    const contentType = input.contentType ?? inferContentType(localPath);
    const slot = await requestUploadSlot({
      xmpp: this.#xmpp,
      serviceJid: service,
      filename: safeUploadFilename(localPath),
      size: buffer.byteLength,
      contentType
    });
    const downloadUrl = await uploadBuffer({
      slot,
      buffer,
      contentType,
      ...(input.signal ? { signal: input.signal } : {})
    });
    const name = safeUploadFilename(localPath);
    return await this.#sendInlineMedia({
      to: input.to,
      caption: input.text,
      sharedFile: {
        url: downloadUrl,
        name,
        mediaType: contentType,
        size: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("base64")
      }
    });
  }

  async #sendInlineMedia(params: {
    to: string;
    caption: string;
    sharedFile: SharedFileMetadata;
  }): Promise<SentXmppMessage> {
    const caption = params.caption.trim();
    if (caption && caption !== params.sharedFile.url) {
      await this.sendText(params.to, caption);
    }
    // Conversations renders XEP-0447 files inline when the ordinary body is
    // the source URL and XEP-0428 marks that body as compatibility fallback.
    return await this.sendText(params.to, params.sharedFile.url, {
      oobUrl: params.sharedFile.url,
      sharedFile: params.sharedFile
    });
  }

  async #handleStanza(stanza: Element): Promise<void> {
    try {
      const message = parseInboundMessage(stanza, this.config.jid);
      if (!message) {
        return;
      }
      const dedupeKey = `${message.fromBare}\u0000${message.id}`;
      if (this.#dedupe.seen(dedupeKey)) {
        this.handlers.log.debug?.(
          `[${this.config.accountId}] dropped duplicate XMPP message ${message.id}`
        );
        return;
      }
      this.#updateStatus({ lastInboundAt: Date.now() });
      await this.handlers.onMessage(message);
    } catch (error) {
      this.handlers.log.error(
        `[${this.config.accountId}] inbound XMPP handling failed: ${errorText(
          error,
          this.config.password
        )}`
      );
    }
  }

  #assertConnected(): void {
    if (!this.#status.connected || this.#xmpp.status !== "online") {
      throw new Error(
        `XMPP account "${this.config.accountId}" is not connected.`
      );
    }
  }

  #extensions(): XmppClientExtensions {
    return this.#xmpp as unknown as XmppClientExtensions;
  }

  #recordProbe(
    result: NonNullable<XmppTransportStatus["lastProbeResult"]>,
    latencyMs?: number
  ): void {
    const successful = result === "success";
    const unsupported = result === "unsupported";
    this.#updateStatus({
      lastProbeResult: result,
      ...(successful ? {
        lastProbeSuccessAt: Date.now(),
        ...(latencyMs !== undefined ? { lastProbeLatencyMs: latencyMs } : {})
      } : {}),
      probeFailures: successful || unsupported ? 0 : (this.#status.probeFailures ?? 0) + 1,
      phase: successful || unsupported
        ? "online"
        : (this.#status.probeFailures ?? 0) + 1 >= 3
          ? "degraded"
          : this.#status.phase
    });
  }

  #scheduleProbe(): void {
    this.#clearProbeTimer();
    if (!this.config.healthProbe || this.#stopped || !this.#status.connected) {
      return;
    }
    this.#probeTimer = setTimeout(() => {
      void this.probe().catch((error) => {
        this.handlers.log.warn(
          `[${this.config.accountId}] XMPP health probe failed: ${errorText(error, this.config.password)}`
        );
      });
    }, this.config.healthProbeIntervalMs);
    this.#probeTimer.unref?.();
  }

  #clearProbeTimer(): void {
    if (this.#probeTimer) {
      clearTimeout(this.#probeTimer);
      this.#probeTimer = undefined;
    }
  }

  #updateStatus(patch: Partial<XmppTransportStatus>): void {
    this.#status = { ...this.#status, ...patch };
    if (patch.lastError === undefined && "lastError" in patch) {
      delete this.#status.lastError;
    }
    this.handlers.onStatus(this.status);
  }
}

const liveTransports = new Map<string, XmppTransport>();

export function registerLiveTransport(
  accountId: string,
  transport: XmppTransport
): () => void {
  liveTransports.set(accountId, transport);
  return () => {
    if (liveTransports.get(accountId) === transport) {
      liveTransports.delete(accountId);
    }
  };
}

export function getLiveTransport(accountId: string): XmppTransport | undefined {
  return liveTransports.get(accountId);
}

export function resetLiveTransportsForTests(): void {
  liveTransports.clear();
}

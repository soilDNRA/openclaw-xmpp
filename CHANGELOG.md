# Changelog

## 0.1.2-beta.2 - 2026-09-10

- Add a bounded, configurable XEP-0199 probe on the existing authenticated
  connection, recording attempts, success, latency, failure state, and
  unsupported-server results while cleaning up every plugin-owned timer and
  listener on disconnect or stop.
- Surface explicit starting, online, degraded, reconnecting, failed, and
  stopped phases together with xmpp.js reconnect attempts and XEP-0198 resume
  or full-rebind outcomes.
- Add secure interactive multi-account onboarding with verified TLS, SRV or
  explicit secure endpoints, environment SecretRefs, explicit direct-message
  policy, normalized bare-JID allowlists, optional probing, connection
  validation before save, and no MUC prompts.
- Expand deterministic coverage for probe concurrency and timeout, lifecycle
  listener cleanup, secure onboarding, bounded health configuration,
  malformed upload slots, failed uploads, HTTPS enforcement, and validated
  media-reader enforcement.

## 0.1.2-beta.1 - 2026-09-09

- Keep the development lockfile source-only and constrain Vitest resolution so
  the packed plugin installs cleanly through OpenClaw's production-only npm
  installer without resolving a conflicting development peer graph.
- Forward the XEP-0363 `Authorization`, `Cookie`, and `Expires` slot headers
  required by authenticated HTTP PUT endpoints, while stripping CR/LF,
  retaining repeated values in order, rejecting every other slot header, and
  excluding authenticated uploads from debug HTTP capture.
- Test the full Gateway account-start path to prove that unavailable TLS is
  refused before credentials or stanzas are sent, and that an env-backed
  SecretRef resolves through authenticated startup and clean shutdown without
  replacing the source configuration with plaintext.
- Complete live interoperability against a second server implementation,
  ejabberd 26.7.0, covering verified TLS, SASL, resource binding, presence,
  bidirectional direct messages, receipts, chat states, replies, and shutdown.
- Correlate XEP-0184 receipts with the sender's message `id`, while continuing
  to use a server-added XEP-0359 `stanza-id` as the stable deduplication key.

## 0.1.1 - 2026-09-05

- Publish the reviewed one-commit prerelease source on canonical SDF Gitea and
  a clearly labelled one-way GitHub mirror, while keeping package publication
  disabled pending the remaining release gates.
- License the project as GNU GPL version 3 or later.
- Record SDF Gitea as the canonical source and issue tracker, with GitHub
  reserved for a clearly labelled one-way mirror.
- Name Eric (`soilDNRA`) as the initial maintainer and select GitHub Private
  Vulnerability Reporting on the future mirror for confidential reports.
- Migrate the canonical project to the OpenClaw 2026.8.2 SDK, replacing the
  removed root SDK and deprecated broad runtime barrels with focused public
  imports while preserving guarded uploads and root-bounded local media reads.
- Advertise the native XMPP `send` action to OpenClaw's shared message tool so
  structured text and media sends use the channel's validated outbound media
  reader and XEP-0363 uploader directly.
- Present outbound media as XEP-0447 inline file shares with XEP-0446 file
  metadata, XEP-0300 SHA-256 integrity hashes for local uploads, and XEP-0428
  fallback indication while retaining XEP-0066 for older clients. Use the
  media URL alone as the fallback body, sending any caption as a preceding
  text stanza, for inline rendering in Conversations.
- Request XEP-0363 upload slots through the full IQ API so responses whose
  `<slot/>` name differs from the `<request/>` name are parsed correctly.
- Recover harmless whole-line Markdown wrappers around legacy `MEDIA:`
  directives in direct-message replies, while leaving inline prose, fenced
  examples, and unsafe media sources untouched.
- Update the prerelease test toolchain to patched Vitest and nanoid releases;
  both production-only and full dependency audits now report no known
  vulnerabilities.

## 0.1.0 - 2026-08-13

- Initial native OpenClaw XMPP direct-message channel.
- Multi-account configuration, TLS transport, pairing/allowlist ingress, typing
  states, delivery receipts, stanza deduplication, and XEP-0363 uploads.
- Configurable outbound text chunking with a conservative 4,000-character
  default, including direct replies to inbound XMPP messages.

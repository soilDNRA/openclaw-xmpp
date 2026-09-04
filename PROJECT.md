# OpenClaw XMPP Project Plan

Last updated: 2026-09-05 (public prerelease source publication)

Status: active, public source prerelease and live soak-test phases

This document is the durable source of truth for the OpenClaw XMPP project.
Consult it before planning or undertaking substantial project work, and update
it whenever the status, evidence, decisions, risks, or next actions change.

## Project goal

Establish a secure, dependable, maintained, and easily discoverable XMPP
channel for OpenClaw. The desired end state is:

1. A standalone channel plugin published through ClawHub.
2. A named maintenance owner or team and a sustainable release process.
3. Inclusion in OpenClaw's official external-channel catalogue so XMPP is
   offered by the standard installer alongside Matrix, Signal, WhatsApp, and
   other external channels.
4. Clear documentation that prevents new users from concluding that OpenClaw
   does not support XMPP.
5. Collaboration or consolidation with credible existing XMPP work where that
   produces a better result than another fragmented implementation.

The project is not primarily about claiming the first XMPP plugin. It is about
delivering the implementation most likely to remain secure, usable, visible,
and maintained.

## Principles

- Security and correct access control take precedence over feature count.
- Prefer a small, well-tested protocol surface over broad but unreliable
  claims.
- Use current public OpenClaw plugin interfaces rather than private internals.
- Keep the public package generic and free of personal JIDs, servers, paths,
  service names, credentials, and deployment details.
- Work constructively with existing maintainers, especially experienced XMPP
  developers.
- Do not contact maintainers, publish code, create public repositories, submit
  packages, or open upstream issues/PRs without the project owner's approval.
- Preserve the retired Python bridge as a rollback option until the native
  plugin has completed its soak test and replacement criteria.
- Treat ordinary real-world use as evidence, but turn every reproducible fault
  into a regression test where practical.

## Current implementation

Repository: `projects/openclaw-xmpp`

Package: `openclaw-xmpp` version `0.1.2-beta.2` (release candidate)

Current OpenClaw development baseline: `2026.8.2`

Current scope:

- Direct messages only.
- Multiple named accounts.
- OpenClaw pairing and bare-JID allowlists.
- Current OpenClaw channel routing, session, ingress, and outbound-message
  machinery.
- Verified TLS with a fail-closed check before SASL authentication.
- OpenClaw SecretRef-compatible passwords.
- XEP-0085 chat states.
- XEP-0184 delivery receipts.
- XEP-0203 delayed-delivery timestamps.
- XEP-0359 origin/stanza IDs and bounded in-memory deduplication.
- XEP-0363 HTTP Upload for outbound local files.
- XEP-0447 Stateless File Sharing with inline disposition and XEP-0446 file
  metadata, including XEP-0300 SHA-256 integrity hashes for local uploads.
- XEP-0066 out-of-band URLs.
- DNS-aware, HTTPS-only guarded uploads and approved local-media roots.
- A discoverable native `send` action for OpenClaw's shared message tool,
  including structured local and remote media fields.

Explicitly out of scope for the initial implementation:

- MUC/group chat.
- OMEMO encryption.
- Reactions, edits, and retractions.
- Inbound file downloading.

These may be added later, but none should be advertised before its protocol,
security, and live interoperability behaviour is tested.

## Verified evidence

As of 2026-09-10:

- The beta.2 source adds a bounded, configurable XEP-0199 probe on the existing
  authenticated connection; explicit reconnect and XEP-0198 lifecycle status;
  and secure interactive multi-account onboarding that records only SecretRefs,
  validates TLS/authentication before save, and requires an explicit DM policy.
- Strict type-checking, all 46 deterministic tests, the production build,
  dependency audits, and the package dry-run pass. The exact 56-file archive
  installs and loads through OpenClaw 2026.9.2 in fresh isolated state, with no
  plugin diagnostics or missing dependencies.
- A private ephemeral ejabberd 26.7.0 rerun passed verified TLS, SASL, binding,
  presence, XEP-0199 probing, bidirectional DMs, receipts, chat state, replies,
  and clean shutdown. Detailed topology and fixture evidence remain outside
  this publishable tree.

As of 2026-09-05:

- Eric separately approved publication of the reviewed prerelease source.
  The public `soilDNRA/openclaw-xmpp` GitHub repository was created as an
  empty, public, one-way mirror with its homepage pointing to canonical SDF
  Gitea. Mirror issues and the wiki are disabled so ordinary development and
  public bug reports remain canonical on SDF.
- GitHub Private Vulnerability Reporting is enabled. Its authenticated API
  reports `enabled: true`, and a logged-out request to the exact advisory URL
  reaches GitHub sign-in rather than a missing page. The confidential route
  was therefore active for GitHub users before source publication.
- A fresh production dependency audit completed successfully with zero known
  vulnerabilities. Source publication is deliberately narrower than package
  release: `private: true` remains set, and no tag, GitHub Release, npm
  package, ClawHub entry, or installer submission is part of this publication.

As of 2026-09-04:

- A clean `npm ci` from the checked-in shrinkwrap succeeds. Fresh pre- and
  post-edit `npm run verify` runs pass strict type-checking, all 32 tests, the
  production build, and package dry-runs.
- The tracked CI workflow exercises the pinned OpenClaw 2026.8.2 baseline on
  Node.js 22.22.3 and Node.js 24, uses `npm ci`, runs the complete verification
  pipeline, and audits production dependencies.
- Compatibility and private vulnerability-reporting policies are now explicit
  in the public documentation. Repository-local migration backups, source
  backups, and retained tarballs were moved to private backup storage rather
  than left beside publishable source.
- The current working tree is free of the known private deployment names,
  JIDs, paths, and network literals. Earlier local commits retain historical
  deployment evidence, so the future public repository must begin from a
  reviewed squashed export rather than publishing this private Git history.
- The project owner selected `GPL-3.0-or-later` on 2026-09-04 and approved a
  free-software-first hosting model: SDF Gitea is canonical, a clearly
  labelled one-way GitHub mirror provides OpenClaw visibility, and ClawHub is
  the discovery/install surface. Eric created the empty canonical repository
  at <https://git.sdf.org/erici/openclaw-xmpp>; a read-only `git ls-remote`
  check returned zero refs. The private local repository still has no remote,
  so its historical deployment evidence cannot be pushed accidentally.
  Canonical repository, homepage, and public issue-tracker metadata are now in
  the package and public documentation. Eric selected his established GitHub
  account, `soilDNRA`, as the mirror owner and confirmed himself as the
  initial maintainer. GitHub Private Vulnerability Reporting on that mirror is
  the approved confidential-reporting route. The mirror, route activation,
  and separate source-publication approval were completed on 2026-09-05. The
  remaining live evidence gates package and ClawHub promotion, not public
  review of the source.
- The exact GPL-licensed `0.1.1` candidate is
  `workspace/build/2026-09-04-openclaw-xmpp-public-export/final/openclaw-xmpp-0.1.1.tgz`.
  It contains 53 files, is 109,042 bytes packed, and has SHA-256
  `5dc960f9c3033bc038c4b0183083cca57c89bac4c7147058db6529f9302aa48f`.
  Extracted-artifact checks found no unsafe paths, symlinks, nested archives,
  source/test/backup directories, common credential signatures, machine-local
  paths, or private-network literals. All embedded versions agree.
- OpenClaw 2026.8.2's isolated runtime inspection loads the source candidate,
  registers exactly one `xmpp` channel, finds every runtime dependency, and
  reports no diagnostics. All 12 active SDK subpaths exist in OpenClaw's public
  export map, and there are no TypeScript suppressions.
- Vitest was updated from 4.0.18 to 4.1.11 and nanoid was constrained to the
  patched 3.3.18 release. Both the full and production-only dependency audits
  report zero known vulnerabilities; the production audit was repeated
  successfully immediately before source publication on 2026-09-05. The live
  managed `0.1.1` installation remains loaded, running, and connected without
  a recorded error; it was not modified or restarted.

As of 2026-09-02:

- The canonical source project has been migrated from OpenClaw 2026.7.1 to
  2026.8.2. Removed root and deprecated broad SDK imports were replaced with
  focused public SDK subpaths, and root-bounded local media reads now use the
  typed `@openclaw/fs-safe` 0.5.6 public API used by OpenClaw 2026.8.2.
- The project-local OpenClaw development dependency, peer compatibility floor,
  package compatibility metadata, and build provenance all identify 2026.8.2.
- A clean `npm run verify` passes strict no-emit type-checking, all 32 tests,
  declaration and production builds, and the package-shape dry run. Generated
  JavaScript syntax checks also pass.
- OpenClaw 2026.8.2's caller-owned loader loads the rebuilt canonical package,
  registers exactly one XMPP channel, and reports no diagnostics with global
  activation disabled. The rebuilt artifact has not been deployed to the live
  installation.

As of 2026-08-08:

- Type-check passes.
- All 18 automated tests pass.
- Production build passes.
- Package-shape dry run passes.
- OpenClaw runtime inspection and plugin doctor passed during installation.
- A live connection to a Prosody server succeeded with verified TLS.
- An outbound XMPP canary was delivered.
- A direct inbound message reached OpenClaw and produced a visible reply.
- The first live inbound test exposed a channel-runtime wrapper mismatch; it
  was fixed and covered by a regression test before the successful retest.
- The Python bridge is retained but disabled as a rollback path.

Baseline evidence captured on 2026-08-09:

- The pre-adoption implementation was committed as
  `11db813a292a1215f59032b36617251c8553ccbd` before any external source was
  copied or closely adapted.
- A clean `npm run verify` passed type-check, all 18 tests, the production
  build, and package-shape inspection.
- The source and packed artefact passed deployment-specific and secret scans;
  the built channel and transport matched the installed runtime byte for byte.
- The exact OpenClaw, Node, npm, xmpp.js, TypeScript, Vitest, and Prosody
  versions are recorded in `BASELINE.md`. The Android client declined a
  single XEP-0092 version query and remains an explicit evidence gap.
- `THIRD_PARTY_NOTICES.md` now records the immutable baseline boundary,
  Rémond/ProcessOne credit, reviewed revisions and paths, classification, and
  the rules for future copied, adapted, or independently reimplemented work.
- During the initial soak test, one long reply sent as a single XMPP message
  appeared truncated in Conversations while the same message was complete in
  Gajim. This indicates a Conversations rendering/interoperability limitation
  rather than loss of the message body in the XMPP transport. The exact client
  version, message length, and reliable chunk threshold still need recording.
- The plugin now exposes `textChunkLimit` at channel and account level and uses
  a conservative 4,000-character default. The first live test still arrived as
  one XMPP message because inbound direct-message replies use a delivery
  callback that bypassed the generic outbound adapter where the limit was
  advertised. Reply chunking has now also been applied in that actual delivery
  path, with channel- and account-level regression tests. Type-check, all 20
  tests, build, package inspection, configuration validation, and deployed-file
  comparison passed before redeployment.
- The second live test generated exactly 6,482 visible characters, but its
  durable delivery receipt contained one XMPP message ID and one part. The
  transcript proved that the reply used OpenClaw's explicit `message` send
  path. Core only activates `textChunkLimit` when the outbound adapter also
  supplies a `chunker`; the plugin had declared `chunkerMode` and the limit but
  omitted that required function. The adapter now supplies OpenClaw's official
  plain-text outbound chunker, and regression coverage verifies that a
  6,482-character payload is planned as 4,000 and 2,482 characters. Full
  verification passes all 22 tests. The packed and installed channel bundles
  match byte for byte, configuration validation and runtime plugin inspection
  passed, and a full Gateway restart loaded the npm-installed plugin before
  XMPP reconnected at 14:12:13 AEST. A subsequent Conversations test
  succeeded: the long reply arrived as two messages and `END OF TEST` was
  visible in the second, confirming the corrected chunker works end to end on
  the previously affected client path. A fresh Gajim comparison remains
  desirable for the interoperability record.
- On the corrective Gateway restart, the first XMPP start attempt timed out and
  the plugin's supervised auto-restart recovered on attempt 1, reconnecting as
  the configured bot account after about seven seconds. This recovered
  without intervention but remains useful lifecycle evidence for later
  reconnect hardening.
- On 2026-08-12, XMPP and Matrix were both found stopped by a stale
  Gateway-wide crash-loop breaker dating from 2026-07-07. The health monitor
  deliberately declined to auto-start either channel, so this was not an XMPP
  transport crash. An explicit `channels.start` override reconnected XMPP;
  Prosody then delivered the queued offline message, OpenClaw completed the agent
  run, and the plugin sent the reply successfully. This is useful live
  offline/delayed-delivery evidence. At 14:43 AEST a clean Gateway restart
  cleared the stale breaker: Matrix started automatically and probed healthy,
  and XMPP started automatically and connected with its configured resource
  about 34 seconds after systemd launched
  the new Gateway process. A later host watchdog reboot independently exercised
  the cold-boot path; Matrix and XMPP again started without intervention, with
  XMPP connected about 17 seconds after the Gateway process began loading.
- On 2026-08-13, the existing structured reply-media path was extended to the
  shared OpenClaw message tool. The plugin now advertises its native `send`
  action for configured accounts, recovers the canonical send target for
  delivery accounting, and forwards validated structured media payloads to
  the XEP-0363 uploader. Regression coverage also proves that harmless
  Markdown wrapping of a legacy `MEDIA:` line is recovered only as a
  compatibility fallback. The first live structured attachment proved the
  guarded XEP-0363 upload path, but the receiving client rendered its XEP-0066
  metadata as a link rather than displaying the image inline. The native
  plugin was then extended with XEP-0447/XEP-0446 inline file-sharing metadata,
  XEP-0300 SHA-256 hashes for local uploads, and XEP-0428 fallback indication.
  A live controlled stanza then established the remaining Conversations
  requirement: the ordinary body must contain only the uploaded URL and be
  marked as the XEP-0428 fallback. A caption-plus-URL body remained a visible
  link, while the URL-only form rendered the PNG inline. The plugin now sends
  any caption as a preceding text stanza and always uses the URL-only body for
  the media stanza. The same work corrected XEP-0363 slot requests to use the
  full IQ API: xmpp.js's convenience `get()` searches the response for a child
  with the request name, but XEP-0363 replies to `<request/>` with `<slot/>`.
  Type-check and all 32 tests pass. A native-plugin live send after deployment
  and a Gajim comparison remain outstanding.
- On 2026-08-15, an ordinary direct-message follow-up exposed a continuity
  problem at OpenClaw's implicit daily session boundary. The native channel
  inherited core's default 04:00 local reset; the first later inbound message
  lazily archived the preceding transcript and started a fresh session, so a
  question referring to the previous evening lacked its immediate context.
  The XMPP transport delivered both messages correctly and the old transcript
  remained intact. Recovery also failed because session-transcript indexing
  was disabled and timed out, while the fallback scan considered active
  `*.jsonl` transcripts but not reset archives. This is a core session-policy
  and retrieval interaction rather than XMPP message loss, but the plugin's
  onboarding/documentation should recommend or explain an appropriate
  per-channel reset policy for conversational use.

  **2026-08-15 update:** Detailed implementation plan created at
  `workspace/plans/xmpp-session-continuity.md`. Tracks bridge updates, native
  config extensions (dm.sessionScope, threadBindings equivalents, threadReplies),
  inbound binding via dispatchInboundDirectDmWithRuntime, recommended
  `resetByChannel`/`resetByType` policies (prefer idle for conversational DMs),
  search improvements, and migration path. This is now a tracked first-class
  requirement for conversational parity with Matrix.

The current evidence proves a complete direct-message path on one real
deployment. It does not yet prove robust reconnects, multi-server
interoperability, live uploads, or long-term stability.

## Existing ecosystem

Several XMPP implementations already exist. Discovery is fragmented because
none presently appears in the normal ClawHub search and installer path.

The most relevant prior work is Mickaël Rémond/ProcessOne's OpenClaw pull
request and branch:

- PR: <https://github.com/openclaw/openclaw/pull/9741>
- Branch:
  <https://github.com/processone/openclaw/tree/xmpp-support/extensions/xmpp>
- Reviewed PR head: `8a4bc4314ae39f8c5693051dc7bf604ddda0a6c9`
- Reviewed branch head: `a6adb95b35c183a81eef3afcef17071e9b647673`

OpenClaw closed the upstream PR under its third-party-extension policy, not
because XMPP was found to be technically unsuitable. Rémond offered
ProcessOne's help with long-term maintenance.

Other known independent repositories should be rechecked during the formal
ecosystem audit because activity and SDK compatibility can change.

## Comparative review decision

Decision date: 2026-08-08

Decision: continue using the local current-SDK implementation as the technical
foundation. Treat Rémond's work as an important source of design, features,
and potential collaboration rather than switching to it unchanged.

Reasons:

- Rémond's advertised `@openclaw/xmpp` package is not published on npm.
- His latest reviewed branch dates from February 2026 and fails to compile
  against the installed OpenClaw 2026.7.1 SDK because of substantial API
  changes.
- The branch accepts insecure `ws:` transport and lacks an explicit
  TLS-before-credentials application check.
- Password configuration is plain-string based rather than SecretRef-aware.
- Its upload protection is weaker: ordinary fetch, HTTP permitted, redirects,
  syntactic IP checks rather than OpenClaw's DNS-aware guard, and forwarding
  of sensitive slot headers.
- Its MUC access-control design derives the sender from
  `room@service/nickname` by stripping the nickname, producing the room JID
  rather than a verified human identity. Per-user MUC allowlists therefore
  need redesign around occupant presence and real-JID visibility.
- It lacks the current implementation's delayed timestamp handling, delivery
  receipts, and message deduplication.
- The local implementation is narrower, but it uses current OpenClaw APIs and
  has passed a live direct-message test.

Rémond's implementation nevertheless has meaningful strengths:

- MUC, reactions, and thread support.
- A substantial interactive onboarding flow.
- Active XEP-0199/XEP-0198 liveness probing and reconnect instrumentation in
  the latest branch.
- Broader documentation.
- Approximately 48 unit tests.
- Deep ProcessOne/ejabberd expertise and a public maintenance offer.

The best prospective consolidation is therefore to retain the modern security
and current-SDK base, port or redesign useful features, and invite Rémond to
collaborate after the evidence and proposal are ready.

## Selective adoption and provenance plan

Decision date: 2026-08-08

Rémond's branch should influence this project, but it should not be merged or
ported wholesale. The reviewed XMPP history consists of 17 commits authored
by Mickaël Rémond. It is covered by the parent OpenClaw repository's MIT
licence. Ideas and test scenarios may be reimplemented against the current
SDK; any copied or closely adapted code must retain the applicable MIT notice
and be identified by source file and commit in a third-party notice. Project
documentation should credit Rémond and ProcessOne for the earlier plugin and
the specific designs that informed this implementation, even where the new
code is independently written.

| Area | Decision | Reason and boundary |
| --- | --- | --- |
| Active connection probe | Adopt before public release, using a fresh current-SDK implementation | Use a bounded XEP-0199 ping and, where reliable, XEP-0198 acknowledgement. Clean up every timer and listener and never create a second authenticated connection merely to inspect the live one. |
| Reconnect and stream-management visibility | Adopt before public release, but not Rémond's lifecycle unchanged | Record reconnect attempts, successful reconnects, XEP-0198 resume/failure, and last probe. A transient disconnect must not cause the Gateway account task to tear down the client while xmpp.js is reconnecting. Any faster timeout values require live evidence and should be configurable. |
| Interactive onboarding | Adopt before public release, rewritten for the current setup API | Preserve multiple accounts, SecretRefs, secure transport defaults, and explicit access-policy choices. Do not encourage plaintext passwords or insecure `ws:` endpoints. MUC questions wait until MUC is actually supported. |
| Tests and documentation | Adopt the useful scenarios, normally with new fixtures and wording | Add probe cleanup, reconnect lifecycle, reaction parsing, and onboarding regression cases. Record exact provenance if a fixture or substantial text is copied. |
| XEP-0444 reactions | Adopt after the direct-message foundation is hardened | Use the current OpenClaw message-action adapter, stable XEP-0359 IDs, feature gating, validation, and live tests with at least Conversations and Gajim. Credit Rémond's earlier implementation. |
| Replies and threads | Reassess rather than copy | RFC 6121 `<thread>` is not automatically equivalent to a visible client reply or a safe OpenClaw session boundary. Prefer investigating XEP-0461 replies; only add RFC 6121 thread routing after interoperability and session-isolation tests. |
| Presence subscriptions and roster automation | Defer unless users need it | Direct messages do not require mutual roster subscriptions. Pairing should not silently create roster relationships; any future support should be explicit and separately tested. |
| MUC and per-room controls | Redesign later; do not copy the current access-control path | Retain the useful product shape—auto-join, mention gating, and per-room policy—but first solve occupant identity, anonymous rooms, history/self-message handling, joins, nick changes, and affiliation churn. |
| Transport, TLS, credentials, and HTTP upload | Keep the local implementation | The current implementation has fail-closed TLS-before-SASL, SecretRefs, multiple accounts, DNS-aware guarded HTTPS uploads, restricted headers, and current SDK integration. Rémond's versions should not replace these paths. |

The default engineering rule is therefore: take protocol and product ideas,
write them against the current architecture, and copy source only when doing
so is clearly safer or more maintainable than a fresh implementation. Credit
does not depend on whether copyright law strictly requires it.

## Detailed implementation plan for the Rémond-informed work

This plan turns the selective-adoption decisions above into reviewable work
packages. The order is intentional: preserve a clearly attributable local
baseline, harden the direct-message transport, then add user-visible protocol
features. A later work package must not be started merely because an earlier
one is difficult; each gate exists to prevent feature work from obscuring
security or lifecycle faults.

### Work package 0: preserve the baseline and establish provenance

Dependencies: completion or explicit review of the Phase 1 soak test, plus the
project owner's decisions on licence, exact public endpoints, maintenance,
and private security reporting.

Tasks:

- Run the full existing verification suite and record the exact OpenClaw,
  Node, xmpp.js, Prosody, and client versions used by the live baseline.
- Scan the package and Git history for credentials, private JIDs, local paths,
  generated artefacts, and other deployment-specific material.
- Select the SPDX licence, repository owner, package name, and security
  contact with the project owner before making anything public.
- Commit the current implementation as a pre-adoption baseline before copying
  or closely adapting any external source.
- Add a third-party notice/provenance ledger recording author, project,
  licence, source URL, reviewed commit, source path, destination path, and
  whether each contribution is copied, closely adapted, or independently
  reimplemented.
- Add plain-language README credit to Mickaël Rémond and ProcessOne for the
  earlier OpenClaw XMPP implementation and the designs that influenced this
  project. This credit remains even if no copyrightable code is copied.

Progress as of 2026-08-09:

- Complete: full baseline verification, package review, deployment-specific
  scan, initial commit, provenance ledger, and plain-language credit.
- Complete: package name retained as `openclaw-xmpp`; local project ownership
  and release approval remain with the project owner.
- Complete: the project owner selected `GPL-3.0-or-later` and the SDF
  Gitea-canonical/GitHub-mirror/ClawHub distribution model on 2026-09-04.
- Complete: Eric created the empty canonical repository at
  <https://git.sdf.org/erici/openclaw-xmpp>; it was verified to contain zero
  refs. The separately prepared public history is a reviewed one-commit export
  and does not reuse the private local Git history.
- Complete: Eric selected `soilDNRA` as the GitHub mirror owner on 2026-09-04;
  the public one-way mirror was created on 2026-09-05.
- Complete: Eric confirmed himself as the initial maintainer and approved
  GitHub Private Vulnerability Reporting as the private security-reporting
  route on 2026-09-04. It was enabled and verified on 2026-09-05.
- Pending evidence: the exact Android-client version used in the live
  baseline. It declined a single XEP-0092 query and is recorded as unknown
  rather than inferred.

The work-package evidence gate is not yet closed, but the source boundary is
frozen and the reviewed prerelease source is approved for public review.
Package promotion remains closed until the missing live evidence is resolved.

Gate:

- The baseline is reproducible, licensed, secret-free, and distinguishable
  from every later externally influenced change.
- No external repository, message, publication, or package submission occurs
  without the project owner's separate approval.

### Work package 1: active connection health probe

Dependencies: work package 0.

Design:

- Implement a bounded XEP-0199 ping on the existing authenticated connection.
- Correlate replies by stanza ID and accept a standards-compliant service or
  server response without treating unrelated IQ traffic as success.
- Make interval and timeout conservative and configurable; disabled must be a
  supported setting.
- Track last attempt, last success, latency, consecutive failures, and the
  reason the latest probe ended.
- Ensure stop, abort, reload, and disconnect remove every timer and listener.
  The probe must never open a second authenticated connection.
- Treat unsupported ping responses separately from transport failure. Do not
  reconnect endlessly merely because a server declines XEP-0199.

Tests and evidence:

- Unit tests for success, timeout, stanza error, unsupported service, abort,
  late reply, duplicate reply, ID mismatch, and timer/listener cleanup.
- Fake-clock tests proving only one probe can be outstanding per account.
- Live tests against the current Prosody deployment and one other server.
- Document which ideas or test scenarios came from Rémond's branch and record
  exact provenance for any source that is closely adapted.

Gate:

- Probing improves observability without changing normal message delivery or
  leaking tasks, timers, listeners, or credentials.

### Work package 2: reconnect and XEP-0198 lifecycle visibility

Dependencies: work package 1, because probe state becomes one reconnect input.

Design:

- Model account state explicitly: starting, online, degraded, reconnecting,
  stopped, and failed. Keep internal transport state distinct from the public
  OpenClaw channel status.
- Record disconnect cause, reconnect attempt count, backoff, successful
  reconnect, XEP-0198 resume success/failure, and time since last healthy
  traffic.
- Let xmpp.js complete a recoverable reconnect without the Gateway account
  task tearing down the client. Explicit stop, configuration replacement, or
  unrecoverable authentication/TLS failure must still terminate promptly.
- Define how queued outbound messages behave while reconnecting. Prefer a
  bounded queue with an explicit expiry or clear failure over silent loss or
  unbounded buffering.
- Keep receipt, origin-ID, stanza-ID, and deduplication semantics correct
  across stream resumption and full reconnects.
- Expose concise diagnostics through the current channel status surface; do
  not log message bodies, passwords, upload headers, or full private JIDs at
  ordinary log levels.

Tests and evidence:

- Deterministic lifecycle tests for connection loss, successful resume, resume
  rejection followed by reconnect, repeated failure/backoff, auth failure,
  TLS failure, explicit stop, rapid reload, and Gateway restart.
- Tests proving no duplicate listeners, clients, account tasks, or outbound
  deliveries after recovery.
- Live interruption tests for brief packet loss, server restart, longer
  outage, and Gateway restart, with an offline/delayed message in each
  relevant path.

Gate:

- A temporary outage recovers without manual intervention or duplicate
  delivery, while permanent credential/TLS faults fail closed and visibly.

### Work package 3: current-SDK secure onboarding

Dependencies: work package 0; it may be developed alongside work packages 1
and 2 but must be retested after their configuration fields settle.

Design:

- Use OpenClaw's current setup adapter and configuration schema rather than
  porting the older lifecycle or setup APIs.
- Support named multiple accounts, JID/resource, SRV discovery or an explicit
  secure endpoint, SecretRef-backed passwords, and an optional health-probe
  configuration.
- Default to verified TLS, reject insecure `ws:` endpoints, and explain any
  explicit-host certificate-name implications before saving configuration.
- Require an explicit direct-message policy: pairing, allowlist, or disabled.
  Normalize allowlists to bare JIDs and show the effective policy before
  completion.
- Validate the connection without printing or persisting resolved secret
  values. A failed validation must leave either no configuration or a clearly
  incomplete, non-running account.
- Do not ask MUC questions until MUC support has passed its later security
  gate.

Tests and evidence:

- Setup tests for a new account, second account, edit, cancel, invalid JID,
  insecure endpoint, failed TLS, failed authentication, SecretRef resolution,
  allowlist normalization, and redacted output.
- A complete Gateway-start test using a non-plaintext SecretRef.
- Fresh-install and rollback walkthroughs performed from the packed artefact,
  not from the source tree.

Gate:

- A user can configure a secure account without hand-editing JSON, and the
  wizard cannot silently weaken TLS, access policy, or secret handling.

### Work package 4: interoperability and pre-feature hardening

Dependencies: work packages 1-3.

Tasks:

- Establish CI for supported Node and OpenClaw versions and define the policy
  for SDK compatibility and dependency updates.
- Exercise two independent XMPP server implementations and at least
  Conversations and Gajim, recording versioned results in a reusable matrix.
- Complete live XEP-0363 upload, delayed-message, receipt, chat-state, long
  reply/chunking, malformed-stanza, and controlled duplicate tests.
- Expose OpenClaw's standard `textChunkLimit` setting at channel and account
  level, then select a conservative default from versioned Conversations and
  Gajim tests rather than assuming every client safely renders an
  8,000-character message body.
- Add certificate-expiry/hostname/refusal tests, DNS-rebinding-aware upload
  cases, upload redirect/header cases, media-root enforcement, concurrency,
  and complete SecretRef startup coverage.
- Perform a privacy, logging, package-content, and dependency review.
- Decide whether restart-persistent deduplication is required before public
  release based on the reconnect evidence.

Gate:

- No unresolved high-severity direct-message, transport, credential, or
  upload issue; CI and packaging are reproducible; the compatibility matrix
  supports the advertised baseline.

### Work package 5: XEP-0444 reactions

Dependencies: work package 4 and confirmation that the current OpenClaw
message-action API can represent reactions without private SDK internals.

Tasks:

- Map inbound and outbound reactions to stable XEP-0359 IDs, with strict
  sender, conversation, target-ID, payload-size, and allowed-character
  validation.
- Define replacement/removal semantics and how unsupported clients or servers
  degrade. Never turn an unrecognised reaction stanza into a normal prompt.
- Feature-gate the capability and keep it disabled where stable target IDs are
  unavailable.
- Add parsing, authorization, deduplication, reconnect, and malformed-input
  tests, followed by live Conversations and Gajim interoperability tests.
- Credit Rémond/ProcessOne in the feature documentation and provenance ledger;
  retain the MIT notice and exact source details if code is adapted.

Gate:

- Reactions are interoperable, correctly attributed, and cannot cross users,
  sessions, or conversations.

### Work package 6: replies first, RFC 6121 threads only with evidence

Dependencies: work package 4. This investigation may run alongside reactions,
but neither feature should depend on the other.

Tasks:

- Run a small protocol spike capturing the stanzas generated and rendered by
  Conversations and Gajim for XEP-0461 replies, fallbacks, and RFC 6121
  `<thread>` elements.
- Implement XEP-0461 reply metadata first if the clients interoperate. Resolve
  the target only within the authenticated sender and current conversation;
  unknown targets degrade to quoted context or plain text rather than another
  session's message.
- Preserve fallback text for clients without XEP-0461 support while avoiding
  duplicate prompt content inside OpenClaw.
- Keep RFC 6121 thread values as metadata by default. Use them as OpenClaw
  session boundaries only after adversarial tests prove stable client
  behaviour, collision resistance, and safe isolation across reconnects and
  multiple resources.
- Document a clear no-go decision if `<thread>` proves unsuitable; deferral is
  an acceptable outcome.

Gate:

- Visible replies work across the supported clients without allowing forged
  IDs or thread values to read, influence, or merge another session.

### Work package 7: MUC identity and policy redesign

Dependencies: work packages 2 and 4, plus a written threat model approved for
implementation. MUC remains absent from onboarding and advertised features
until this package passes.

Design stages:

1. Build an occupant-state model keyed by room and occupant JID, covering
   presence, self-presence, real-JID visibility, nick changes, kicks, bans,
   affiliation/role changes, history, and reconnect/rejoin.
2. Define identity modes. Non-anonymous rooms may authorize a verified real
   bare JID. Anonymous or semi-anonymous rooms cannot claim per-human JID
   authorization and require a separate explicit policy.
3. Start with non-anonymous, explicitly allowlisted rooms. Require mention or
   reply-to-bot gating by default and ignore history, self-messages, invites,
   and private MUC messages unless separately supported and tested.
4. Add confirmed join/leave, room passwords through SecretRefs, nick-conflict
   handling, bounded rejoin, and clear operational status.
5. Consider anonymous-room support only as a later opt-in capability with
   room-level trust clearly explained; do not infer a human identity from a
   nickname.

Tests and evidence:

- Unit and adversarial tests for nickname impersonation, nick change, occupant
  churn, hidden real JIDs, delayed history, self-echo, invitation spam,
  affiliation changes, reconnect/rejoin, and cross-room ID collisions.
- Live tests on non-anonymous and anonymous rooms across at least two clients,
  with documented differences in what identity can actually be verified.
- A separate security review before enabling MUC in setup or documentation.

Gate:

- The implementation never represents a room JID or nickname as a verified
  human JID, and its safe default remains disabled or tightly room-allowlisted
  with mention gating.

### Work package 8: collaboration and release integration

Dependencies: work packages 0-4 for credible technical evidence; later
feature packages may remain post-release work.

Tasks:

- Refresh the ecosystem comparison immediately before outreach so it does not
  rely on stale repository or package status.
- Prepare a concise feature/security/compatibility matrix and a courteous
  private note to Rémond describing what was independently built, what was
  learned from his work, and where review or co-maintenance would help.
- Show all outreach material to the project owner and obtain explicit approval before
  sending it.
- Resolve any collaboration, code-donation, or repository-consolidation offer
  before finalising copyright notices and maintenance ownership.
- Publish the licensed pre-release, ClawHub entry, and later installer proposal
  only through the separate approval gates already defined in Phases 5 and 6.

Gate:

- Attribution is accurate, collaboration claims are mutually agreed, and the
  package has a named maintenance path before public promotion.

## Known weaknesses and technical debt

### Release and project hygiene

- The package is licensed as `GPL-3.0-or-later` but remains `private: true`
  until the remaining package-release gates pass and package publication is
  separately approved.
- The private repository has pre-adoption root commit `11db813`; it has no
  remote. The public history is a separate one-root-commit export with no tag.
- Historical local commits contain private deployment evidence and must not be
  pushed to either public repository; only the reviewed squashed export is
  suitable as the public history.
- The canonical SDF repository and public issue tracker are live. The public
  `soilDNRA` GitHub repository is a one-way mirror, and its Private
  Vulnerability Reporting route is enabled and verified. Eric is the initial
  maintainer.
- There is no published ClawHub package, release tag, or package release.

### Test gaps

- No automated live integration suite.
- No deliberately timed reconnect/network interruption test; ordinary-use
  recovery evidence and deterministic lifecycle coverage are accepted for the
  labelled beta. A controlled interruption remains a stable-release gate.
- No explicit invalid/expired certificate live test; fail-closed TLS startup
  is covered deterministically and remains a stable-release evidence gap.
- The first real XEP-0363 upload succeeded, and a controlled standards-shaped
  stanza rendered inline in Conversations once its body was URL-only. The
  corrected native-plugin path still needs a live post-deployment send and a
  Gajim comparison.
- Complete Gateway-start coverage proves env SecretRef resolution without
  persisting plaintext.
- The beta interoperability gate covers two XMPP servers and two client
  families; exact private topology remains outside the public tree.
- Two initial live tests of the new 4,000-character default exposed separate
  delivery
  contract gaps: the inbound direct-reply callback bypassed generic outbound
  delivery, and the generic delivery path requires an explicit outbound
  chunker before it honours the advertised limit. Both now have regression
  coverage, and the final correction passed a live Conversations test: the
  reply arrived in two messages with its end marker intact. The exact
  Conversations version and a fresh Gajim comparison remain unrecorded, so the
  wider versioned interoperability threshold is still unknown.
- Limited malformed-stanza and concurrency testing.
- No restart-persistent duplicate store; deduplication is memory-only.

### Feature gaps

- The setup wizard and active XEP-0199 probe are new in beta.2 and require
  wider user feedback before a stable release.
- No MUC, reactions, or inbound media.
- SASL currently selects the first offered non-anonymous mechanism; a future
  review should determine whether explicit strongest-mechanism preference is
  appropriate and compatible with xmpp.js.

### Operational unknowns

- Behaviour over prolonged server downtime.
- Rapid configuration reload behaviour. A stale Gateway-wide crash-loop
  breaker can suppress all channel autostart and health-monitor recovery even
  when the XMPP transport itself is healthy. Clean Gateway restart and full
  host-reboot recovery both passed on 2026-08-12.
- Duplicate behaviour across reconnect and process restart.
- Long replies and multi-part media delivery under normal client use.
- Offline delivery and delayed messages from different servers.
- The best native-XMPP session reset policy is unresolved. Inheriting the core
  04:00 daily default can break an apparently continuous client conversation,
  while a long idle-based lifetime may permit transcripts to grow until
  compaction becomes expensive. Reset archives also need a dependable lookup
  path when a fresh turn refers back across the boundary.

## Roadmap

### Phase 1: live soak test — in progress

Objective: establish that direct messaging remains uneventful during ordinary
daily use.

Planned duration: approximately one to two weeks, extended if faults appear.

Checklist:

- [x] Establish verified-TLS connection.
- [x] Complete outbound canary.
- [x] Complete inbound message and agent reply.
- [x] Fix and regression-test the first live runtime integration fault.
- [ ] Exercise ordinary daily direct messages.
- [x] Exercise a long single-message reply; record the Conversations truncation
  and complete Gajim rendering as an interoperability finding.
- [ ] Exercise smaller configurable message chunks in Conversations and Gajim
  (Conversations passed after the final chunker fix; fresh Gajim comparison is
  still outstanding).
- [x] Restart the Gateway and verify automatic XMPP recovery.
- [ ] Interrupt the network and verify reconnect behaviour.
- [x] Test an offline/delayed message (Prosody retained the 2026-08-12 message
  while the channel was stopped; the plugin processed it and replied after an
  explicit start).
- [ ] Verify delivery receipts and chat-state behaviour in a normal client.
- [x] Send one local attachment through XEP-0363 (upload succeeded; its initial
  XEP-0066-only stanza rendered as a link, prompting the XEP-0447 fix).
- [ ] Check duplicate suppression with a controlled duplicate stanza where
  practical.
- [ ] Record every anomaly and add regression coverage where practical.

Exit criteria:

- No unresolved high-severity direct-message fault.
- All automated checks pass.
- Core live scenarios above have evidence recorded.
- The Python bridge remains a tested rollback option until this phase exits.

### Phase 2: project foundation and hardening — next

Objective: turn a working local prototype into a responsible pre-release
project.

Execution order and detailed gates are defined in work packages 0-4 above.

Checklist:

- [x] Select an SPDX licence with the project owner's approval:
  `GPL-3.0-or-later`.
- [x] Decide the package name and public-hosting model: `openclaw-xmpp`, with
  SDF Gitea canonical, a one-way GitHub mirror, and ClawHub distribution.
- [x] Create and confirm the empty canonical SDF repository at
  <https://git.sdf.org/erici/openclaw-xmpp>.
- [x] Select the GitHub mirror owner: `soilDNRA`.
- [x] Select the initial maintainer (Eric) and private security-reporting route
  (GitHub Private Vulnerability Reporting on the future mirror).
- [x] Make the initial Git commit after reviewing the packed contents and
  local-specific scans.
- [x] Establish CI on Node.js 22.22.3 and 24 against the pinned minimum
  OpenClaw 2026.8.2 baseline.
- [ ] Add automated tests for TLS refusal, reconnection, uploads, media-root
  enforcement, malformed inputs, and SecretRefs.
- [x] Add an active health probe informed by Rémond's useful design, adapted
  to the current SDK and tested for timeout, abort, and listener/timer
  cleanup.
- [x] Add reconnect and XEP-0198 resume/failure instrumentation without
  ending the Gateway account task during a recoverable disconnect.
- [x] Add a current OpenClaw setup/onboarding adapter that supports multiple
  accounts, SecretRefs, secure endpoint validation, and explicit DM policy.
- [x] Establish a third-party notice and source-provenance convention before
  copying or closely adapting any external implementation.
- [x] Define the initial OpenClaw compatibility and upgrade policy.
- [ ] Run live tests with at least two XMPP servers and two client families.
- [x] Complete the initial package privacy and secret-leak review; repeat it
  against the exact squashed export before publication.

Exit criteria:

- Reproducible CI and clean packaging.
- Clear licence and ownership.
- Security-critical paths have automated and live evidence.
- Installation and rollback documentation are complete.

### Phase 3: ecosystem comparison and collaboration — planned

Objective: reduce fragmentation and obtain experienced XMPP review before
publication.

Checklist:

- [x] Review Rémond's PR and latest branch against the current implementation.
- [ ] Recheck all credible XMPP repositories for new releases and activity.
- [x] Record an internal adopt/redesign/defer matrix with provenance rules.
- [ ] Turn the internal findings into a concise
  feature/security/compatibility matrix suitable for sharing.
- [ ] Draft a respectful private message to Rémond explaining the project,
  review evidence, and proposed collaboration.
- [ ] Obtain the project owner's approval before sending anything.
- [ ] Ask whether ProcessOne wishes to maintain, co-maintain, review, or donate
  relevant work.
- [ ] Decide whether to consolidate repositories, port selected features, or
  maintain an independent implementation with clear differentiation.

Exit criteria:

- A documented collaboration decision.
- No misleading claim that the project is the first or only XMPP plugin.
- Attribution and licence compatibility resolved for any adopted code.

### Phase 4: advanced XMPP features — planned, scope subject to evidence

Objective: expand beyond direct messages without weakening security.

Execution details and feature-specific gates are defined in work packages
5-7 above.

Candidate order:

1. Reactions and XEP-0461 reply metadata.
2. Inbound media with strict URL, MIME, size, and privacy controls.
3. MUC with a new identity model and explicit anonymous-room policy.
4. RFC 6121 thread routing only if client interoperability and session
   isolation evidence justify it.
5. Edits and retractions.
6. OMEMO only after a separate feasibility, threat-model, and maintenance
   assessment.

MUC must not reuse the reviewed design unchanged. It requires:

- Occupant presence tracking.
- Correct handling of real JIDs, nicknames, anonymous rooms, and affiliation
  changes.
- Self-message and history suppression.
- Confirmed joins and error handling.
- Safe defaults: groups disabled or tightly allowlisted until configured.
- Adversarial tests for impersonation and occupant churn.

### Phase 5: public pre-release and ClawHub — under way

Objective: make the plugin installable and discoverable without claiming
official endorsement prematurely.

Checklist:

- [x] Create and verify the empty canonical SDF Gitea repository.
- [x] Populate it only from the reviewed one-commit export; do not push the
  private local history.
- [x] Create a clearly labelled one-way GitHub mirror whose README and package
  metadata identify SDF Gitea as canonical.
- [ ] Publish signed/tagged source releases and changelog.
- [ ] Publish the approved package.
- [ ] Submit to ClawHub and verify search/install/update behaviour.
- [x] Document supported features and explicit non-features accurately.
- [x] Enable the approved private security-reporting route and verify it from
  a non-maintainer's perspective; keep the compatibility policy current.
- [ ] Gather real-user feedback and fix release-blocking faults.

Exit criteria:

- A clean install from the public package and ClawHub.
- At least one release owner committed to maintenance.
- No unresolved critical/high security issue.
- Documentation matches tested behaviour.

### Phase 6: standard installer inclusion — planned

Objective: have OpenClaw offer XMPP in its standard channel installer as an
official external channel.

Approach:

- Respect OpenClaw's architectural decision that the runtime remain an
  independently maintained SDK extension.
- Present a small, reviewable catalogue/onboarding integration rather than a
  large core protocol implementation.
- Demonstrate a maintained package, current SDK compatibility, tests,
  security posture, active users, and a named owner.
- Use Matrix/Signal/WhatsApp external-channel installation as precedent.

Checklist:

- [ ] Draft the upstream proposal for the project owner's review.
- [ ] Confirm current official-external catalogue requirements.
- [ ] Prepare catalogue metadata, installer label, docs link, install spec,
  and onboarding tests.
- [ ] Obtain the project owner's approval before opening an issue or PR.
- [ ] Respond constructively to upstream review.

Exit criteria:

- XMPP appears in the standard installer, or OpenClaw gives a documented,
  actionable reason and alternative discovery path.

### Phase 7: ongoing maintenance — future

- Track OpenClaw SDK changes and test against supported versions.
- Triage security reports and protocol interoperability faults.
- Maintain release notes and migration guidance.
- Periodically retest supported servers and clients.
- Keep ClawHub and installer metadata current.
- Review whether another implementation has become a better consolidation
  target.

## Acceptance criteria for the overall goal

The project goal is achieved only when all of the following are true:

- A public, maintained, licensed XMPP plugin exists.
- It has a documented security and compatibility policy.
- Its advertised core features pass automated and real interoperability tests.
- It is discoverable and installable through ClawHub.
- OpenClaw's standard installer offers it as an official external channel, or
  an equivalent official discovery path makes XMPP support clear to new users.
- Maintenance ownership is sustainable beyond the initial release.

Publishing a GitHub repository alone does not satisfy the goal.

## Decision log

### 2026-07-30 — build a native channel

A standalone TypeScript native channel was built after recurring limitations
in the external Python bridge demonstrated that XMPP belongs at OpenClaw's
channel-transport layer.

### 2026-08-08 — begin live native use

The pre-release plugin replaced the bridge for normal use after offline checks
and a successful live direct-message exchange. The bridge was retained but
disabled for rollback.

### 2026-08-08 — pursue discoverable official-external status

The long-term objective was expanded from a shareable plugin to a maintained
ClawHub channel offered by OpenClaw's standard installer.

### 2026-08-08 — consolidate rather than claim novelty

An ecosystem search found multiple prior implementations, including Rémond's
substantial rejected upstream PR. The project will compare and collaborate
rather than publish as though no prior work exists.

### 2026-08-08 — retain the local implementation as foundation

A direct code review found Rémond's work broader but outdated against the
current SDK and weaker in several security and MUC identity areas. The local
implementation remains the operational and technical base; Rémond's work is a
feature source and collaboration opportunity.

### 2026-08-08 — selectively adopt Rémond's work with explicit provenance

The project will reimplement the active probe, reconnect visibility, and
onboarding ideas against the current architecture, then consider reactions
after the direct-message foundation is hardened. Transport, upload, and MUC
access-control code will not be copied unchanged. Any copied or closely
adapted MIT-licensed code will retain its notice and exact source provenance;
Rémond and ProcessOne will also receive plain-language project credit for the
earlier implementation and influential designs.

### 2026-08-09 — adopt a gated implementation sequence

The selected Rémond-informed work is divided into dependency-ordered work
packages. The local baseline and provenance ledger come first, followed by
health probing, reconnect lifecycle, secure onboarding, and interoperability
hardening. Reactions and XEP-0461 replies are separate later features. RFC
6121 threads require session-isolation evidence, and MUC requires a new
identity model and threat model before implementation. Each package has an
explicit evidence gate, so a broad feature set cannot substitute for a secure
and dependable direct-message foundation.

### 2026-08-09 — freeze the pre-adoption baseline

The verified direct-message implementation was committed as `11db813` before
any Rémond/ProcessOne source was copied or closely adapted. A provenance ledger
and permanent plain-language credit now distinguish design influence from
source adaptation. The project owner selected `GPL-3.0-or-later` on
2026-09-04. The source is now public, but the package remains private until
the remaining package-release gates pass and package publication is separately
approved; the work package 0 gate remains open until the missing live-version
evidence is resolved.

### 2026-09-04 — use a free-software-first, pragmatic hosting model

The canonical public repository is hosted on SDF's Gitea service. A clearly
labelled, one-way GitHub mirror provides visibility and a practical
route for OpenClaw review and upstream contribution without making GitHub the
source of truth. ClawHub will remain the package discovery and installation
surface. The complete GPL-3.0-or-later source must remain buildable and
redistributable without GitHub. The existing SDF-hosted `vmailctl` repository
indicated `erici/openclaw-xmpp` as the natural canonical path, and Eric created
that empty public repository at
<https://git.sdf.org/erici/openclaw-xmpp>. The private source repository remains
unconnected to it; only the reviewed one-commit public export may be pushed.
Eric selected his established `soilDNRA` GitHub account as the mirror
owner on 2026-09-04, confirmed himself as the initial maintainer, and approved
GitHub Private Vulnerability Reporting on that mirror for confidential reports.
The mirror and reporting endpoint became active on 2026-09-05.

### 2026-09-04 — establish initial maintenance and private reporting

Eric will be the initial maintainer using the `soilDNRA` GitHub account.
Sensitive reports will use GitHub Private Vulnerability Reporting on the
clearly labelled mirror; ordinary public bugs remain on the canonical SDF
Gitea issue tracker. This avoids publishing a personal security email address
while keeping SDF authoritative. The private route was enabled and tested
before public source publication.

### 2026-09-05 — publish the reviewed source prerelease

Eric separately approved public source publication. The reviewed one-root-
commit export is published to the canonical SDF `main` branch and unchanged to
the clearly labelled GitHub mirror's `main` branch. The private source history
remains remote-free and unpublished. This approval does not include a source
tag, GitHub Release, npm package, ClawHub entry, maintainer outreach, or
standard-installer proposal; each remains separately gated.

## Immediate next actions

1. Keep `private: true`, preserve the private repository without a remote, and
   publish future source changes only through a reviewed one-commit-export
   workflow that keeps canonical SDF and the GitHub mirror aligned.
2. Complete the remaining Phase 1 evidence against a documented live test plan:
   Gajim chunking and corrected native
   attachment tests, client versions, receipt/chat-state observation,
   controlled duplicate handling, network-interruption recovery, ordinary-use
   soak, and the native-XMPP session-reset decision.
3. Implement the bounded XEP-0199 probe, reconnect/XEP-0198 visibility, secure
   onboarding, and the two-server/two-client interoperability gate.
4. Prepare a tagged source release and ClawHub package only after the remaining
   package gates pass and Eric gives separate publication approval.
5. Obtain separate approval before contacting Rémond, publishing to ClawHub,
   or proposing standard-installer inclusion.

## Maintenance rule for this document

When project work occurs:

- Update `Last updated`.
- Update the current status and appropriate checklist items.
- Add material evidence to `Verified evidence`.
- Record significant technical or strategic decisions in `Decision log`.
- Add newly discovered risks or remove risks only when evidence resolves them.
- Keep `Immediate next actions` short and current.
- Record public links and exact reviewed revisions for reproducibility.
- Do not put credentials or private deployment identifiers in this file.

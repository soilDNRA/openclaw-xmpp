# OMEMO multi-device trust and delivery repair

Date: 2026-10-08
Status: implemented in 0.1.2-beta.6 source; not included in the published beta.2.

Legacy/manual-trust interoperability has been exercised with Gajim and
Conversations. OMEMO 2 has no independent live-client interoperability proof.
Admin RPCs and authenticated owner-channel short codes are implemented; no new
graphical Control UI page or in-band XMPP approval is claimed.

## Original finding (before beta.6)

An established, verified client can receive typing notifications but no answer
after another device appears on its account. `src/omemo/session.ts`,
`#resolveRecipients`, resolves every advertised recipient and sender device,
building each missing session before returning the full device list. A manual
trust refusal for any one device aborts the entire send. The outbound cipher
also enforces trust for every target. Refusing untrusted keys is correct;
making all previously trusted devices unusable is the usability defect.

`src/inbound.ts` logs the dispatch failure, but `src/transport.ts` does not
record an OMEMO send failure in channel status. Ping health can therefore look
good while actual replies fail. `OmemoTrustError` already carries address,
fingerprint, direction and state, but the current stringified log hides most
of that useful diagnostic data.

## Recommended product behaviour

1. Continue encrypting replies to currently trusted/verified recipient devices.
   Exclude undecided, distrusted and retired devices; show that those devices
   are excluded rather than reporting delivery to all devices. Never send a
   plaintext fallback or automatically promote an unknown key to verified.
2. Require at least one eligible device of the actual recipient. The bot's
   own sync devices alone never satisfy this condition. If none is eligible,
   report a delivery-blocked state in the authenticated admin interface.
3. Discover and record pending public identities separately from encryption.
   A failed or untrusted optional device must not prevent discovery of the
   remaining devices. Use typed failures, bounded network work, and a clear
   per-device outcome; do not catch every exception and silently continue.
4. Preserve strict handling of identity replacement, corrupt state and ratchet
   errors. Initially, an observed changed identity is a hard failure requiring
   explicit review, not an ordinary newly discovered device. Re-check selected
   trust within the encryption transaction to avoid a revoke/send race.
5. Keep an explicit strict-all-devices policy for installations that need it.
   Add a documented trusted-devices policy with migration/onboarding choice;
   do not silently change existing installations' delivery policy.
6. Surface `connected` and `delivery blocked/degraded` independently. Expose
   pending-device count, last send failure and review action. Do not let a
   successful ping erase a delivery error. Clear typing state promptly on
   failure and clear delivery errors only following appropriate recovery.

## Easier review without weakening identity checks

- Present pending identities with account, device ID, full fingerprint,
  observation time and current policy. Device labels are hints, not proof.
- Offer an authenticated admin action or a short-lived approval token from an
  already verified owner device. Bind the token to account, JID, device ID,
  fingerprint, expected state, permitted action, expiry and requesting owner.
  Enforce one-time use and exact compare-and-set semantics.
- Distinguish owner-approved `trusted` from independently fingerprint-checked
  `verified`. A click approving a device does not itself prove its identity.
- Preserve the authenticated OMEMO sender-device identity through inbound
  transport and crash recovery before permitting in-band approval. Currently
  `#omemoIo` drops senderDeviceId, and recovered dispatch uses a placeholder;
  neither may be used as evidence of an already verified approving device.
- Send rate-limited review notices only to eligible trusted devices, or show
  them locally in the authenticated admin UI. Do not depend on another chat
  platform being configured. Never expose the reply body in an error notice.
- First-device bootstrap still needs an independent trust anchor (fingerprint
  comparison, QR flow with client support, or explicit first-use trust choice).
  Do not claim universal automatic cross-client verification without a tested
  authenticated protocol supported by both clients.

## Existing TOFU option is not the immediate fix

`trustMode: tofu` marks a newly observed identity `trusted`, not `verified`.
It has a first-contact authenticity trade-off and should remain an explicit
setup choice. `observeIdentity` preserves an existing trust record; switching
the setting does not promote an already undecided device. Changing the mode
is therefore neither an independently verified fix nor a repair for this
specific stored record. Marking the record distrusted also does not fix the
current all-device planner; it still tries that device.

## Implementation order and acceptance gates

1. Add delivery status/error diagnostics and structured per-device failures.
2. Implement explicit trusted-device recipient planning, discovery and selected
   target transaction checks. Keep existing strict policy available.
3. Prove in the private VM on exact OpenClaw 2026.9.8: a verified client keeps
   receiving encrypted replies when a second undecided device is advertised;
   that second device cannot decrypt. Capture actual client rendering, not
   only successful socket writes or empty queues.
4. Cover all-unknown recipients, revoked/retired devices, unknown own devices,
   changed keys, corrupt records, missing bundles, trust changes during send,
   and strict-mode behaviour. Preserve deterministic targets, atomic ratchet
   commits, exact-ciphertext retries and restart recovery.
5. Add the scoped review UX and test authorization, expiry, replay rejection,
   changed fingerprints, account isolation and recovered sender provenance.
6. Run remote full tests/typecheck/build/package and isolated packed import.
   Stage a versioned candidate with reviewed release notes and rollback.
   Deployment/restart is a separate step, not part of this investigation.

Do not promise automatic replay of today's unsent replies: trust refusal
occurs before ciphertext outbox creation. Any future queued plaintext must be
sealed at rest, bounded, deduplicated and re-authorized at send time. The first
repair should use a new client test message after trust/policy remediation.

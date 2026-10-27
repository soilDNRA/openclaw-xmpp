# OpenClaw XMPP project

Updated: 2026-10-28

## Source and releases

- Current source: `openclaw-xmpp@0.1.2-beta.6`.
- ClawHub beta release: `0.1.2-beta.6`, explicit `beta` channel only.
- Canonical repository: <https://git.sdf.org/erici/openclaw-xmpp>.
- One-way mirror: <https://github.com/soilDNRA/openclaw-xmpp>.
- License: GPL-3.0-or-later. Initial maintainer: Eric (`soilDNRA`).

The beta.6 source includes off-by-default OMEMO, manual fingerprint review,
owner-gated identity/device lifecycle, explicit trusted-device delivery,
scoped expiring review approvals, separate delivery diagnostics, and a
stale-parser crash guard. See README.md, SECURITY.md, OMEMO-TRUST-UX.md and
CHANGELOG.md. The beta.6 package release uses the explicit `beta` tag only;
there is no stable/default promotion or production deployment.

## Evidence and limits

Legacy OMEMO has been exercised bidirectionally with Gajim and Conversations,
including restart-stable identity and trust. A multi-device Gajim test showed
encrypted replies continuing to trusted devices while an undecided device
received no recipient key. Manual trust remains the default and unknown
devices are not approved automatically. Independent OMEMO 2 live-client
interoperability remains unproven; do not advertise it as established.

Before source synchronization, all 104 compiled files from this source
matched the retained installed beta.6 build byte-for-byte. Subsequent
source edits remove deployment-specific comments only; runtime logic is
unchanged. The development SDK remains pinned to OpenClaw 2026.8.2; current
runtime import/registration is also checked against OpenClaw 2026.10.7.

The 2026-10-28 clean Debian verification passed strict typechecking, all
142 tests in 25 files, the production build and the 112-file package check.
The production dependency audit reported zero known vulnerabilities.

## Roadmap

1. Maintain deterministic security, trust, recovery, parser and package tests.
2. Keep each package candidate reviewed and source-linked before publication.
3. Extend independent OMEMO 2 interoperability only with a suitable client.
4. Gather beta feedback and evaluate consolidation with existing XMPP work.
5. Pursue official external-channel discovery without claiming endorsement.

MUC/groups, reactions, edits, retractions, inbound file downloading and
OMEMO media remain outside the supported scope. No plaintext media fallback
is allowed when OMEMO is enabled.

## Publication boundaries

Keep private development history and operational evidence outside public
repositories. Export only reviewed generic source onto canonical public
history, then fast-forward the same commit to the mirror. Do not force-push.
Release tags, package publication, catalogue promotion, maintainer outreach
and production activation are separate owner-authorized tasks.

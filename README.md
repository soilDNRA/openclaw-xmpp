# OpenClaw XMPP

A native XMPP direct-message channel plugin for OpenClaw. It runs inside the
OpenClaw Gateway and uses OpenClaw's normal routing, sessions, commands,
delivery pipeline, pairing store, and status surfaces.

The canonical source repository is
[SDF Gitea](https://git.sdf.org/erici/openclaw-xmpp). The
[`soilDNRA/openclaw-xmpp`](https://github.com/soilDNRA/openclaw-xmpp) repository
is a clearly labelled one-way GitHub mirror that points back to SDF as the
source of truth. Eric is the initial maintainer.

This project is pre-release. Version `0.1.2-beta.2` is available through
ClawHub for explicit beta testing; there is no stable/default release yet.
Install the reviewed beta explicitly with:

```bash
openclaw plugins install clawhub:openclaw-xmpp@0.1.2-beta.2
```

Core interoperability has been exercised against both Prosody and ejabberd,
and with Conversations and Gajim clients.

The durable project goal, status, decisions, and roadmap are maintained in
[`PROJECT.md`](./PROJECT.md).

## Supported

- XMPP direct chats over verified TLS
- Multiple named accounts
- Bare-JID allowlists and OpenClaw pairing
- Per-sender OpenClaw session routing
- XEP-0085 chat states
- XEP-0184 delivery receipts
- XEP-0203 delayed-delivery timestamps
- XEP-0359 origin/stanza IDs for deduplication
- XEP-0363 HTTP upload for outbound local media
- XEP-0447/XEP-0446 inline file sharing with MIME type, name, size, and
  XEP-0300 SHA-256 integrity metadata for uploaded local media
- XEP-0066 out-of-band URL fallback for uploaded media
- Structured OpenClaw message-tool sends using `media`, `mediaUrl`, `path`, or
  `filePath`; captions are sent immediately before a URL-only XEP-0428
  fallback media stanza so Conversations renders supported files inline

MUC/group chats, OMEMO, reactions, edits, retractions, and inbound file
downloads are not supported in the initial release.

## Development

Development, issues, and release tags belong on the canonical SDF Gitea
repository. The GitHub copy is a visibility and upstream-review mirror, not a
second source of truth.

```bash
npm ci
npm run verify
```

Package-shape validation:

```bash
npm pack --dry-run
```

Installing a packed artefact changes the active OpenClaw installation. Follow
the release checklist and preserve a known-good rollback package before doing
that on a live Gateway.

## Compatibility

- Node.js 22.22.3 or newer is required.
- OpenClaw 2026.8.2 is the minimum supported Gateway and plugin API version.
- CI runs the pinned OpenClaw 2026.8.2 baseline on Node.js 22.22.3 and Node.js
  24.
- Before each release, the packed artefact must also pass loader and live
  smoke tests against the current stable OpenClaw release. A lower-bound
  version range is not a promise of compatibility with an untested future SDK.

## Configuration

Environment variables provide a minimal single-account setup:

```bash
export XMPP_JID='bot@example.org'
export XMPP_PASSWORD='use-an-app-password'
```

Equivalent OpenClaw configuration:

```json
{
  "channels": {
    "xmpp": {
      "enabled": true,
      "jid": "bot@example.org",
      "password": {
        "source": "env",
        "provider": "default",
        "id": "XMPP_PASSWORD"
      },
      "resource": "openclaw",
      "textChunkLimit": 4000,
      "dmPolicy": "pairing",
      "allowFrom": []
    }
  }
}
```

For named accounts:

```json
{
  "channels": {
    "xmpp": {
      "defaultAccount": "personal",
      "accounts": {
        "personal": {
          "enabled": true,
          "jid": "bot@example.org",
          "password": {
            "source": "env",
            "provider": "default",
            "id": "XMPP_PASSWORD"
          },
          "dmPolicy": "allowlist",
          "allowFrom": [
            "owner@example.org"
          ]
        }
      }
    }
  }
}
```

`allowFrom` entries are normalized to bare JIDs. `"*"` is accepted only when
`dmPolicy` is `"open"`.

Long replies are split at paragraph boundaries where practical. Set
`textChunkLimit` on the channel or an individual named account to change the
maximum outbound message size; the default is 4,000 characters. A smaller
value can improve compatibility with clients that truncate very long message
bodies.

If normal DNS SRV discovery is unavailable, configure `service` or
`websocketUrl`. Explicit `xmpp:` services must negotiate STARTTLS; `xmpps:`
uses direct TLS, and WebSocket connections must use `wss:`. The plugin closes
the connection before sending presence or messages if transport security is
not active.

### Session continuity

XMPP uses OpenClaw's core session routing and lifecycle; the plugin does not
silently impose its own reset schedule. For a personal conversational account,
`session.dmScope: "per-channel-peer"` keeps each XMPP peer isolated while
preserving a stable conversation binding. OpenClaw 2026.9.2 defaults to no
automatic reset when no reset policy is configured, and compaction bounds the
active model context as a conversation grows. Send `/new` or `/reset` when you
deliberately want a fresh conversation; verify the default for other OpenClaw
versions before relying on it.

Operators who want to make the no-automatic-reset choice explicit can use:

```json
{
  "session": {
    "dmScope": "per-channel-peer",
    "resetByChannel": {
      "xmpp": { "mode": "none" }
    }
  }
}
```

Automatic `daily` or `idle` reset policies are optional operator choices and
can cause a later follow-up to start a fresh transcript generation. Check the
session documentation for the OpenClaw version you deploy rather than assuming
a fixed clock boundary across releases.

## Acknowledgements

This project's roadmap has been informed by Mickaël Rémond and ProcessOne's
earlier OpenClaw XMPP implementation, particularly its work on active health
probing, reconnect visibility, onboarding, reactions, replies/threads, and
MUC. Their implementation and maintenance offer are important prior work, and
we gratefully credit them even where this project uses a fresh implementation.

Exact reviewed revisions, source paths, licence information, and the boundary
between influence and adapted source are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Licence

OpenClaw XMPP is free software licensed under the GNU General Public License,
version 3 or (at your option) any later version. See [`LICENSE`](./LICENSE).

## Security

Please use the private reporting route described in
[`SECURITY.md`](./SECURITY.md). Do not put credentials, private JIDs, message
contents, server addresses, or exploit details in a public issue.

## Release checklist

- The licence is `GPL-3.0-or-later`; Eric is the initial maintainer. The
  reviewed source prerelease is public, but keep `private: true` until the
  package-release gates pass and package publication is separately approved.
- Keep the SDF repository, issue tracker, and homepage metadata canonical.
  GitHub Private Vulnerability Reporting is enabled on the labelled mirror.
- Run `npm run verify` on the minimum supported Node/OpenClaw versions.
- Install the packed tarball using `npm-pack:` and inspect the loaded runtime.
- Run live tests against at least two XMPP servers and clients.
- Verify STARTTLS/direct TLS certificate failures are fail-closed.
- Verify pairing, allowlist, reconnect, receipt, delayed stanza, and upload
  behavior.
- Review the packed file list for secrets and machine-specific paths.
- Require separate explicit owner approval for release tags, ClawHub
  publication, npm publication, and standard-installer inclusion.

Interactive OpenClaw channel setup now supports named accounts without
hand-editing JSON. It requires a password environment-variable name and saves
that reference as a SecretRef; the resolved password is never written to the
configuration or displayed. Setup requires an explicit direct-message policy,
refuses insecure WebSockets, explains explicit-host certificate verification,
and validates TLS, authentication, and resource binding before returning a
configuration to be saved.

XEP-0199 health probing is enabled conservatively by default (every 300
seconds with a 15-second timeout). Set `healthProbe: false` to disable it, or
use `healthProbeIntervalSeconds`, `healthProbeTimeoutSeconds`, and
`reconnectDelaySeconds` within the manifest bounds. Channel status reports
probe health, reconnect attempts, and XEP-0198 resume/full-rebind outcomes.

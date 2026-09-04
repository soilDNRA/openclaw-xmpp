# Security policy

## Supported versions

Public prerelease source is available, but there is no installable package or
stable release yet. The current `0.1.x` prerelease requires OpenClaw 2026.8.2
or newer and Node.js 22.22.3 or newer. Security fixes are made on the latest
prerelease source only.

## Reporting a vulnerability

The initial maintainer is Eric, using the GitHub account
[`soilDNRA`](https://github.com/soilDNRA).

Private vulnerability reports will use GitHub Private Vulnerability Reporting
on the labelled one-way mirror:

<https://github.com/soilDNRA/openclaw-xmpp/security/advisories/new>

Private Vulnerability Reporting is enabled on the mirror and the endpoint was
verified before source publication. A GitHub account is required to submit a
private report. Do not open a public issue containing credentials, private
JIDs, message contents, server addresses, or exploit details.

The canonical source and public issue tracker remain on SDF Gitea. GitHub is
used for confidential vulnerability coordination, not as a second source of
truth.

Include the plugin, OpenClaw, Node.js, XMPP server, and client versions; the
affected configuration surface; reproduction steps; and whether the issue can
expose credentials, bypass access control, cross session boundaries, or reach
private network or filesystem resources. Redact secrets and personal data.

## Security model

- TLS certificate verification is never disabled by plugin configuration.
- Credentials support OpenClaw `SecretInput` values and environment variables.
- Direct messages default to pairing and can be restricted to bare JIDs.
- Group chats and MUC invitations are ignored.
- Inbound message IDs are deduplicated before agent dispatch.
- Errors and status output do not expose passwords or message bodies.
- Local media uploads are restricted to approved roots and a size limit.
  Remote media references must be HTTPS and pass DNS/IP safety checks; upload
  slot redirects and headers are restricted.

Public reports are appropriate for ordinary bugs only after removing private
data and confirming that the report does not describe a security weakness.

OMEMO is not currently implemented. Message bodies are protected in transit by
TLS but are not end-to-end encrypted by this plugin.

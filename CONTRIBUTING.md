# Contributing

The canonical repository and public issue tracker are hosted at
<https://git.sdf.org/erici/openclaw-xmpp>. Any GitHub repository for this
project is a one-way mirror for visibility and OpenClaw review.

Requirements: Node.js 22.22.3 or newer and npm.

```bash
npm ci
npm run verify
git diff --check
```

Keep transport code independent from OpenClaw where practical and cover stanza
normalization, access decisions, deduplication, and outbound metadata with
offline tests. Tests must not contact public XMPP services.

Changes to authentication, TLS, access policy, session routing, local media
roots, uploads, redirects, DNS/IP validation, or logging require focused
negative tests as well as the normal success case. Do not weaken a fail-closed
path to make a test or server pass.

Do not commit credentials, real JIDs, private server names, transcript content,
generated media, local backups, or packed tarballs. Public releases also
require an explicit SPDX licence, completed live interoperability tests, and
maintainer approval.

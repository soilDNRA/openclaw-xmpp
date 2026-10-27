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

## Source synchronization

Keep private development history and operational notes outside public history.
For an owner-authorized synchronization, preserve a source snapshot and Git
bundle first. Rebuild and compare the source with the installed artifact,
then export only reviewed generic code, tests and documentation onto the
existing canonical public branch. Use a generic public project summary; do
not export private plans, accounts, state, credentials or deployment evidence.

Run a clean lockfile install, strict typecheck, full tests, production build,
package inspection, dependency audit and current-host import/registration.
On older-glibc hosts, use a compatible isolated test machine rather than
changing the dependency lock to work around Rollup's native test tooling.
Scan every staged file and check the diff before committing. Fast-forward
canonical SDF first and mirror the identical commit to GitHub; verify both
remote IDs and CI. Never force-push or attach a remote to private history.
Source synchronization alone does not authorize tags, package publication,
production activation or maintainer outreach.

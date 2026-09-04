# Pre-adoption baseline

Captured: 2026-08-09

Git commit: `11db813a292a1215f59032b36617251c8553ccbd`

This commit is the immutable boundary between the independently developed
direct-message prototype and any later work informed by external XMPP
implementations. It was committed before any external source was copied or
closely adapted into this repository.

## Toolchain

- OpenClaw CLI: `2026.7.1-2` (`0790d9f`)
- OpenClaw package and plugin SDK: `2026.7.1`
- Node.js: `22.23.2`
- npm: `10.9.8`
- `@xmpp/client`: `0.14.0`
- `@xmpp/xml`: `0.14.0`
- TypeScript: `5.9.3`
- Vitest: `4.0.18`
- Prosody: `13.0.1`, reported by an authenticated XEP-0092 query

The Android XMPP client used in the successful live path returned an IQ error
to a single XEP-0092 query to its bare JID. Its exact version therefore remains
an explicit evidence gap rather than being guessed; no further client probe was
made.

## Verification

`npm run verify` completed successfully from the baseline tree:

- TypeScript type-check passed.
- Seven test files passed, containing 18 tests.
- The production build passed.
- `npm pack --dry-run` passed with 51 files.
- The dry-run tarball was 82.6 kB (350.3 kB unpacked), with SHA-1
  `78e42c14a74b02a06defda039ed2a64fb788eca2`.

The generated runtime entry points for the transport and channel were
byte-for-byte identical to the installed live plugin at capture time. The live
Gateway configuration was hashed before this work and was not edited.

## Privacy and package review

The source tree and packed artefact were scanned for private domains, real
JIDs, home/root paths, private-key headers, common cloud-key formats, and
plausible assigned credentials. No deployment-specific or secret material was
found. Example values such as `bot@example.org`, `owner@example.org`,
`use-an-app-password`, and the test-only string `secret` are deliberate
fixtures.

Ignored generated content is limited to `node_modules/`, `dist/`, coverage,
tarballs, environment files, and logs. The packed file list was reviewed
explicitly during verification.

## External-source boundary

The relevant ProcessOne branch was rechecked at
`a6adb95b35c183a81eef3afcef17071e9b647673`, and OpenClaw PR 9741 at
`8a4bc4314ae39f8c5693051dc7bf604ddda0a6c9`. A SHA-256 comparison found no
identical non-generated file between that XMPP extension and this baseline.
The provenance classification and future update rules are in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Reproduction

```bash
npm ci
npm run verify
git status --short
```

The package remains private until the separate public-release gates in
`PROJECT.md` are approved.

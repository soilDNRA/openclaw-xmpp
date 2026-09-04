# Third-party notices and provenance

This file is both an attribution record and a source-provenance ledger. Update
it in the same commit whenever source, tests, fixtures, or substantial text are
copied or closely adapted from another project.

## Pre-adoption baseline

Commit `11db813a292a1215f59032b36617251c8553ccbd` contains the independently
developed local implementation as it existed before selective adoption work.
No code from the external implementation recorded below was intentionally
copied or closely adapted into that commit.

## Influential earlier XMPP work

Mickaël Rémond of ProcessOne authored an earlier OpenClaw XMPP extension and
offered ProcessOne's XMPP expertise and maintenance help. Its health-probe,
reconnect-observability, onboarding, reaction, reply/thread, and MUC product
ideas informed this project's comparative review and roadmap. We gratefully
credit Rémond and ProcessOne for that work, including where this project later
uses a fresh implementation rather than their source.

- Project: ProcessOne fork of OpenClaw, `xmpp-support` branch
- Pull request: <https://github.com/openclaw/openclaw/pull/9741>
- Branch: <https://github.com/processone/openclaw/tree/xmpp-support/extensions/xmpp>
- Author of the reviewed 17-commit XMPP history: Mickaël Rémond
- Licence: MIT, inherited from the parent OpenClaw repository
- Reviewed PR head: `8a4bc4314ae39f8c5693051dc7bf604ddda0a6c9`
- Reviewed branch head: `a6adb95b35c183a81eef3afcef17071e9b647673`
- Upstream licence: <https://github.com/processone/openclaw/blob/xmpp-support/LICENSE>

## Provenance ledger

| Subject | Upstream source path and commits | Local destination | Classification |
| --- | --- | --- | --- |
| Overall extension and onboarding | `extensions/xmpp/**`, introduced at `a78b3e9ac2d718c48b225f5c1f03fe645ff99265`; especially `src/onboarding.ts` and `src/config-schema.ts` | `PROJECT.md`, README acknowledgement; no baseline source destination | Design and comparative-review influence; independently written local baseline |
| Active health probing | `src/probe.ts`, `src/channel.ts`, and `src/client.ts`; evolution at `09fd0822c70768c11d0dcae8fd67f19ca30322e4`, `4a092fdaa6d679f8df212196101a3825dd83c3e4`, `5722097c679bf8cdadb8b4d00023ca0cdabc46be`, `bf20f91fb6259abff763155fe6efaccc891cbbd1`, and `a6adb95b35c183a81eef3afcef17071e9b647673` | None yet | Planned fresh implementation; no code carried into the baseline |
| XEP-0444 reactions | `src/actions.ts`, `src/actions.test.ts`, and `src/xep0444.ts`; `a78b3e9ac2d718c48b225f5c1f03fe645ff99265`, `6b9c32c45c2a292984f4f67268ee3c7c76dadfec`, and `5d08db7c5b6d5ed50f29439ebfc032eeecfe05af` | None yet | Future protocol/product influence; no code carried into the baseline |
| Replies, threads, and MUC shape | `src/channel.ts`, `src/client.ts`, and `src/types.ts` at `a78b3e9ac2d718c48b225f5c1f03fe645ff99265` through the reviewed heads | `PROJECT.md`; no baseline source destination | Requirements input only; replies require a new XEP-0461 investigation and MUC requires a new identity/security design |

## Rule for later adaptation

For each future copied or closely adapted contribution, add the exact upstream
commit and source path, the local destination path, the author/project, and the
applicable licence notice before merging it. Preserve the upstream MIT notice
verbatim when it applies. Independently reimplemented ideas still receive
plain-language credit, but must not be described as copied code.

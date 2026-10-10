# V0 parity inventory and shared-host handshake candidate

This is a source-research aid, not a second release board, runtime service or
acceptance gate. The frozen baseline is the 31 implemented Hub actions in V0
`eb146dc085277386f45c4e017fcfa60cb225001d`, not every string in its catalogue.
The successor snapshot is `f072ebbd79458e4c67ab595fc62d3696347fe55b`.

## No silent omissions

`tests/fixtures/v0-parity-baseline.json` maps every baseline action exactly once
into 15 behavior groups. Six further workflow rows cover non-MCP concerns.
Source state is deliberately separate from actual connector/account proof.

```sh
node tooling/check-v0-parity.mjs
node --test tests/fixtures/v0-parity.selftest.mjs
```

The checker validates accounting only. Even a structurally correct inventory
returns `sourceParityComplete: false`, `liveParityQualified: false`, and
`NOT_EVALUATED_BY_INVENTORY`. It neither reads a V0 installation nor starts a
provider, inspects auth, grants access, or infers live availability from a tool
name. No additional dependency is needed. Missing rows, duplicates, invented
baseline actions and acceptance claims produce errors.

Three groups have a replacement in source, nine are partial and three have no
public replacement at the pinned subject. These are groups, not percentages of
product completion. The missing groups are guidance, Claude handoff and Codex
title management. Project resolution/ensure/preference, history discovery,
instruction bootstrap and shared live task control remain partial. An owner
preview can be useful before full parity, but V0 retirement must not silently
forget these rows.

The JSON is intentionally frozen evidence, not an automatically updated claim.
On later review add actual replacement/qualification evidence to the existing
release checklist. Do not rewrite the baseline or call every partial row done
because the source has a similarly named class.

## Concrete handshake defect found during research

At the pinned Farol subject `SharedCodexProxyHost.connect()` sends `initialize`
without `capabilities.experimentalApi`. Its first project-selection operation
uses `project/list`. In the inspected upstream Codex protocol that method is
explicitly experimental:

- upstream source: `openai/codex` commit
  `659b35f1316eda27ef61850dd0832c4a4e95c120`;
- `codex-rs/app-server-protocol/src/protocol/common.rs`,
  `#[experimental("project/list")]`;
- official protocol documentation: <https://learn.chatgpt.com/docs/app-server>.

A CLI schema being generated with experimental definitions does not opt a
connection into them. The patch negotiates that existing required protocol
capability in `initialize`. It does not widen filesystem authority, auto-approve
server requests, select another model, attach a different socket or start a
model turn. Unsupported hosts still fail rather than reconnecting with a
weaker contract.

`tests/unit/shared-codex-handshake.test.ts` executes the actual host class with
in-memory stream endpoints. Before the change its first two tests failed on
`CODEX_SHARED_HOST_UNAVAILABLE`; after the change all three passed. They verify
handshake ordering, exactly one initialize/client lifetime, and no retry after
handshake refusal. No process or socket exists in this fixture.

A separate native protocol fixture lives in
`tests/integration/shared-codex-experimental-negotiation.test.ts`. Its first
attempt failed on `kill EPERM` during owned-child cleanup; the rejecting-host
case passed. The native failure is NOT a successful reproduction of a live
Codex defect and is NOT repaired by the in-memory tests. It was not retried
through another execution route. Native termination and installed-host tests
remain for the authorized integration environment.

## Integration order

1. Take the tiny handshake source delta plus its exact tests, after comparing
   with the active Lead branch. Qualify the actual serving version/used methods.
2. Read the parity ledger when selecting the next existing goal item. Do not add
   a new orchestration service or merge the older coordinator task-control
   composition over current Computer work.
3. Run the project's normal applicable checks/review on integrated bytes. This
   research does not waive full CI, native cleanup, package or owner trial.
4. Real shared runtime acceptance is still separate: confirm the owner-selected
   native endpoint and the same live thread/turn, handle approvals and client
   loss correctly. A compatible socket alone proves neither Desktop visibility
   nor two-client mutation safety.

No installed app, V0 runtime, account, daemon, main branch or remote was changed
by this candidate. Dependencies were installed in this worktree with install
scripts disabled; Electron/package tests were not run here.

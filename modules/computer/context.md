# Computer workspace context prerequisite

This context-only source checkpoint preserves the existing TS
`workspace.context` behavior from `run-readonly-computer-action.ts`,
`workspace-catalogue.ts` and `workspace-bootstrap.ts`. It adds no product route,
recursive context catalogue, instruction reader, consent, Task/Turn state or
retry. The frozen search compatibility prerequisite is unrelated.

The writer starts from accepted `acb131d9e7d483296d4edac262cf881cddfb91bb`.
Its four Computer dependencies remain **UNACCEPTED**:

| Original source                          | Context-writer projection                  |
| ---------------------------------------- | ------------------------------------------ |
| `9ee44d8` (earlier projection `f3bd768`) | `fc597894e6b9e0d2cb1184df3e46864fb23544f8` |
| `7a611393`                               | `3191d97d53c5ed5b7768e472c445eacde0f73aa1` |
| `5a9e539`                                | `fe12f52a175662b631e90c30bc5312eab4956090` |
| `84bdfa2`                                | `7cf9e1ea696f13a844edf93860be4efeabac0b20` |

## Retained behavior

- Context uses existing `workspace.list` authority, with a canonical selected
  relative directory. An exact-file scope never becomes directory authority.
- The existing descriptor-safe native list checks the selected directory and
  approved physical ancestor. Its private port response supplies the opened
  scope-root binding and checked relative directory only after stable directory,
  root and cancellation checks. Missing/malformed facts refuse; valid crossed
  facts refuse as `WORKSPACE_ROOT_CHANGED`. Policy metadata is no fallback.
- App context matches those facts to the exact admitted descriptor/request, then
  rechecks current authority before constructing any response. It returns the
  admitted **scope root**, approved ancestor device/inode and `scope: subtree`.
  It discloses no list entries, truncation flags, file bodies or instruction text.
- Existing native list filtering, 500-entry/100000-scan bounds, error precedence,
  ownership/mode/no-follow/link checks and read/list contracts remain unchanged.
  Context can succeed after a bounded list; it claims no complete inventory or
  atomic filesystem snapshot. It is not Python's recursive `list-context` verb.
- All refusal sources and `retry: never` cross the owning in-process contract
  through its existing classified error mapping. No transport schema is added.

## Proposed root composition, not activation

The real route must bind correlation to the existing owner's admitted task/turn,
then admit one ordinary `authority.List` execution lease and inject that exact
lease into `workspace.New` with the native workspace and clock. The owning
`contracts/workspace.Context` maps independent DTOs. Do not reissue between
native IO and disclosure. The operation retains the 15-second fixed deadline.

The selected order remains Computer snapshot before synchronous Task admission
callback. Native qualification and workspace IO never run in the Task-held
callback. Missing real Task/Chat projection cannot be replaced by request IDs,
provider status, launch decoding or cached settings. The issuer refuses a
missing projection/admission; fixtures below are not that production adapter.

Core owns future shared wire/registration and root lifetime glue. Existing
exported Read/List DTOs contain no observed root metadata. Current settings and
trusted Task/Chat contracts, R4, aggregate integration, packaging/install and
live same-chat acceptance remain separate gates.

## Evidence and next checkpoint

Pure tests cover native-proof requirements, scope/descriptor correlation,
exact-file refusal, unavailable versus absent owners, cancellation, policy
changes and classified native errors. Real disposable native store/filesystem
vectors cover narrowed roots, outer expiry, a new fixture turn/issuer, cold
restore, fixed deadline, revocation/generation and no Task proof. Task bindings
and clocks are symbolic; no owner files, live connector or ChatGPT turn is used.

The first fault-vector run exposed incorrect fixture expectations: scope
rebind first refuses the old path; renaming the selected directory first
produces a native race; an already expired approval cannot be published.
The vectors retain those existing precedences and observe expiry after a valid
shorter approval. This was fixture repair, not a change to executor behavior.

Catalogue orchestration (sealed subtree IDs only, two complete context passes)
and bootstrap (root-to-selected-directory AGENTS.md, depth 32, 64 KiB per pass,
read/not_found/unavailable distinction, second reads and final context check)
remain **NOT_RUN** in Go for this checkpoint. Existing TS consistency/coverage
labels must survive that subsequent migration; instruction text never grants
access. No active Python/TS executor is removed.

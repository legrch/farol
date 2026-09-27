# Ordinary Git environment fixture

This is a reusable acceptance input and reference self-test, not a new Git API,
production permission change, or proof that Computer already supports this flow.

Run the dependency-free reference checks:

```sh
node --test tests/fixtures/ordinary-git-environment.selftest.mjs
```

`createOrdinaryGitEnvironment()` builds only a new temporary root. It supplies a
synthetic HOME, both user Git config locations, a relative include, an includeIf
for linked-worktree metadata, a configured real hook, and a registered writer
under that synthetic home's `.codex/worktrees`. All source, Git metadata, hooks
and canaries belong to the temporary root. No owner auth or config is loaded.
The reference runner uses `/usr/bin/git` and disables machine-global config and
templates solely to make the fixture independent of the host.

Six self-tests establish the reference behavior: normal config resolution,
linked-worktree identity, the config-suppression negative control, an exact-path
commit retaining a foreign staged file, byte-preserving unstage, and a real
hook refusal that leaves HEAD unchanged. Every successful case checks the
outside-approval canary and then verifies that its temporary root was removed.

## Incorporation into Computer acceptance

Reuse the fixture in the existing workspace-shell MCP lane rather than building
another runner or copying owner configuration. Select its writer, the exact
linked Git metadata, and the intended synthetic user-config scope through the
same trusted grant and environment preparation that production will use.

Issue the ordinary `git config`, `git add`, `git restore --staged`, `git commit`
and readback commands through `computer_shell_start/read`. The fixture's native
`runGit` is the reference, not the system under test. Do not export HOME or force
Git configuration inside each command to conceal missing production wiring.
Do not pass a new caller-controlled environment bypass merely to satisfy tests.

The narrower-grant negative variant must keep an outside-approval path closed.
A second approved non-Git root must not invalidate a first root's Git access.
A `.codex/worktrees` checkout is ordinary source under a selected grant; it is
not permission to enumerate unrelated provider stores. Repeat the relevant
flow after connector regeneration. Preserve failure and cleanup evidence.

On the inspected Computer baseline, shell uses a temporary HOME and sets
`GIT_CONFIG_GLOBAL=/dev/null`. The reference negative control shows why a
successful `git status`/HEAD alone misses global identity, includes and hooks.
This fixture does not resolve that production gap or change Seatbelt policy.

Protocol reference for normal Git configuration and include semantics:
https://git-scm.com/docs/git-config

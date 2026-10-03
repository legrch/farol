# Ordinary Git environment fixture

This reusable test input establishes ordinary Git configuration and hook behavior
on disposable state. [Computer capabilities](computer-parity.md) owns product
admission; fixture results do not qualify a live connector or user configuration.

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

The existing workspace-shell MCP lane now uses the fixture's repository and
synthetic HOME. With full Git approval it checks user/XDG config, a relative
include, configured hook execution and refusal, path-scoped commit with a
foreign staged file, byte-preserving unstage, and outside-path denial. Without
full Git approval the user config remains unavailable. A symlink from the
allowed config directory to the outside canary stays denied; an owner-owned
`~/.gitconfig` symlink inside HOME is readable, while one pointing outside
HOME makes the shell start refuse before dispatch.
The test host's synthetic HOME is sealed in its launch contract. The desktop
uses the OS account home in that same field while retaining the connector's
private process HOME in Dev; a verified shell launch with an unbound home is
refused. Neither route copies user config or credentials into the fixture.

Issue the ordinary `git config`, `git add`, `git restore --staged`, `git commit`
and readback commands through `computer_shell_start/read`. The fixture's native
`runGit` is the reference, not the system under test. Do not export HOME or force
Git configuration inside each command to conceal missing production wiring.
Do not pass a new caller-controlled environment bypass merely to satisfy tests.

The managed writer under synthetic `.codex/worktrees` remains a reference-only
part of this fixture. The product continues to refuse source roots inside the
user's protected `.codex` store. Existing linked-worktree MCP tests cover a
normal writer outside that store with its exact approved Git metadata. A
second approved non-Git root and a new connector generation still need their
own tests for this user-config behavior.

Without full Git approval shell still uses a temporary HOME and sets
`GIT_CONFIG_GLOBAL=/dev/null`. The reference negative control shows why a
successful `git status`/HEAD alone misses global identity, includes and hooks.
The new MCP assertions are local sandbox/package evidence only; actual owner
Git configuration and the live new connector remain unqualified.

The [fixture source](../tests/fixtures/ordinary-git-environment.mjs) and
[self-tests](../tests/fixtures/ordinary-git-environment.selftest.mjs) own its exact
inputs and assertions. See [Git configuration](https://git-scm.com/docs/git-config)
for normal include semantics.

---

[Documentation index](README.md) · [Project overview](../README.md)

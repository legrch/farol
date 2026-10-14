# Shell toolchains and Git hooks

Root-scoped Shell retains ordinary Git configuration, includes and hooks.
The release declaration pins supported system executables, including
`/usr/bin/env`. Adding this executable does not allow its child to read,
write or execute outside the existing approved roots and mount boundaries.

An `env` shebang resolves its interpreter through the command's constrained
PATH. An interpreter and its libraries must be supported platform resources
or live inside an approved workspace. A project can select its approved
interpreter explicitly, for example `PATH="$PWD/.venv/bin:$PATH" git commit`.
A virtual-environment symlink to an unapproved external runtime still refuses.
Shell does not inherit arbitrary host environment variables or disable hooks.

The native Git fixture exercises ordinary configuration and three real hooks,
including a symlinked Python `commit-msg` hook using `env`. That fixture
explicitly read-approves CLT; it does not prove that an installed owner profile
implicitly grants the system Python framework. Production interpreter selection
and the real installed workflow remain separate acceptance checks.

The declared platform assurance remains protected host pathnames and pinned
bytes. A code-signing trust-chain claim is not made by these fixtures.

The CLT Python declaration is a finite standard-library subset, separate from
workspace authorization. The physical Python executable and its framework
launcher are pinned in the existing executable selection. The protected
`bin/python3` alias must resolve exactly to `python3.9`; its identity, target and
metadata are rechecked. Selected library files retain checked descriptors;
root-owned directory listings are verified for import discovery. Listing a
module does not grant its file data. Unselected modules, third-party packages,
external runtimes and redirected aliases remain outside this platform support.
Project dependencies still require their ordinary approved workspace scope.

The finite resource predicate is compiled once so the existing native argv and
byte budgets remain unchanged. Files remain data-only and write-protected;
network, mount and credential rules are unchanged. This relies on the existing
protected-host-pathname trust assumption, not an atomic pathname-exec or signing
claim. Qualification checks compare checked-in expectations; they never adopt
new host bytes because an installed toolchain changed.

`TestNativePinnedPythonGitHooks` uses the product declaration with no CLT
workspace grant. It covers real symlinked Python commit-msg, Python pre-commit,
intentional hook rejection with unchanged HEAD, system attributes and linked
worktree commits. Its disposable synthetic HOME is host-composition test state;
there is no command-level Git HOME/config suppression. Native policy success is
separate from built Go Shell, Dev, production installation and owner acceptance.

Outside-scope native controls invoke the hook/interpreter directly and verify
that execution or data access refuses. They are separate from a real admitted
hook rejecting Git commit. Git can skip a hook that its executable-access check
cannot see; confinement alone does not certify mandatory hook discovery for an
unapproved hook path. Do not report that case as successful hook enforcement.

Native Shell preparation requires current checks for every root in the admitted
scope. An unchecked sibling workspace stays refused; it must not be omitted or
silently approved. That refusal is `PROCESS_PREPARATION_WORKSPACE_STALE`, not
`PROCESS_FILESYSTEM_UNSUPPORTED`. The latter reports measured native filesystem
or mount limitations. A preparation refusal creates no command handle and never
authorizes automatic replay.

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

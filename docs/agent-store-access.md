# Agent store workspace access

The directories named `.codex` and `.claude` follow ordinary Computer
workspace policy. Their names do not cause a mandatory denial in the Go file
adapter, TypeScript native file adapter, workspace selection, or shell profile.
This permits observing coding-agent worktrees and sessions, and editing files
when the owner and task both grant write access.

## Scope and authority

An approved read scope permits list/read/search/bootstrap, not mutation. An
approved write scope can permit create/write/edit. Shell still requires its
separate command capability and workspace verification; a shell issued with
write disabled does not acquire workspace write access.

A root can be the agent directory, a descendant such as a worktree, or an
already-approved enclosing folder. In particular, an existing home-directory
grant now covers these directories unless the owner explicitly excludes them.
This is an intentional change in the effective scope of existing parent grants,
not an automatic creation of a new grant. Contents, including any credential
files, follow that scope; this policy does not inspect or redact file contents.

Explicit exclusions, task narrowing, expiry, revocation, root identity checks,
no-follow file traversal, write source-digest/collision checks and uncertain
mutation outcomes retain their existing semantics. This change does not grant
network access, outside-root access, or a full-access execution mode.

Only the two agent directory names are removed from mandatory denial lists.
Other protected names and home stores remain unchanged. Git history and linked
worktree metadata still require their existing separate approval; granting an
agent directory alone is not a Git metadata approval.

## Verification

`tests/unit/agent-store-access.test.ts` checks the exact remaining policies,
ordinary authority and the generated shell profile with synthetic paths. The
Go `agentstores_test.go` checks descriptor policy without opening any agent
directory. These are not native filesystem or installed-runtime witnesses.

The existing native read, mutation and shell integration suites contain agent
store cases using disposable synthetic directories. Run them in an authorized
local test environment before release. An older enclosing sandbox which still
blocks these names must not be weakened or bypassed to make the tests pass.

The Python helper bytes and attestation are unchanged. A source commit is not an
installed fix: use the normal reviewed, attested package and activation path.

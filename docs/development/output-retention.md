# Output retention

Whoever creates disk output removes it. Retention is explicit, bounded and
reported. Nothing accumulates silently in `_output`, Docker or a private
recovery store.

The reviewed Tunnel Client build input occupies one fixed
`_output/tunnel-client` slot, verified before embedding by
`tooling/tunnel-client-artifact.mjs`. It is a current dependency input, not a
versioned archive or a source of authority for other unknown output.

## Rules

1. **Creators clean up.** A producer removes its own scratch on success, failure
   and cancellation. Examples are the Go stop helper (`go-dev-control-*`), the
   compiler output (`go-artifact-*`, `go-backend-*`) and testops volumes. The one
   exception is an outcome-unknown or refused effect: a refused Dev stop and a
   native fixture of an unknown host attempt are retained as evidence on purpose.
2. **No retired images.** `task dev` discards the previous Dev image after the
   new one is published and verified. See [Source setup](setup.md).
3. **Orphans are reaped only when provably finished.** Owned scratch carries an
   `.owner` record (pid, process start time, process group), written by
   `tooling/owned-scratch.mjs`. It is removed once that process, its group and
   every reference to the path (command lines and open files) are gone. A
   killed creator is therefore still cleaned up. An entry in an unknown state
   is kept and reported, never guessed at.
4. **Evidence has a budget.** Lane roots declared in `tooling/evidence-cases.mjs`
   and every evidence name the tracked source reads by path are never removed
   automatically; they only count toward the budget. Other evidence
   directories are removed once finished and older than 7 days: an owner record
   shows them finished, or they have been quiet for an hour with no open file or
   command-line reference. There is no size-based removal; size pressure shows
   up through the budget guard.
5. **Builds live in GitHub Releases.** Locally, keep only the current
   `_output/package` candidate and the current Dev image. Do not keep copies of
   packages or of the installed application as an accumulating archive. The
   owner-approved exception is one necessary `previous.app` for the current
   update, managed by the existing update/recovery owner and its journal. It
   remains while an active update or retained rollback consumer needs it;
   release requires confirmed completion of those consumers. UNKNOWN and
   unfinished operations retain their original evidence, never cleanup authority.
   Downloading a predecessor from a qualified Release asset requires separate
   digest, restore-path and installed acceptance. It is not established by this
   retention policy or a reason to remove the input the existing helper needs.

## Commands

| Command              | Effect                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `task output:status` | Lists every `_output` entry as current, protected, active, kept, removable or unknown, with sizes.    |
| `task output:prune`  | Removes what is removable. Keeps everything else.                                                     |
| `task disk:status`   | Runs `output:status` plus the [testops volume](testops-pilot.md) status. Run it at the end of a task. |

`task dev`, `task dev:clean` and `task ci` start with a prune. If `_output`
still exceeds its 15 GB budget afterwards, they refuse to start and print the
largest unknown and active entries. Status and prune stay available. The
budget counts everything that can accumulate, including `_output/testops` runs,
which prune never removes. It excludes only outputs replaced in place and
protected evidence. A partial prune reports every removal it completed and exits
non-zero.

## Limits

These are cooperative rules for crash recovery and well-behaved agents. They do
not isolate processes of the same account, and they do not provide a hard disk
quota: a parallel run can still grow after the start check. An entry that
nothing claims stays "unknown" until someone resolves it, so the budget check
makes it visible instead of letting it hide.

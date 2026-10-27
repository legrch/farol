# Output retention

Whoever creates disk output removes it. Retention is explicit, bounded and
reported. Nothing accumulates silently in `_output`, Docker or a private
recovery store.

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
   and the roots that other tooling reads (Hunt, test scopes) are never removed
   automatically; they only count toward the budget. Other evidence directories
   are removed once finished: an owner record shows them finished, or they have
   been quiet for an hour with no open file or command-line reference. They are
   then removed after 7 days, or oldest first while finished undeclared evidence
   exceeds 2 GB.
5. **Builds live in GitHub Releases.** Locally, keep only the current
   `_output/package` candidate and the current Dev image. Do not keep copies of
   packages or of the installed application. A rollback downloads the
   qualified release asset and checks its digest.

## Commands

| Command              | Effect                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `task output:status` | Lists every `_output` entry as current, protected, active, kept, removable or unknown, with sizes.    |
| `task output:prune`  | Removes what is removable. Keeps everything else.                                                     |
| `task disk:status`   | Runs `output:status` plus the [testops volume](testops-pilot.md) status. Run it at the end of a task. |

`task dev`, `task dev:clean` and `task ci` start with a prune. If `_output`
still exceeds its 15 GB budget afterwards, they refuse to start and print the
largest unknown and active entries. Status and prune stay available.

## Limits

These are cooperative rules for crash recovery and well-behaved agents. They do
not isolate processes of the same account, and they do not provide a hard disk
quota: a parallel run can still grow after the start check. An entry that
nothing claims stays "unknown" until someone resolves it, so the budget check
makes it visible instead of letting it hide.

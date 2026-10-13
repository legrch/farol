# Installed preserved Computer maintenance

The explicit `tooling/recover-installed-preserved-chat.mjs` entry is closed owner
maintenance for an empty consumed Chat lifetime with retained Computer records.
It is separate from empty-store maintenance and never runs during normal startup,
reconnect or an update. The owner selects the exact failed run, Quit, configuration,
source/build, Chat roots/head/lifecycle, access digest and complete mutation set.

Existing Desktop and Computer leases plus fresh absence checks for the installed
application, connector and backend exclude cooperating owners. The Go inspector
holds every existing journal claim through preservation and complete readback.
Chat must have no turns, results or retirement, and Task must remain empty. The
failed Quit must be newer than the selected run and contain only `go-core`, with
optional `connector`. Other failed components refuse maintenance.

Retained Computer records may include canonical completed or known failed v3
connector file outcomes, canonical v4 **read-only** reservations, and canonical
v6 results with observed supervisor exit. Read-only results retain cleanup
uncertainty. Write-capable results qualify only with positive group and descendant
cleanup; root or supervisor exit alone cannot exclude continuing workspace writes.
Accepted results retain their original exit code, output and cleanup fields. Every referenced v5
output chunk must be independently selected and match its exact selected parent,
stream, offset and digest; orphan or missing chunks refuse inspection. Every
identity, filename and full-byte SHA-256 is independently selected, with an exact
bounded inventory of 1 to 128 records. Unresolved write-capable reservations,
unknown schemas, partial file operations, changed bytes, missing/extra entries,
aliases, unsafe modes and reused generations refuse.

No Computer record is deleted, rewritten, retried or promoted to a terminal
outcome. Original reserved operation IDs remain durably reserved in the same
repository; maintenance does not create a replacement operation journal or grant
execution. Historical reserved processes remain unresolved; known process results keep
their original cleanup classifications. Preservation does not establish cleanup
of arbitrary detached descendants, completion of any reserved operation or a
clean original Quit. Selected unresolved reservations are read-only and retain
their original confinement. Known write-capable results are not permission to
repeat their commands or to upgrade their cleanup observations.

The complete empty Chat history and original failed run/Quit are preserved in
`chat-retired-<operation-id>`. A new maintenance owner receives its own ACK and
observed terminal. `installedPreservedLifetime` describes only that new owner's
completion; it records the original lifetime's missing retirement/ACK/terminal.
Settings, credentials, browser profile, Computer access and mutation records stay
unchanged. The pending intent fences startup until host readback and archival
finish; an unknown effect is never automatically retried.

Qualification uses disposable native stores and a built Go child, real pipe
ACK/terminal observation, exact journal retention and subsequent cold startup.
Those tests do not establish installed recovery or external Shell acceptance;
record both separately against the exact committed package before release.

## Explicit recovery after a machine restart

A known write-capable result with unverified descendant cleanup remains refused
by ordinary maintenance. An explicit owner-selected cold-machine plan is a
separate path. Its genuine before-session observation is selected by an
independently pinned SHA-256; the local owner controller is trusted for that
selection. This is not an authentication mechanism against a malicious local
owner, and the path is not exposed through runtime Computer tools.

The plan binds the failed run, Quit, configuration, profile and access hashes and
the complete selected record inventory. The host refuses a raw selection that
tries to supply the privileged before-session value. It checks the private
plan's exact bytes, original state and inventory, then requires a different
actual `kern.bootsessionuuid`. The Go inspector independently reads the current
native session and rechecks it while the original storage claims remain held.
Neither a caller-supplied current UUID, an app restart nor elapsed time qualifies.
The kernel property is read-only in [Apple's XNU source](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c).

Use `--cold-restart-plan PATH --cold-restart-plan-sha SHA256` only with explicit
installed preserved maintenance and the owner-selected plan prepared before the
machine restart. This path permits preservation of known supervisor-exit write
results after exclusion of processes from that prior machine session. It does
not alter their historical cleanup fields, settle reserved operations, admit
unknown write reservations, replay commands or replace the original failed Quit
with a successful one. The new maintenance owner still needs its own observed
ACK and terminal and the ordinary exact-source/package/process/lease gates.

Disposable native-store tests with a synthetic boot transition are storage and
policy evidence. The real same-session test proves refusal. Neither establishes
a successful live machine restart or installed recovery; those remain separate
owner-controlled qualification steps.

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

The only retained Computer records accepted are canonical completed or known
failed v3 connector file outcomes, and canonical v4 **read-only** process
reservations. Every identity, filename and full-byte SHA-256 is independently
selected, with an exact bounded inventory of 1 to 128 records. Unresolved
write-capable processes, unknown schemas, partial file operations, changed bytes,
missing/extra entries, aliases, unsafe modes and reused generations refuse.

No Computer record is deleted, rewritten, retried or promoted to a terminal
outcome. Original reserved operation IDs remain durably reserved in the same
repository; maintenance does not create a replacement operation journal or grant
execution. Historical process terminal and descendant cleanup remain unconfirmed.
This does not prove absence of arbitrary detached descendants; the selected
unresolved executions are read-only and retain their original confinement.

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

# Startup recovery availability

An unconfirmed predecessor run still fences Computer and normal host admission.
The desktop now opens a recovery document before starting configuration, Go,
local runtimes, provider views, MCP or update actions. It retains the existing
startup promotion lease for the recovery window's complete lifetime.

The recovery document uses the existing attested shell/preload entries. Its
fixed local document fragment selects React recovery rendering; an explicit
host-only preload argument selects an API containing only Quit. Normal desktop
IPC handlers are never installed in this branch. New browser UI source under
`apps/desktop/renderer` has the same host-import restrictions as `src/ui`.

Quit closes this window and releases its own startup exclusion. It never writes
a clean predecessor receipt, removes the predecessor marker, changes saved
configuration, or repeats an operation. A second launch can reveal the same
window, but retains `reopen-failed` as the normal-readiness acknowledgement.
The primary emits `primary-recovery`, distinct from `primary-started`.

This is availability and custody, not automatic retirement of unknown work.
Previous operation outcomes and descendants still need independent recovery
before normal Computer access resumes. No reboot-based automatic retirement
is claimed. Native tests use synthetic predecessor records in disposable state;
they do not prove cleanup of an arbitrary crashed process or a live provider.

## Explicit Go recovery composition

The Go executable supports an explicitly selected `serve --startup-mode recovery` route for an existing qualified profile. The trusted host supplies the same physical root, owner/Computer identity and exact host/child lifetime; store mode must be `open`. Selection happens before a constructor runs. Creation, claimed previous drain, mutation storage, Shell metadata and Codex read selection are refused in this mode before inherited input or native owners are opened.

This composition holds the existing Computer authority claim and exposes only `computer.authority.deactivate`, `computer.authority.publish`, `computer.settings.list`, `computer.settings.search` and `computer.settings.snapshot`, plus transport status. Publication is the original state-changing Go CAS with a real current Settings projection and its exact ACK. A decoded snapshot or caller-built publication does not authorize a query. Computer-only publication omits Task metadata; this runtime has no Task source resolver. Current grants, generations, physical workspace identities, exclusions, file policy, query budgets and authority withdrawal retain their existing application owners. An absent Search grant still refuses Search.

Chat/lifecycle/handoff/results, Task journals, mutation journals, mutable filesystem adapters, Shell and connectors are not composed. Their existing files and UNKNOWN records remain in place, including when an independent mutation writer retains its own claim. Successful reads and Close convey no clean predecessor retirement, original-operation ACK, replay permission or process/descendant settlement. Close withdraws this view, cancels and joins actual in-flight returns before releasing its owned authority/profile descriptors; a cancelled read cannot disclose a late result.

The typed desktop launcher can select this mode once and rejects contradictory metadata before profile consumption or spawn. Normal launch retains its original handoff requirements. The recovery document above does not yet select this Go route: saved-profile loading, the host publication source and UI read controls still require their own bounded integration and native acceptance. Do not classify the source foundation as automatic startup recovery or installed availability.

The disposable `TestNativeRecovery*` tests exercise native Go stores/filesystem, an unretired Chat generation, a real retained UNKNOWN mutation record, fresh owner publication, list/search/snapshot, query/Close custody and CLI framing with an exact capability list. They preserve original file bytes, modes, identities and modification metadata, while the synthetic owner fixture deliberately permits new authority publications. They do not exercise a separate backend OS process, Electron selection, arbitrary interrupted native effects, original Settings storage, live providers, production profiles or process-group/descendant cleanup.

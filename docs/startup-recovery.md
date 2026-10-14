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

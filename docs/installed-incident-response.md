# Installed application incident response

An owner report that Farol will not launch, reconnect, or install an update is an
incident. Restoring a usable installed application takes priority over feature
work and broad acceptance or repeated formal review cycles.

## Restore first

1. Establish the exact installed path, version, observed failure, and owned
   process state. Preserve the existing application, profile, workspaces,
   connection settings, journals, and recovery evidence using recoverable moves.
2. Select a known working package or a bounded hotfix. Run relevant regression,
   type, and static checks, inspect the owned diff, and commit coherent source.
   Build with `task package` from clean committed bytes; retain compiler,
   dependency, source, resource, and package attestation.
3. Verify the packaged application's actual startup, normal quit, and reopen
   with disposable state. These checks establish packaged lifecycle behavior;
   they do not establish the installed profile or live connection.
4. Restore the owner's authorized installation promptly. If OTA cannot recover,
   use the explicit replacement path. Prefer `/Applications/Farol.app` when the
   owner has authorized that destination. Keep the previous application and
   recovery evidence until the replacement has been read back and launched.
5. Verify the installed application's startup and connection, then perform
   bounded real Computer checks: files, Bash/Git, process cancellation, and
   reconnect. Record source, packaged, installed, and live results separately.
6. Resume aggregate acceptance and risk-based formal review after restoring
   usability. Report open findings and limitations explicitly. An emergency
   installation does not by itself authorize public release or accepted-main
   advancement.

The Lead should use existing owner grants for diagnostics and installation rather
than repeatedly asking for them. A machine restart interrupts other applications
and requires an explicit owner decision when it is necessary.

## Preserve uncertain work

Recovery must not replay an operation with an unknown outcome, invent process
cleanup evidence, discard journals, reset credentials, or replace a working
profile with an empty one. When prior write descendants cannot be excluded, use
the explicit preserved-state recovery contract and genuine native evidence.
A failed notice acknowledgement or uncertain idle observation must not alone
prevent a separately authorized manual update; integrity and process ownership
checks remain effective.

## Evidence and follow-up

Retain the incident's failing observation, selected source and package identity,
representative checks, exact installation result, and first successful live
operation. Each incident should add regression coverage for its actual cause.
Track broader acceptance and deferred findings after restoration instead of
holding the user's working installation behind another complete review ladder.

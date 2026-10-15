# Go installed slot-binding publication

Go-aware desktop builds select the existing bundled `farol-backend` for immutable
`farol.installed-operation-slot/1` publication. The owning Release application
service is `modules/release/app/services/slotbinding`; its physical adapter is
`modules/release/infra/native/slotbinding`. No second update journal, updater
controller, profile owner or installation authority is created.

The selected source route is `main.initializeInstalledUpdater` → the existing
installed update runtime → `publishInstalledOperationBinding` →
`farol-backend publish-installed-slot-binding --build-id <compiled identity>` →
the Go Release service and publisher. Boot handles this one-shot mode before
ordinary backend/profile initialization. The compiled build identity must match
before inherited descriptors are consumed.

## Host adapter and resource custody

TypeScript retains Electron composition, canonical request encoding, resource
attestation, pipe/child lifetime ownership and correlation with the existing
update admission. The host selects its independently compiled core declaration;
it never trusts a digest freshly measured from the executable. The existing
installed execution snapshot supplies an accepted private immutable image.
Explicit supervisory composition can supply its separately verified controller
resources. The same core executable verifier checks native format, platform,
size, digest and physical path before launch and after the original child closes.
The image owner must retain immutability through that lifetime.

The original operation directory remains held by the host. Its inherited fd4
copy belongs to the child; the Go native publisher borrows it without closing or
seeking it. Bounded canonical bytes arrive through fd3 with a fixed deadline.
Only the child-owned copies close. The existing host rechecks named operation
and parent identities, enforces its original timeout, and waits for the same
child's actual close even after requesting termination.

No selected Go failure dispatches Python. Explicit legacy/controller composition
without a compiled Go declaration retains the old string/helper route for its
separate compatibility exit. The Python helper resource remains required by
apply/recover/rollback and cannot yet be removed from package manifests. The
historically named `update-archive.py` is already a Go executable; its suffix is
not interpreter evidence.

## Publication and uncertainty

Go validates the exact canonical bytes, including historical Python JSON Unicode
escaping. It binds private owner/type/inode/link metadata, reads existing bytes
without rewriting a matching inode, and refuses a different immutable binding.
New publication uses one exclusive temporary, bounded complete write, file fsync,
checked close, no-overwrite link, exact-owned temporary removal, directory fsync
and exact readback. Operations stay relative to the borrowed directory.

Before a possible mutation, cancellation can refuse. A failure after possible
mutation remains unknown; that publisher lifetime refuses replay. Cross-process
unknown protection stays with the existing update runtime/admission: it fences
before publication and clears only after the exact success receipt and postflight
checks. Visible bytes, exit requests, timeouts and a generic child failure cannot
clear that fence. This capability does not grant apply, rollback or relaunch.

## Acceptance limits and retirement

Portable Go tests exercise real disposable descriptors, filesystem publication,
faults and canonical values. Host tests exercise actual source selection with
mocked admission/process ports, native-format fixture attestation, malformed or
lost receipts and original-child cleanup. They do not execute an installed app.

macOS filesystem/descriptor behavior, packaged child execution, clean-Mac first
launch, installed update and OTA/rollback remain NOT RUN until separately
qualified in their real environments. Removing the legacy publication consumer
requires those gates and explicit compatibility retirement. Removing
`resources/native/update_helper.py` additionally requires complete Go
apply/recovery/rollback, promotion-lease, predecessor-closure, journal, private
relaunch and interrupted-operation parity; this publication slice does not supply
that acceptance.

# Shell mount boundaries

The new candidate class is `system-apfs-kernel-mount-boundaries-v1` on the
explicitly qualified macOS build. It supports approved roots on the system APFS
volume, including a HOME with nested NFS or device filesystems. Other root
volumes, remote roots and unknown filesystem facts refuse before reservation
with `PROCESS_FILESYSTEM_UNSUPPORTED`. The original
`local-apfs-no-nested-mounts-v1` class retains its restrictions.

## Enforcement

Preparation obtains the native mount list, canonicalizes APFS Data aliases and
seals known mounted subtrees as read/write/execute denials. It checks that they
cannot contain the command cwd, scratch, a pinned executable or protected
application. The same list and directory identities are checked before execution.
A changed topology refuses that original operation rather than rebuilding its
policy or extending its deadline.

Each approved root and operation-private scratch additionally has a kernel deny
for filesystem access whose mount root is not `/` or filesystem is not APFS.
The qualified macOS kernel reports system Data firmlinks under logical mount root
`/`; testing only the `statfs` mount name `/System/Volumes/Data` denied the ordinary
positive controls. The kernel predicate applies on every access, including new
mounts after the confined process starts. It includes direct and Data spellings
and does not grant access outside the existing roots. Read-only scope, image
protection, network policy and authority expiry remain independent restrictions.

## Native evidence and limits

On 12 October 2026 the actual Go compiler passed disposable HFS+ and APFS cases
in read-only and writable modes. The helper was already running before a late
mount was attached. It checked the original mount, late mount and replacement
mount through direct names, Data aliases and symlinks. Every mounted read,
write and execution returned permission denial. Ordinary reads and execution
passed through the same aliases; ordinary writes passed only in writable mode.
A separately compiled native executable supplied the positive execution control.
All owned images were detached by the original test cleanup.

The ordinary Git native fixture also passed with continuous mount enforcement:
Bash project FAIL/fix/PASS, Git init/status/diff/add/commit/log, ordinary global and
repository config includes, and actual template hooks. These are native fixture
results. They do not establish package, installed/external acceptance or complete
descendant settlement. The root mounted at `/` and trusted host integrity remain
assumptions; this is not protection against a host administrator replacing the OS.

## Rejected alternatives retained

An earlier static-path-only experiment blocked existing mounts but allowed a
late-mounted read and write. A directory sandbox-extension experiment likewise
allowed a late-mounted read. Neither qualifies continuous isolation, and polling
cannot undo an access already completed. Their source and original observations
remain retained privately; they were not activated or released.

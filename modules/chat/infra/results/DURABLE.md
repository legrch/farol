# Durable result storage adapter

`NewNative(ctx, lifetime, Root, JournalScope, Limits, mode)` implements the frozen
`port.DurableResults` contract. `Root{Path, ProfileID, Identity}` comes from trusted
boot and names the existing qualified Chat directory. `mode` is exactly `create`
or `open`. Darwin and Linux have the native adapter; other targets refuse it.
There is no boot activation in this slice.

`create` creates only a never-existing `chat-results` child with mode 0700 and an
immutable 0600 claim binding version 1, original profile and both physical roots.
`open` requires that exact existing private child and claim. It never recreates,
repairs, replaces, removes or discovers a root. The permanent claim has an
exclusive nonblocking flock for the live owner. Close releases only this owner's
descriptors; it preserves every file and is not clean-retirement evidence.

Each result has an immutable `.attempt` canonical record and `.commit` SHA-256
marker. Names hash the version namespace, profile, backend and operation identity;
they contain no raw IDs, provider metadata or payload. The closed canonical
version-1 record covers both physical roots and the complete original binding,
result, immutable conversation metadata and payload. Receipt publication returns
the raw canonical SHA-256 and byte count, at most 65536 bytes. Empty payload has
one canonical spelling; generic binary payload stays exact. Conversation metadata
uses `RetainedConversation.Valid`. Returned payloads and receipts are independent.

Native IO checks effective UID, exact modes, no symlinks, regular files with one
link, descriptor/named identity and stable file metadata before and after IO. It
checks the supplied root path, fixed child and physical parent-child relation.
Files and directories are synced and immutable writes receive durable readback.
Every operation scans the closed inventory and validates old records too. Orphan
attempts/commits, malformed/noncanonical data, bad digests, UNKNOWN markers and
unexpected inventory fence the owner. This qualification follows the existing
native patterns; it is not a sandbox against arbitrary same-UID adversarial
mutations between checks, or a guarantee against arbitrary storage/power failure.

`TextLimits()` supplies 8192 payload bytes, 1024 records and 8 MiB total payload.
Smaller positive limits may be configured. Every retained record, including older
backend generations and empty payloads, counts toward saturation. There is no
eviction. Codec/global safety limits apply to every loaded record; configured
smaller limits restrict new retention while preserving access to exact historical
publications that fit the global limits.

Retain accepts only the current profile/backend scope. Exact duplicates may
return the original receipt only if this live owner already knows successful
publication; changed records refuse. Reopened committed bytes cannot establish a
successful Retain retry and an attempted exact replay fences the owner. Read
requires a supplied full original binding/result/publication, keeps its original
profile/backend/metadata, and exposes no discovery API. It performs **no current
authorization**. Lead's historical service must first qualify the original
terminal publication and fresh current read authority, then recheck authority
before exposing content. Storage alone grants no Send, ACK, admission or Follow.

Fence is one-shot durable best effort even after a known commit or cancelled
caller. A failed marker stays sticky in this owner and is never retried. A valid
commit followed by a failed UNKNOWN marker cannot reveal a lost/late caller
outcome on reload. That boundary remains explicitly unqualified: independent
journal/terminal evidence and trusted boot reopen authority remain mandatory.

Pure injected storage fixtures test canonical bytes, exact publication,
historical matching, live-only duplicates, saturation, concurrent ownership,
readback/inventory failures, cancellation, sticky fencing and the failed-marker
reload limitation. `TestNativeResult*` uses only disposable temporary roots for
filesystem/claim qualification. Neither lane establishes app, browser, provider,
child-process, boot, package, installed or original-terminal acceptance. Native
runs require the Lead's explicit lane grant; ordinary development test commands
must select an anchored pure-test expression.

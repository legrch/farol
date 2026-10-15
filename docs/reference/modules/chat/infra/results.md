# Lifetime result retention

`NewMemory(lifetime, port.JournalScope, TextLimits())` implements the existing
Chat-owned `port.ResultRetention`. Inject the same profile/backend scope and
lifetime used by the real lifecycle owner. Root owns composition; this package
adds no transport, endpoint, journal or browser behavior.

The current text subset holds at most 1,024 results, 8 KiB per payload and 8 MiB
of payload bytes in total. Smaller positive limits may be injected. Metadata and
map entries are bounded separately by result count and existing 120-byte IDs/codes.
The adapter copies exact payload bytes before returning the existing receipt.
A matching known duplicate observes its existing receipt; changed full binding,
result metadata or payload conflicts without overwriting stored bytes. Capacity
refuses a new result without evicting any old one. Errors do not authorize retries.

Client result ACK remains a lifecycle action through the already admitted opaque
Conversation handle. Frame ACK, reading/rendering, local close and request-body
booleans cannot ACK or purge this store. This first slice conservatively retains
all results, including acknowledged results, until backend lifetime closure. The
existing queue also bounds admitted turns over that lifetime. No individual purge
or new ACK receipt is added. Existing Conversation.Result/Events/Resume supply
client delivery; the store has no lookup or new authority API for request IDs.

Root stops the owner and ends its exact lifetime before calling Close. Close refuses
an active lifetime, then drops only owned RAM references. It is not secure erasure,
quiescence or clean-retirement evidence. All answer bytes are volatile: a backend
crash/restart loses them. A renderer/client reconnect to the same live backend can
observe its retained result; reconnect/restart must not Send again. This package
never loads an old result, reconstructs admission, replaces a journal claim or
claims durable restart delivery. Root's admission/restart reconciliation must keep
unknown work fenced when bytes are unavailable. The content-free lifecycle journal
records metadata and never supplies missing answer bytes. Activity gets no payload.

CPU tests cover real copies, bounds, conflict/no eviction, lifetime shutdown and the
actual lifecycle + browser Exchange adapter with this production retention owner.
The journal and Exchange in those tests are strict doubles. They do not qualify
native persistence, the pipe, Electron/provider delivery, restart recovery or the
installed product. Normal serve wiring remains Root-owned and unverified here.

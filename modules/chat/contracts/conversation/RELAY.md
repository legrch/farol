# In-flight Computer call ownership

This additive source facade uses the existing caller-relay callback/result-return
path. Root must associate the actual relay operation with its exact opaque Chat
`Handle` before invoking these methods. No new browser command, endpoint, wire
schema, tool registry or admission engine is introduced.

1. Obtain `Handle.ComputerContext(ctx)` after the actual prepared turn has been
   submitted, accepted and has an observed reply ID. It includes the immutable
   logical binding, exact slot/view/document/provider conversation generations,
   provider user/reply IDs and source watermark. A tools-disabled, unprepared,
   closed, unknown, pending-journal or retired owner refuses. These DTOs correlate
   the callback; they do not confer authority.
2. Call `Handle.BeginComputer(ctx, context, producerCallID)` exactly once. Chat
   validates the actual running owner and commits the existing content-free
   `request-computer` transition before returning an opaque `ComputerCall`.
   Duplicate or changed IDs cannot acquire another effect token. Root maps the
   existing relay operation ID to this token; the relay's original operation
   deduplication and argument fingerprint remain its responsibility.
3. Capture `Handle.Admission()` from the same owning lifecycle handle. Computer
   must recheck this existing live projection through its current guard at every
   qualified phase. Its separate permission, execution lease and effect lifecycle
   remain Computer-owned. No prompt, body ID, history receipt or cached terminal
   handle can substitute for the live projection. Root dispatches the selected
   capability once, after known begin; Chat executes no tool in this slice.
4. After the existing relay returns the exact result, trusted Root calls
   `ComputerCall.AcknowledgeReturn(ctx, ack)` with the captured context, exact
   producer call ID and `Returned=true`. This is positive **host result-return**
   evidence, not proof that the provider consumed the result. Chat durably commits
   the existing `resolve-computer`. A boolean from an untrusted caller is not an
   ACK producer; Root owns validating this receipt and its actual return boundary.
5. Subsequent real provider observations use the existing `Handle.Observe`,
   incremental stream, queue, retention and initiating-client result ACK. Host
   return alone creates neither answer text nor terminal completion. Content-free
   status observations may advance the watermark during a call; the captured
   return context and physical/logical identities remain exact.

Missing/lost/negative result ACK leaves the call outstanding and lease unavailable.
No resolve, effect reexecution, replacement Send or inferred ACK occurs. An explicit
late exact host ACK may settle it if the same running owner remains qualified.
Journal uncertainty withdraws all positive admission and is never retried. Cancel
or retirement fencing rejects late results. Admission freeze permits only the
existing call's settlement; it cannot start another call. Used call IDs remain
bounded tombstones in the existing Turn, including after known resolution.

The journal records identities and existing request/resolve metadata only. Tool
arguments, result text, prompts and answers are not journal payloads. This slice
adds no activity history or tool-body retention.

CPU/race fixtures exercise the real lifecycle, facade, SSE encoder and bounded
memory retainer with controlled browser/journal/relay/Computer ports. Effect counts
are simulated. They do not qualify the actual external Responses server, relay
producer/ACK return transport, Computer permissions/native IO, DOM, provider,
restart recovery, packaged or installed behavior. Root owns those integration
links and aggregate checks. Existing text Responses frames do not gain function
call wire events from this slice.

# Browser exchange attachment

Source-only Chat adapter. No Root wire/schema/method name is declared here.

Root imports this package and implements the consumer-owned Exchange interface:

    Exchange(context.Context, browser.Command) (browser.Reply, error)

Command and Reply are sealed interfaces with exactly six value variants. The
published exchange.go is the complete field contract. Use a type switch and map
fields explicitly to/from canonical generated DTOs; do not JSON-marshal these
in-process types into a second protocol. No arbitrary invoke/eval/URL/cookies exist.

Construct with New(lifetimeContext, Scope{ProfileID,BackendGeneration}, exchange,
clock). The lifetime is the exact existing backend; Clock supplies UTC epoch
milliseconds. Each command carries its exact absolute DeadlineMillis. The adapter
also supplies a cancellation context with the remaining deadline budget and checks
both lifetime and deadline after the reply. Root must unblock Exchange on context
cancellation. A late/error/malformed reply returns a classified unknown without
retry/fallback. Invalid input refuses before Exchange. Binding/lease/profile/backend,
model intent/proof and semantic size are checked at this seam. Root owns request ID,
encoded-frame bounds before decode, transport outcomes and physical one-shot witness
consumption. The existing lifecycle owner still owns queue/intent/result/ACK rules.

The six value pairs are PrepareCommand/PreparedReply, VerifySendCommand/VerifiedReply,
SendCommand/SentReply, ObserveCommand/ObservedReply, CancelCommand/CancelledReply and
DisposeCommand/DisposedReply. All IDs/generations/selection/provenance fields are
mapped without coercion. Observe sequence and limits retain the existing port bounds;
returned events are copied. Scope comes from trusted Root composition, never DOM.

ResultRetention dependency audit at the assigned normal-host composition base
60185993c40ac39b00cd7f0aea220e844d9fd6b7 plus Chat checkpoint 3ca6b69d:
boot/nativeruntime.go creates lifecycle.Service with only Gate and Journal. Search
of production Go modules/boot/transport/resources found no implementation of
port.ResultRetention.Retain, only the port and service callers. Existing Retain
implementations are test fixtures. The content-free lifecycle journal does not store
answer bytes. This adapter does not create a result repository or claim durable
retention. Root must supply an explicitly qualified retention owner before normal
model execution; an in-memory smoke store, if selected, proves only that lifetime.

Source checks use strict CPU exchanges. They do not qualify the pipe/mailbox,
Electron/browser, physical accepted sends, filesystem result durability or providers.

The provider-binding refinement adds Binding.ProviderState (home/bound),
Observation.ProviderConversationID for a correlated Accepted event, Target.Required
and VerifySendCommand.Required, and independent ControlFact/SelectionFacts DTOs.
Verification.Pinned is configured correlation; Observed holds only field facts and
Required echoes the pinned control policy. Home has no CID, Bound has a real CID.
NewSaved must not be returned as already Saved. Map these fields explicitly in the
canonical Root DTOs. Desktop owns independent public-control capture, catalogue
mapping and atomic witness revalidation/consumption; an echo is not DOM evidence.

# Task parent Chat authority peer

`New` accepts the actual retained `chat/contracts/admission.Current` and a trusted
Root `Selection`: the original external parent thread/turn plus all six fields
of that parent's selected Chat binding. These are independent associations; the
peer never derives a parent thread from TaskID, an owner ID or request body IDs.
Root must establish the association to the exact facade before construction.

`RecheckParent` provides only the parent part of Task's Authority port. Each call
requires the original parent and one current, complete, exactly matching Chat
projection. Missing/inactive, stale/foreign, unsettled, cancelled and broken
callback states fail closed. The synchronous callback performs value checks only:
no IO, effects, reentry, admission minting or lifecycle mutation. Positive checks
are never cached. A successful read is not a transport delivery permit across
later awaited work; the owning delivery route still needs its real fence/ACK.

CPU tests use a private published-contract double seam, following the existing
Computer admission peer pattern. Public construction accepts only the concrete
published facade. Positive actual-owner construction/settlement belongs to a
Lead Root aggregate: obtain the same admitted `conversation.Handle.Admission()`
and explicitly associate its real caller scope with this Selection, then check
completion/revoke invalidation. No neighbor app/domain/infra imports are needed
in this peer. Tests do not qualify the real Chat lifecycle or native/provider
operation, parent delivery, startup registration or product acceptance.

No resolver, config/account/host check, journal, provider or execution engine is
implemented. Root composes this peer with the remaining Task Authority delegate;
normal startup, facade routing and native qualification remain separate work.

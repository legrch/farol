package boot

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	handoff "github.com/legrch/farol/modules/chat/app/services/handoff"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	chatrepo "github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
	"github.com/legrch/farol/transport/desktop"
)

// Composition retains the actual owner receipt; the Chat handoff service owns
// publication, ACK, terminal and successor policy. No journal projection is
// promoted to a proof here. Completed Chat turns require exact durable results,
// explicit delivery ACK, and independently confirmed browser settlement.
type nativeRetirement struct {
	mu                         sync.Mutex
	binding                    chatport.HandoffBinding
	repo                       *handoffrepo.Repository
	service                    *handoff.Service
	attempted                  bool
	previousHostDrainConfirmed bool
	publication                *chatport.HandoffPublication
}

func handoffRoots(launch NativeLaunch, chat NativeRoot) handoffrepo.Roots {
	return handoffrepo.Roots{
		ProfileID: launch.Profile.ProfileID,
		Parent:    handoffrepo.Root{Path: launch.Profile.Root, Identity: chatport.JournalRoot{Device: launch.Profile.Device, Inode: launch.Profile.Inode, OwnerUID: chat.OwnerUID}},
		Chat:      handoffrepo.Root{Path: chat.Path, Identity: chatport.JournalRoot{Device: chat.Device, Inode: chat.Inode, OwnerUID: chat.OwnerUID}},
	}
}

func newNativeRetirement(ctx context.Context, launch NativeLaunch, generation string, chat NativeRoot) (*nativeRetirement, error) {
	roots := handoffRoots(launch, chat)
	repo, err := handoffrepo.New(ctx, roots)
	if err != nil {
		return nil, err
	}
	service, err := handoff.New(repo)
	if err != nil {
		return nil, errors.Join(err, repo.Close())
	}
	return &nativeRetirement{
		binding: chatport.HandoffBinding{ProfileID: roots.ProfileID, BackendGeneration: generation, BuildID: BuildID, HostLifetimeID: launch.HostLifetimeID, ChildLaunchID: launch.ChildLaunchID, ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity},
		repo:    repo, service: service, previousHostDrainConfirmed: launch.PreviousHostDrainConfirmed,
	}, nil
}

func (r *nativeRetirement) openJournal(ctx context.Context, mode string, root chatrepo.Root, limits chatrepo.Limits) (*chatrepo.Repository, error) {
	head, err := r.repo.Load(ctx)
	if err != nil {
		return nil, err
	}
	if mode == "create" {
		if head == nil || head.Record != nil {
			return nil, handoff.Refused
		}
		return chatrepo.New(ctx, root, limits)
	}
	if !r.previousHostDrainConfirmed || head == nil || head.Record == nil {
		return nil, handoff.Refused
	}
	attempt, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	next := chatport.JournalScope{ProfileID: r.binding.ProfileID, BackendGeneration: r.binding.BackendGeneration}
	successor, err := r.service.Consume(ctx, head.Record.Publication, chatport.HandoffConsumption{PreviousHostDrainConfirmed: r.previousHostDrainConfirmed, Next: next, NextBinding: r.binding, AttemptID: attempt})
	if err != nil {
		return nil, err
	}
	// Consume fences this exact attempt before journal/open/handshake. Any later
	// error retains that fence; no constructor fallback or replacement generation.
	return chatrepo.NewAfterRetirement(ctx, root, successor.Scope, limits, successor.Proof)
}

func retirementDigest(value string) ([32]byte, error) {
	var digest [32]byte
	bytes, err := hex.DecodeString(value)
	if err != nil || len(bytes) != len(digest) || hex.EncodeToString(bytes) != value {
		return digest, handoff.Invalid
	}
	copy(digest[:], bytes)
	if digest == ([32]byte{}) {
		return digest, handoff.Invalid
	}
	return digest, nil
}

func retirementOutcome(shape string, value any, err error) (*desktop.Outcome, error) {
	if err != nil {
		status, code := "unknown", "NATIVE_RETIREMENT_UNKNOWN"
		var classified handoff.Code
		if errors.As(err, &classified) {
			code = string(classified)
			if classified != handoff.Unknown {
				status = "refused"
			}
		}
		return &desktop.Outcome{Status: status, Code: code}, nil
	}
	raw, err := json.Marshal(value)
	if err != nil || wire.Validate(shape, raw) != nil {
		return nil, handoff.Unknown
	}
	return &desktop.Outcome{Status: "ok", Data: raw}, nil
}

func (r *NativeRuntime) retirementMethods() map[string]desktop.Method {
	if r.retirement == nil {
		return nil
	}
	state := r.retirement
	return map[string]desktop.Method{
		"core.retirement.prepare": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.CoreRetirementPrepare
			if request.OperationID == "" || chatDecode("CoreRetirementPrepare", request, &in) != nil {
				return invalidIngress()
			}
			state.mu.Lock()
			defer state.mu.Unlock()
			if state.attempted {
				return retirementOutcome("", nil, handoff.Refused)
			}
			state.attempted = true
			if err := r.settingsDelivery.freezeForRetirement(ctx); err != nil {
				return retirementOutcome("", nil, err)
			}
			if err := r.mutations.freezeForRetirement(); err != nil {
				return retirementOutcome("", nil, err)
			}
			if err := r.chat.FreezeAdmissions(ctx); err != nil {
				return retirementOutcome("", nil, err)
			}
			if _, err := r.ingress.guard.deactivate(); err != nil {
				return retirementOutcome("", nil, err)
			}
			origin, err := r.chat.Retire(ctx)
			if err != nil {
				return retirementOutcome("", nil, err)
			}
			if err = r.browser.QuiescePolling(); err != nil {
				return retirementOutcome("", nil, err)
			}
			if r.settingsStore != nil {
				if err := r.settingsStore.QuiescePolling(); err != nil {
					return retirementOutcome("", nil, err)
				}
			}
			publication, err := state.service.Capture(ctx, state.binding, in.HandoffId, origin)
			if err != nil {
				return retirementOutcome("", nil, err)
			}
			state.publication = publication
			return retirementOutcome("CoreRetirementPrepared", wire.CoreRetirementPrepared{HandoffId: publication.HandoffID, ReceiptDigest: hex.EncodeToString(publication.ReceiptDigest[:])}, nil)
		}},
		"core.retirement.ack": {Concurrent: true, Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
			var in wire.CoreRetirementACK
			if request.OperationID == "" || chatDecode("CoreRetirementACK", request, &in) != nil {
				return invalidIngress()
			}
			state.mu.Lock()
			defer state.mu.Unlock()
			digest, err := retirementDigest(in.ReceiptDigest)
			if err != nil || state.publication == nil || state.publication.HandoffID != in.HandoffId || state.publication.ReceiptDigest != digest {
				return retirementOutcome("", nil, handoff.Refused)
			}
			ack, err := state.service.Acknowledge(ctx, chatport.HandoffACK{Publication: *state.publication})
			if err != nil {
				return retirementOutcome("", nil, err)
			}
			return retirementOutcome("CoreRetirementAcknowledged", wire.CoreRetirementAcknowledged{HandoffId: in.HandoffId, ReceiptDigest: in.ReceiptDigest, AckDigest: hex.EncodeToString(ack[:])}, nil)
		}},
	}
}

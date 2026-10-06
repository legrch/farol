package boot

import (
	"context"
	"fmt"
	"math"
	"reflect"
	"strconv"

	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/modules/computer/domain/authority"
	admissionpeer "github.com/legrch/farol/modules/computer/infra/peer/admission"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// The private interface makes the Root admission join testable at the native
// storage boundary. Public production construction still takes the concrete
// qualified Store; it cannot select a weaker authority owner.
type computerIngressStore interface {
	computerport.AccessRepository
	Status(context.Context) (accessrepo.Status, error)
	UpdateApproval(context.Context, uint64, authority.Approval) error
	Admit(context.Context, uint64, authority.Admission, authority.ParticipantAdmission) (*authority.Participant, error)
}

func currentConversation(ctx context.Context, current *chatct.Current, expected conversation.Binding) error {
	if current == nil {
		return computerUnavailable()
	}
	return current.WithCurrent(ctx, func(v *chatct.TaskBinding) error {
		if v == nil || v.OwnerID != expected.OwnerID || v.SessionID != expected.SessionID || v.TaskID != expected.TaskID || v.TaskEpoch != expected.TaskEpoch || v.ParticipantID != expected.ParticipantID || v.TurnID != expected.TurnID {
			return computerUnavailable()
		}
		return nil
	})
}

// bindConversation records Computer membership for an ALREADY admitted Chat
// owner. It never calls Chat.Admit or invents a participant from tool arguments.
// This first attachment is one-shot and requires an inactive known publication.
// The returned route is retained by trusted Root for this exact live turn.
// A new call may select a bounded read lease; it must not repeat this attachment
// or renew a previous read after uncertainty. Existing historical participants
// do not authorize a new attachment or restoration of the Chat owner.
func (s *ComputerIngress) bindConversation(ctx context.Context, operation string, binding conversation.Binding, current *chatct.Current, workspaces []string) (*ComputerRoute, error) {
	return s.bindConversationIntent(ctx, operation, binding, current, workspaces, computerReadIntent)
}

// The intent is selected at the first attachment. A retained read route is never
// replaced with a wider route when a later tool asks to write.
func (s *ComputerIngress) bindConversationIntent(ctx context.Context, operation string, binding conversation.Binding, current *chatct.Current, workspaces []string, intent computerConversationIntent) (*ComputerRoute, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || s.store == nil || s.native == nil || binding.ProfileID != s.peer.ProfileId || binding.BackendGeneration != s.peer.BackendGeneration || binding.OwnerID != s.ownerID {
		return nil, computerUnavailable()
	}
	s.effects.Lock()
	defer s.effects.Unlock()
	if s.retiring {
		return nil, computerUnavailable()
	}
	if err := currentConversation(ctx, current, binding); err != nil {
		return nil, err
	}
	s.mu.Lock()
	publication, unknown := s.publication, s.unknown
	s.mu.Unlock()
	if unknown || publication == nil {
		return nil, computerUnavailable()
	}
	fence, e := strconv.ParseUint(publication.receipt.Fence, 10, 64)
	if e != nil || !s.guard.inactive(fence) {
		return nil, computerUnavailable()
	}
	revision, e := strconv.ParseUint(publication.receipt.StoreRevision, 10, 64)
	if e != nil || revision == math.MaxUint64 {
		return nil, computerUnavailable()
	}
	policy, ownership, e := conversationIntentPolicy(publication.approval, workspaces, intent)
	if e != nil {
		return nil, e
	}
	before, e := s.store.Status(ctx)
	if e != nil || !before.ApprovalPresent || before.Revision != revision || before.Generation != publication.approval.Generation {
		return nil, computerUnavailable()
	}
	authorityID, e := randomIngressID()
	if e != nil {
		return nil, e
	}
	input := authority.Admission{Identity: authority.Identity{OwnerID: binding.OwnerID, SessionID: binding.SessionID, TaskID: binding.TaskID, TaskEpoch: binding.TaskEpoch}, AuthorityID: authorityID, ComputerID: s.computerID, ComputerGeneration: publication.approval.Generation, Policy: policy}
	clock := s.clock
	if clock == nil {
		clock = accessrepo.Clock{}
	}
	grant, e := authority.Derive(publication.approval, input, clock.Now())
	if e != nil {
		return nil, e
	}
	participantInput := authority.ParticipantAdmission{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: ownership}
	expected, e := authority.Create(*grant, participantInput)
	if e != nil {
		return nil, e
	}
	if e = currentConversation(ctx, current, binding); e != nil {
		return nil, e
	}
	if !s.guard.inactive(fence) {
		return nil, computerUnavailable()
	}
	if e = s.claim(operation); e != nil {
		return nil, e
	}
	participant, e := s.store.Admit(ctx, revision, input, participantInput)
	if e != nil {
		if accessrepo.OutcomeUnknown(e) {
			s.poison()
		}
		return nil, e
	}
	fail := func() (*ComputerRoute, error) { s.poison(); return nil, fmt.Errorf("COMPUTER_ADMISSION_UNKNOWN") }
	if participant == nil || !reflect.DeepEqual(*participant, *expected) || ctx.Err() != nil {
		return fail()
	}
	// AuthorityID is fresh for this original attachment, so a known success must
	// be its one insertion. Exact-existing admission is not this recovery route.
	after, e := s.store.Status(ctx)
	if e != nil || !after.ApprovalPresent || after.Revision != revision+1 || after.Generation != publication.approval.Generation {
		return fail()
	}
	if e = currentConversation(ctx, current, binding); e != nil {
		return fail()
	}
	peer, e := admissionpeer.NewChat(current)
	if e != nil {
		return fail()
	}
	route, e := computerRoute(s.store, &activatedAdmission{guard: &s.guard, fence: fence, current: peer}, execution.Ceiling{Participant: *participant, Approval: publication.approval}, s.native, clock)
	if e != nil {
		return fail()
	}
	if e = s.guard.activate(fence); e != nil || ctx.Err() != nil {
		return fail()
	}
	return route, nil
}

// readConversation is the Root join for one correlated relay call. RequestComputer
// is durable before membership or workspace access. Only the opaque returned call
// may later acknowledge the exact host return; a known read is not that ACK.
func (s *ComputerIngress) readConversation(ctx context.Context, h *conversation.Handle, correlation conversation.ComputerContext, operation, callID, workspaceID, relativePath string) (*workspacect.ReadResponse, *conversation.ComputerCall, error) {
	response, call, _, err := s.readConversationOnRoute(ctx, h, correlation, operation, callID, workspaceID, relativePath, nil)
	return response, call, err
}

// A retained route is the original immutable owner/ceiling selection, never a
// retained permission decision or execution lease. Root can select a fresh lease
// for a distinct call in this SAME live turn; unknown calls cannot reach here.
func (s *ComputerIngress) readConversationOnRoute(ctx context.Context, h *conversation.Handle, correlation conversation.ComputerContext, operation, callID, workspaceID, relativePath string, route *ComputerRoute) (*workspacect.ReadResponse, *conversation.ComputerCall, *ComputerRoute, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || h == nil || !validIngressID(operation) || !validIngressID(callID) || !validIngressID(workspaceID) {
		return nil, nil, nil, computerUnavailable()
	}
	current, err := h.Admission()
	if err != nil {
		return nil, nil, nil, err
	}
	if err = currentConversation(ctx, current, correlation.Binding); err != nil {
		return nil, nil, nil, err
	}
	call, err := h.BeginComputer(ctx, correlation, callID)
	if err != nil {
		return nil, nil, nil, err
	}
	if route == nil {
		route, err = s.bindConversation(ctx, operation, correlation.Binding, current, []string{workspaceID})
	} else {
		// Keep the original route even after withdrawal; its lease checks must
		// refuse. Never repair it by re-publication, re-admission or restoration.
		err = s.claim(operation)
	}
	if err != nil {
		return nil, call, nil, err
	}
	b := correlation.Binding
	contract, err := route.selectContract(ctx, operationBinding(b.OwnerID, b.SessionID, b.TaskID, b.TaskEpoch, b.ParticipantID, b.TurnID), authority.Read)
	if err != nil {
		return nil, call, route, err
	}
	response, err := contract.Read(ctx, workspacect.ReadRequest{OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: b.TurnGeneration, CallID: callID, WorkspaceID: workspaceID, RelativePath: relativePath})
	return response, call, route, err
}

package boot

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"sync"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	execution "github.com/legrch/farol/modules/computer/app/services/execution"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	admissionpeer "github.com/legrch/farol/modules/computer/infra/peer/admission"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

// ComputerIngress belongs to trusted root composition. It never restores live
// membership from history, an operation body or approval. Publication and actual
// Chat admission are separate one-shot effects. The first slice admits only fresh
// ordinary list/read intents; it performs no browser/provider dispatch.
type ComputerIngress struct {
	effects             sync.Mutex // serializes publication/admission IO, never current guards
	mu                  sync.Mutex
	guard               activationFence
	store               computerIngressStore
	chat                *chatlifecycle.Service
	readFacade          *conversation.Facade
	conversations       *ChatIngress
	readIntents         map[string]*capturedReadIntent
	native              computerport.Workspace
	clock               computerport.Clock
	peer                wire.Context
	ownerID, computerID string
	used                map[string]bool
	tasks               map[string]bool
	turns               map[string]bool
	unknown             bool
	publication         *knownComputerPublication
	route               *ComputerRoute
}
type knownComputerPublication struct {
	receipt   wire.ComputerAuthorityPublication
	approval  authority.Approval
	taskCodex *codexclient.AuthoritySnapshot
}

func NewComputerIngress(store *accessrepo.Store, chat *chatlifecycle.Service, native *filesystem.Workspace, peer wire.Context, ownerID, computerID string) (*ComputerIngress, error) {
	if store == nil || chat == nil || native == nil || !validIngressID(ownerID) || !validIngressID(computerID) || validateIngress("Context", peer) != nil {
		return nil, computerUnavailable()
	}
	return &ComputerIngress{store: store, chat: chat, native: native, peer: peer, ownerID: ownerID, computerID: computerID, used: make(map[string]bool), tasks: make(map[string]bool), turns: make(map[string]bool)}, nil
}
func validIngressID(id string) bool { return len(id) <= 120 && validateIngress("id", id) == nil }
func validateIngress(name string, v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	return wire.Validate(name, b)
}
func randomIngressID() (string, error) {
	var b [16]byte
	if _, e := rand.Read(b[:]); e != nil {
		return "", e
	}
	return hex.EncodeToString(b[:]), nil
}
func (s *ComputerIngress) claim(operation string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unknown || !validIngressID(operation) || s.used[operation] || len(s.used) >= 4096 {
		return computerUnavailable()
	}
	s.used[operation] = true
	return nil
}
func (s *ComputerIngress) poison() {
	// Withdraw before all separate storage/Chat cleanup. Unknown never permits a
	// replay, replacement route or a fresh journal in another root.
	_, _ = s.guard.deactivate()
	s.mu.Lock()
	s.unknown = true
	s.mu.Unlock()
}
func (s *ComputerIngress) Deactivate(ctx context.Context, operation string) (*wire.ComputerAuthorityDeactivateResponse, error) {
	if ctx == nil || ctx.Err() != nil {
		return nil, computerUnavailable()
	}
	if e := s.claim(operation); e != nil {
		return nil, e
	}
	fence, e := s.guard.deactivate()
	if e != nil {
		return nil, e
	}
	status, e := s.store.Status(ctx)
	if e != nil {
		return nil, e
	}
	return &wire.ComputerAuthorityDeactivateResponse{Fence: strconv.FormatUint(fence, 10), StoreRevision: strconv.FormatUint(status.Revision, 10)}, nil
}
func (s *ComputerIngress) Publish(ctx context.Context, operation string, in wire.ComputerAuthorityPublishRequest) (*wire.ComputerAuthorityPublication, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || validateIngress("ComputerAuthorityPublishRequest", in) != nil {
		return nil, computerUnavailable()
	}
	approval, e := parseDesktopApproval(in.Approval, s.ownerID, s.computerID)
	if e != nil {
		return nil, e
	}
	currentTask, e := s.parsePublishedCodex(in.TaskCodex, approval)
	if e != nil {
		return nil, e
	}
	fence, e := strconv.ParseUint(in.Fence, 10, 64)
	if e != nil {
		return nil, e
	}
	revision, e := strconv.ParseUint(in.ExpectedStoreRevision, 10, 64)
	if e != nil {
		return nil, e
	}
	if !s.guard.inactive(fence) {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	republished := s.publication != nil && s.publication.receipt.Fence == in.Fence
	s.mu.Unlock()
	if republished {
		return nil, computerUnavailable()
	}
	if e := s.claim(operation); e != nil {
		return nil, e
	}
	if e := s.store.UpdateApproval(ctx, revision, approval); e != nil {
		if accessrepo.OutcomeUnknown(e) {
			s.poison()
		}
		return nil, e
	}
	status, e := s.store.Status(ctx)
	if e != nil || revision == math.MaxUint64 || status.Revision != revision+1 || status.Generation != approval.Generation || !status.ApprovalPresent || ctx.Err() != nil {
		s.poison()
		return nil, fmt.Errorf("COMPUTER_PUBLICATION_UNKNOWN")
	}
	digest, e := json.Marshal(approval)
	if e != nil {
		s.poison()
		return nil, e
	}
	h := sha256.Sum256(digest)
	receipt := wire.ComputerAuthorityPublication{Fence: in.Fence, StoreRevision: strconv.FormatUint(status.Revision, 10), SettingsRevision: in.SettingsRevision, Generation: strconv.FormatUint(approval.Generation, 10), ApprovalDigest: hex.EncodeToString(h[:]), PublishOperationId: operation}
	s.guard.mu.Lock()
	defer s.guard.mu.Unlock()
	if s.guard.active || s.guard.exhausted || s.guard.revision != fence {
		s.mu.Lock()
		s.unknown = true
		s.mu.Unlock()
		return nil, fmt.Errorf("COMPUTER_PUBLICATION_UNKNOWN")
	}
	s.mu.Lock()
	s.publication = &knownComputerPublication{receipt: receipt, approval: approval.Clone(), taskCodex: currentTask}
	s.mu.Unlock()
	return &receipt, nil
}
func (s *ComputerIngress) Admit(ctx context.Context, operation string, in wire.ChatComputerAdmissionRequest) (*wire.ChatComputerAdmissionResponse, error) {
	s.effects.Lock()
	defer s.effects.Unlock()
	if ctx == nil || ctx.Err() != nil || validateIngress("ChatComputerAdmissionRequest", in) != nil || !validIngressID(in.SessionId) || !validIngressID(in.TaskId) || !validIngressID(in.TurnId) {
		return nil, computerUnavailable()
	}
	s.mu.Lock()
	publication := s.publication
	duplicate := s.tasks[in.TaskId] || s.turns[in.TurnId]
	s.mu.Unlock()
	if publication == nil || publication.receipt != in.Publication || duplicate {
		return nil, computerUnavailable()
	}
	fence, _ := strconv.ParseUint(in.Publication.Fence, 10, 64)
	revision, _ := strconv.ParseUint(in.Publication.StoreRevision, 10, 64)
	if !s.guard.inactive(fence) {
		return nil, computerUnavailable()
	}
	policy, e := readIntentPolicy(publication.approval, in.WorkspaceIds)
	if e != nil {
		return nil, e
	}
	participantID, e := randomIngressID()
	if e != nil {
		return nil, e
	}
	authorityID, e := randomIngressID()
	if e != nil {
		return nil, e
	}
	// Validate the current native publication and the complete narrowed grant
	// before the first Chat journal effect. A stale/expired proposal must not
	// create a stranded live Chat membership. Store.Admit rechecks at commit.
	statusBefore, e := s.store.Status(ctx)
	if e != nil || !statusBefore.ApprovalPresent || statusBefore.Revision != revision || statusBefore.Generation != publication.approval.Generation {
		return nil, computerUnavailable()
	}
	admission := authority.Admission{Identity: authority.Identity{OwnerID: s.ownerID, SessionID: in.SessionId, TaskID: in.TaskId, TaskEpoch: 1}, AuthorityID: authorityID, ComputerID: s.computerID, ComputerGeneration: publication.approval.Generation, Policy: policy}
	if _, e := authority.Derive(publication.approval, admission, (accessrepo.Clock{}).Now()); e != nil {
		return nil, e
	}
	if e := s.claim(operation); e != nil {
		return nil, e
	}
	s.mu.Lock()
	s.tasks[in.TaskId] = true
	s.turns[in.TurnId] = true
	s.mu.Unlock()
	binding := conversation.Binding{ProfileID: s.peer.ProfileId, BackendGeneration: s.peer.BackendGeneration, OwnerID: s.ownerID, SessionID: in.SessionId, TaskID: in.TaskId, TaskEpoch: 1, ParticipantID: participantID, TurnID: in.TurnId, OperationID: operation, TurnGeneration: 1}
	// Epoch/generation1 belong ONLY to a newly recorded Task/Turn. They are never
	// derived from Computer generation, a restored ProductTask or startup metadata.
	raw, _ := json.Marshal(in)
	digest := sha256.Sum256(raw)
	if s.readFacade == nil {
		s.readFacade = conversation.New(s.chat)
	}
	if s.readIntents == nil {
		s.readIntents = make(map[string]*capturedReadIntent)
	}
	handle, e := s.readFacade.AdmitReadIntent(ctx, binding, hex.EncodeToString(digest[:]))
	if e != nil || handle == nil {
		s.poison()
		return nil, fmt.Errorf("CHAT_ADMISSION_UNKNOWN")
	}
	if !s.guard.inactive(fence) || ctx.Err() != nil {
		s.poison()
		return nil, fmt.Errorf("CHAT_ADMISSION_UNKNOWN")
	}
	// Retain the actual owner before further Computer IO. An uncertain later
	// boundary remains captured and poisoned; it cannot become a fresh admission.
	captured := &capturedReadIntent{owner: handle, binding: binding, fence: fence}
	s.readIntents[operation] = captured
	admitted, e := handle.Current()
	if e != nil {
		s.poison()
		return nil, e
	}
	participant, e := s.store.Admit(ctx, revision, admission, authority.ParticipantAdmission{ParticipantID: binding.ParticipantID, Role: authority.Main, MutationOwnership: authority.NoOwnership})
	if e != nil || participant == nil || ctx.Err() != nil {
		s.poison()
		return nil, fmt.Errorf("COMPUTER_ADMISSION_UNKNOWN")
	}
	current, e := admissionpeer.NewChat(admitted)
	if e != nil {
		s.poison()
		return nil, e
	}
	guarded := &activatedAdmission{guard: &s.guard, fence: fence, current: current}
	route, e := computerRoute(s.store, guarded, execution.Ceiling{Participant: *participant, Approval: publication.approval}, s.native, accessrepo.Clock{})
	if e != nil {
		s.poison()
		return nil, e
	}
	status, e := s.store.Status(ctx)
	if e != nil || revision == math.MaxUint64 || status.Revision != revision+1 || ctx.Err() != nil {
		s.poison()
		return nil, fmt.Errorf("COMPUTER_ADMISSION_UNKNOWN")
	}
	s.guard.mu.Lock()
	defer s.guard.mu.Unlock()
	if s.guard.active || s.guard.exhausted || s.guard.revision != fence {
		s.mu.Lock()
		s.unknown = true
		s.mu.Unlock()
		return nil, fmt.Errorf("COMPUTER_ADMISSION_UNKNOWN")
	}
	s.mu.Lock()
	s.route = route
	s.mu.Unlock()
	s.guard.active = true
	response := wire.ChatComputerAdmissionResponse{OwnerId: binding.OwnerID, SessionId: binding.SessionID, TaskId: binding.TaskID, TaskEpoch: "1", ParticipantId: binding.ParticipantID, TurnId: binding.TurnID, Generation: "1", AdmissionOperationId: operation, StoreRevision: strconv.FormatUint(status.Revision, 10)}
	retained := response
	captured.admission = &retained
	captured.route = route
	captured.access, captured.activation = s.store, &s.guard
	captured.seal = execution.Ceiling{Participant: participant.Clone(), Approval: publication.approval.Clone()}
	return &response, nil
}
func readIntentPolicy(a authority.Approval, ids []string) (authority.Policy, error) {
	hasList, hasRead := false, false
	for _, capability := range a.Capabilities {
		hasList = hasList || capability == authority.List
		hasRead = hasRead || capability == authority.Read
	}
	if !hasList || !hasRead || len(ids) < 1 || len(ids) > 32 {
		return authority.Policy{}, computerUnavailable()
	}
	policy := authority.Policy{Capabilities: []authority.Capability{authority.List, authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: a.ExpiresAt}
	selected := make(map[string]bool)
	for _, id := range ids {
		if !validIngressID(id) || selected[id] {
			return authority.Policy{}, computerUnavailable()
		}
		selected[id] = true
		found := false
		for _, w := range a.Workspaces {
			if w.WorkspaceID == id {
				policy.Workspaces = append(policy.Workspaces, authority.Scope{WorkspaceID: id, Root: w.Root, Mode: authority.Subtree, Access: authority.ReadAccess})
				found = true
				break
			}
		}
		if !found {
			return authority.Policy{}, computerUnavailable()
		}
	}
	for _, e := range a.ExcludedPaths {
		if selected[e.WorkspaceID] {
			policy.ExcludedPaths = append(policy.ExcludedPaths, e)
		}
	}
	return policy, nil
}
func (s *ComputerIngress) selectedRoute() (*ComputerRoute, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.unknown || s.route == nil {
		return nil, computerUnavailable()
	}
	return s.route, nil
}

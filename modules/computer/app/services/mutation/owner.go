package mutation

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// OwnerSelection is supplied by the trusted composition, not selected by a
// renderer body. Generation binds the admitted attempt; it is never a new key.
// ProfileID isolates the durable owner operation from other application profiles.
type OwnerSelection struct {
	OperationID, OwnerID, ProfileID, ComputerID string
	ComputerGeneration                          uint64
}

type OwnerRequest struct {
	WorkspaceID string
	Operation   Operation
}

type OwnerResponse struct {
	OperationID, WorkspaceID string
	ComputerGeneration       uint64
	Phase, Publication       string
	Scratch                  state.ScratchBinding
	Receipt                  *Receipt
	Failure                  *Failure
}

type OwnerService struct {
	selected OwnerSelection
	engine   *Service
}

func (s OwnerSelection) identity() state.Identity {
	return state.Identity{Scope: state.ScopeOwnerSettings, OperationID: s.OperationID,
		OwnerID: s.OwnerID, ProfileID: s.ProfileID, ComputerID: s.ComputerID}
}
func (s OwnerSelection) valid() bool {
	return state.Identifier(s.OperationID, 160) && state.Identifier(s.OwnerID, 80) &&
		state.Identifier(s.ProfileID, 160) && state.Identifier(s.ComputerID, 120) && s.ComputerGeneration <= state.MaxSafeInteger
}

// NewForOwnerExecution captures one current owner approval and a fixed ordinary
// lease. No Task/participant, durable admission or native effect is synthesized.
func NewForOwnerExecution(ctx context.Context, selected OwnerSelection, current port.CurrentOwnerApproval, repository port.MutationRepository, native port.MutableWorkspace, digester port.MutationDigester, gate Gate, clock port.Clock) (*OwnerService, error) {
	if !selected.valid() || current == nil || repository == nil || native == nil || digester == nil || gate == nil || clock == nil {
		return nil, invalid()
	}
	now := clock.Now()
	owner := &ownerAuthority{selected: selected, source: current, clock: clock, deadline: now.Add(authority.OrdinaryExecutionLifetime)}
	if ctx != nil {
		if d, ok := ctx.Deadline(); ok && d.Before(owner.deadline) {
			owner.deadline = d
		}
	}
	if err := owner.live(ctx); err != nil {
		return nil, err
	}
	if err := owner.withCurrent(ctx, func(a authority.Approval) error {
		if err := owner.matches(a); err != nil {
			return err
		}
		owner.initial = a.Clone()
		if a.ExpiresAt.Before(owner.deadline) {
			owner.deadline = a.ExpiresAt
		}
		return owner.live(ctx)
	}); err != nil {
		return nil, err
	}
	if err := owner.live(ctx); err != nil {
		return nil, err
	}
	return &OwnerService{selected: selected, engine: &Service{owner: owner, operationID: selected.OperationID,
		repository: repository, native: native, digester: digester, gate: gate, clock: clock, deadline: owner.deadline}}, nil
}

func (s *OwnerService) Execute(ctx context.Context, r OwnerRequest) (*OwnerResponse, error) {
	if s == nil || s.engine == nil {
		return nil, invalid()
	}
	if err := ValidateOwnerRequest(r); err != nil {
		return nil, err
	}
	op := convert(r.Operation)
	digest, err := s.engine.digester.Digest(port.MutationDigestInput{WorkspaceID: r.WorkspaceID, Operation: op.Clone()})
	if err != nil || !state.SHA256(digest) {
		return nil, authority.Fail("COMPUTER_MUTATION_FINGERPRINT_FAILED", "operation-store")
	}
	binding := state.Binding{Identity: s.selected.identity(), WorkspaceID: r.WorkspaceID,
		ComputerGeneration: s.selected.ComputerGeneration, RelativePath: op.Path(), RequestDigest: digest}
	out, err := s.engine.executeBound(ctx, binding, op)
	if err != nil {
		return nil, err
	}
	return ownerResponse(s.selected, r.WorkspaceID, out), nil
}

// ValidateOwnerRequest is pure. Composition may reject malformed intent before
// beginning an execution lifetime; Execute independently enforces the same rule.
func ValidateOwnerRequest(r OwnerRequest) error {
	if !state.Identifier(r.WorkspaceID, 120) {
		return invalid()
	}
	return state.ValidateInput(convert(r.Operation))
}

func ownerResponse(selected OwnerSelection, workspaceID string, out *attemptResult) *OwnerResponse {
	return &OwnerResponse{OperationID: selected.OperationID, WorkspaceID: workspaceID, ComputerGeneration: selected.ComputerGeneration,
		Phase: out.Phase, Publication: out.Publication, Receipt: out.Receipt, Failure: out.Failure}
}

// A retained result is metadata. Observation neither renews write authority nor
// dispatches a mutation. The root must select the same trusted owner/profile and
// the original persisted operation/generation, even after approval changes.
type OwnerObservation struct{ WorkspaceID, RelativePath string }
type OwnerRecords interface {
	Load(context.Context, state.Identity) (*state.State, error)
}
type OwnerObserver struct {
	selected OwnerSelection
	records  OwnerRecords
}

func NewOwnerObserver(selected OwnerSelection, records OwnerRecords) (*OwnerObserver, error) {
	if !selected.valid() || records == nil {
		return nil, invalid()
	}
	return &OwnerObserver{selected: selected, records: records}, nil
}

func (s *OwnerObserver) Observe(ctx context.Context, r OwnerObservation) (*OwnerResponse, error) {
	if s == nil || s.records == nil || ctx == nil || ctx.Err() != nil || !state.Identifier(r.WorkspaceID, 120) || !state.RelativePath(r.RelativePath) {
		return nil, invalid()
	}
	record, err := s.records.Load(ctx, s.selected.identity())
	if err != nil {
		return nil, storeUnavailable()
	}
	if ctx.Err() != nil {
		return nil, authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	if record == nil {
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_NOT_FOUND", "operation-store")
	}
	return observeOwnerRecord(s.selected, r, record, "durable")
}

// Observe retains a known memory-only terminal result in the current lifetime.
// A prepared peer is re-read without admitting, saving, tombstoning or executing.
func (s *OwnerService) Observe(ctx context.Context, r OwnerObservation) (*OwnerResponse, error) {
	if s == nil || s.engine == nil || ctx == nil || ctx.Err() != nil || !state.Identifier(r.WorkspaceID, 120) || !state.RelativePath(r.RelativePath) {
		return nil, invalid()
	}
	s.engine.gate.Lock()
	if s.engine.pending {
		s.engine.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_IN_PROGRESS", "operation-store")
	}
	var cached *state.State
	publication, blocked := s.engine.publication, s.engine.blocked
	if s.engine.terminal != nil && s.engine.terminal.Phase() != state.Prepared {
		copy := s.engine.terminal.Clone()
		cached = &copy
	}
	s.engine.gate.Unlock()
	if ctx.Err() != nil {
		return nil, authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	if cached == nil && blocked != nil {
		// This lifetime already lost or refused its attempt. A later apparently
		// empty read cannot downgrade that fence into permission to start over.
		return nil, blocked
	}
	if cached != nil {
		return observeOwnerRecord(s.selected, r, cached, publication)
	}
	observer := OwnerObserver{selected: s.selected, records: s.engine.repository}
	return observer.Observe(ctx, r)
}

func observeOwnerRecord(selected OwnerSelection, r OwnerObservation, record *state.State, publication string) (*OwnerResponse, error) {
	binding := record.Binding()
	if _, err := state.Restore(binding, record.Phase(), record.Receipt(), record.Failure()); err != nil {
		return nil, storeUnavailable()
	}
	if binding.Identity != selected.identity() || binding.ComputerGeneration != selected.ComputerGeneration || binding.WorkspaceID != r.WorkspaceID || binding.RelativePath != r.RelativePath {
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
	if receipt := record.Receipt(); receipt != nil && receipt.RelativePath != r.RelativePath {
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
	out := ownerResponse(selected, r.WorkspaceID, resultOf(record, publication))
	out.Scratch = binding.Scratch
	return out, nil
}

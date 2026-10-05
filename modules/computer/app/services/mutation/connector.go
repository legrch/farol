package mutation

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// ConnectorOwner is selected by the authenticated profile composition. Stable
// operation identity survives a connector lifetime; it confers no authority.
type ConnectorOwner struct {
	OperationID, OwnerID, ProfileID, ComputerID string
}

type ConnectorSelection struct {
	ConnectorOwner
	ComputerGeneration uint64
	Origin             state.ConnectorOrigin
}

type ConnectorRequest struct {
	WorkspaceID string
	Operation   Operation
}

type ConnectorResponse struct {
	OperationID, WorkspaceID, RelativePath string
	ComputerGeneration                     uint64
	Origin                                 state.ConnectorOrigin
	Phase, Publication                     string
	Receipt                                *Receipt
	Failure                                *Failure
}

type ConnectorService struct {
	selected ConnectorSelection
	engine   *Service
}

func (s ConnectorOwner) identity() state.Identity {
	return state.Identity{Scope: state.ScopeConnector, OperationID: s.OperationID,
		OwnerID: s.OwnerID, ProfileID: s.ProfileID, ComputerID: s.ComputerID}
}

func (s ConnectorOwner) valid() bool {
	return state.Identifier(s.OperationID, 160) && state.Identifier(s.OwnerID, 80) &&
		state.Identifier(s.ProfileID, 160) && state.Identifier(s.ComputerID, 120)
}

// NewForConnectorExecution uses the existing selected lease and mutation engine.
// It neither mints a lease nor constructs a repository or a second operation key.
// Original host/call fields must come from trusted composition, never the body.
func NewForConnectorExecution(selected ConnectorSelection, lease Execution, repository port.MutationRepository, native port.MutableWorkspace, digester port.MutationDigester, gate Gate, clock port.Clock) (*ConnectorService, error) {
	if !selected.valid() || selected.ComputerGeneration > state.MaxSafeInteger || !selected.Origin.Valid() || lease == nil {
		return nil, invalid()
	}
	b, o := lease.Binding(), selected.Origin
	if b.OwnerID != selected.OwnerID || b.SessionID != o.SessionID || b.TaskID != o.TaskID || b.TaskEpoch != o.TaskEpoch || b.ParticipantID != o.ParticipantID || b.TurnID != o.TurnID {
		return nil, authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	bound := &connectorMutationLease{Execution: lease, selected: selected}
	engine, err := NewForExecution(selected.OperationID, bound, repository, native, digester, gate, clock)
	if err != nil {
		return nil, err
	}
	return &ConnectorService{selected: selected, engine: engine}, nil
}

// Bind the stored Computer identity to each snapshot used by the original
// engine, including the last check before native publication and disclosure.
type connectorMutationLease struct {
	Execution
	selected ConnectorSelection
}

func (l *connectorMutationLease) WithSnapshot(ctx context.Context, participant string, inspect func(port.AccessSnapshot) error) error {
	calls := 0
	var inspected error
	err := l.Execution.WithSnapshot(ctx, participant, func(snapshot port.AccessSnapshot) error {
		calls++
		if calls != 1 {
			inspected = authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
			return inspected
		}
		p, a := snapshot.Participant, snapshot.Approval
		if p == nil || a == nil || p.Grant.ComputerID != l.selected.ComputerID || p.Grant.ComputerGeneration != l.selected.ComputerGeneration || a.ComputerID != l.selected.ComputerID || a.Generation != l.selected.ComputerGeneration {
			inspected = authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		} else {
			inspected = inspect(snapshot)
		}
		return inspected
	})
	if err != nil {
		return err
	}
	if calls != 1 {
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	return inspected
}

// Check qualifies the exact target under the original lease before composition
// enters the mutation engine. It persists nothing and is never reusable proof:
// Execute still rechecks at admission, native publication and disclosure.
func (s *ConnectorService) Check(ctx context.Context, r ConnectorRequest) error {
	if s == nil || s.engine == nil {
		return invalid()
	}
	if err := ValidateOwnerRequest(OwnerRequest{WorkspaceID: r.WorkspaceID, Operation: r.Operation}); err != nil {
		return err
	}
	op := convert(r.Operation)
	if op.Kind() != s.selected.Origin.Operation {
		return invalid()
	}
	_, err := s.engine.current(ctx, r.WorkspaceID, op.Path(), nil, nil)
	return err
}

func (s *ConnectorService) Execute(ctx context.Context, r ConnectorRequest) (*ConnectorResponse, error) {
	if s == nil || s.engine == nil {
		return nil, invalid()
	}
	if err := ValidateOwnerRequest(OwnerRequest{WorkspaceID: r.WorkspaceID, Operation: r.Operation}); err != nil {
		return nil, err
	}
	op := convert(r.Operation)
	if op.Kind() != s.selected.Origin.Operation {
		return nil, invalid()
	}
	digest, err := s.engine.digester.Digest(port.MutationDigestInput{WorkspaceID: r.WorkspaceID, Operation: op.Clone()})
	if err != nil || !state.SHA256(digest) {
		return nil, authority.Fail("COMPUTER_MUTATION_FINGERPRINT_FAILED", "operation-store")
	}
	binding := state.Binding{Identity: s.selected.identity(), WorkspaceID: r.WorkspaceID,
		ComputerGeneration: s.selected.ComputerGeneration, RelativePath: op.Path(), Connector: s.selected.Origin, RequestDigest: digest}
	out, err := s.engine.executeBound(ctx, binding, op)
	if err != nil {
		return nil, err
	}
	return connectorResponse(binding, out), nil
}

func connectorResponse(binding state.Binding, out *attemptResult) *ConnectorResponse {
	return &ConnectorResponse{OperationID: binding.Identity.OperationID, WorkspaceID: binding.WorkspaceID,
		RelativePath: binding.RelativePath, ComputerGeneration: binding.ComputerGeneration, Origin: binding.Connector,
		Phase: out.Phase, Publication: out.Publication, Receipt: out.Receipt, Failure: out.Failure}
}

type ConnectorObservation struct{ WorkspaceID, RelativePath string }

// ConnectorObserver reads retained metadata under current read authority. It
// has no executor, payload, Admit, Save or native mutation path. The response
// retains the journal's ORIGINAL origin, even under a later connector lifetime.
type ConnectorObserver struct {
	owner    ConnectorOwner
	records  OwnerRecords
	current  port.CurrentMutationObservation
	retained *Service
}

// NewConnectorObserver is for a cold owner without a retained attempt. Root must
// use the original service's Observer when that attempt exists: a disk reload
// must never upgrade its lost acknowledgement or memory-only publication.
func NewConnectorObserver(owner ConnectorOwner, records OwnerRecords, current port.CurrentMutationObservation) (*ConnectorObserver, error) {
	if !owner.valid() || records == nil || current == nil {
		return nil, invalid()
	}
	return &ConnectorObserver{owner: owner, records: records, current: current}, nil
}

// Observer allows the trusted root to supply a current read-only connector
// guard after reconnect. The original write lease is never replaced or renewed.
func (s *ConnectorService) Observer(current port.CurrentMutationObservation) (*ConnectorObserver, error) {
	if s == nil || s.engine == nil {
		return nil, invalid()
	}
	reader, err := NewConnectorObserver(s.selected.ConnectorOwner, s.engine.repository, current)
	if err != nil {
		return nil, err
	}
	reader.retained = s.engine
	return reader, nil
}

func (s *ConnectorObserver) authorized(ctx context.Context, r ConnectorObservation, inspect func() error) error {
	if ctx == nil || ctx.Err() != nil {
		return authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	calls := 0
	var inspected error
	err := s.current.WithMutationObservation(ctx, s.owner.identity(), r.WorkspaceID, r.RelativePath, func() error {
		calls++
		if calls != 1 {
			inspected = authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		} else if ctx.Err() != nil {
			inspected = authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
		} else if inspect != nil {
			inspected = inspect()
		}
		return inspected
	})
	if err != nil {
		return classify(err)
	}
	if calls != 1 {
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	return inspected
}

// cached is also checked AFTER repository IO. A concurrent attempt, uncertain
// admission or newly retained memory-only result must win over loaded bytes.
func (s *ConnectorObserver) cached() (*state.State, string, error) {
	if s.retained == nil {
		return nil, "", nil
	}
	e := s.retained
	e.gate.Lock()
	defer e.gate.Unlock()
	if e.pending {
		return nil, "", authority.Fail("COMPUTER_MUTATION_IN_PROGRESS", "operation-store")
	}
	if e.blocked != nil {
		return nil, "", e.blocked
	}
	if e.terminal != nil && e.terminal.Phase() != state.Prepared {
		copy := e.terminal.Clone()
		return &copy, e.publication, nil
	}
	return nil, "", nil
}

func (s *ConnectorObserver) Observe(ctx context.Context, r ConnectorObservation) (*ConnectorResponse, error) {
	if s == nil || s.records == nil || s.current == nil || !state.Identifier(r.WorkspaceID, 120) || !state.RelativePath(r.RelativePath) {
		return nil, invalid()
	}
	if err := s.authorized(ctx, r, nil); err != nil {
		return nil, err
	}
	record, publication, err := s.cached()
	if err != nil {
		return nil, err
	}
	if record == nil {
		record, err = s.records.Load(ctx, s.owner.identity())
		if err != nil {
			return nil, storeUnavailable()
		}
		publication = "durable"
	}
	var response *ConnectorResponse
	err = s.authorized(ctx, r, func() error {
		cached, retainedPublication, err := s.cached()
		if err != nil {
			return err
		}
		if cached != nil {
			record, publication = cached, retainedPublication
		}
		if record == nil {
			return authority.Fail("COMPUTER_MUTATION_OPERATION_NOT_FOUND", "operation-store")
		}
		b := record.Binding()
		if _, err := state.Restore(b, record.Phase(), record.Receipt(), record.Failure()); err != nil {
			return storeUnavailable()
		}
		if b.Identity != s.owner.identity() || b.WorkspaceID != r.WorkspaceID || b.RelativePath != r.RelativePath {
			return authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
		}
		if e := s.retained; e != nil {
			e.gate.Lock()
			crossed := e.binding != nil && *e.binding != b
			e.gate.Unlock()
			if crossed {
				return authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
			}
		}
		response = connectorResponse(b, resultOf(record, publication))
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

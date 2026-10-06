package process

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ConnectorReservationScope is immutable correlation selected by trusted root.
// It grants no admission, host qualification, execution or recovery authority.
// All fields are scalar values; the repository adapter retains an exact copy.
type ConnectorReservationScope struct {
	Host                           port.ConnectorHost
	OwnerID, ComputerID, CallID    string
	ComputerGeneration, Generation uint64
}

// ConnectorReadScope is current constructor-only correlation. It contains no
// original operation identity. Different host/admission lifetimes are allowed;
// owner/profile/computer and the original physical workspace must still match.
type ConnectorReadScope struct {
	Host                port.ConnectorHost
	OwnerID, ComputerID string
	ComputerGeneration  uint64
}

// ConnectorObservationAuthority must bind this immutable scope to its existing
// READ lease and current connector owner. WithSnapshot serializes the existing
// Computer/admission/connector owners and refuses stale host/settings generations,
// withdrawn or uncertain shared state, including a denial after inspect. Root
// must select the authenticated profile and exact lease's host; a scope DTO or a
// permissive callback grants no admission or native qualification. Do not nest a
// second host guard under a lease that already holds that guard.
// ConnectorScope, Binding and Deadline are immutable, synchronous, no-IO value
// observations. In particular, profile/host liveness is enforced by the existing
// connector owner INSIDE WithSnapshot, not inferred from ConnectorScope equality.
type ConnectorObservationAuthority interface {
	ObservationAuthority
	ConnectorScope() ConnectorReadScope
}

func validConnectorReadScope(s ConnectorReadScope) bool {
	h := s.Host
	return identifier(s.OwnerID) && identifier(s.ComputerID) && identifier(h.ProfileID) &&
		identifier(h.BackendGeneration) && len(h.BackendGeneration) <= 120 &&
		identifier(h.BuildID) && len(h.BuildID) <= 120 && identifier(h.RuntimeID) && len(h.RuntimeID) <= 120 &&
		digest(h.LaunchDigest) && h.ConnectorGeneration > 0 && s.ComputerGeneration <= 9007199254740991
}

func connectorLease(selected ConnectorReservationScope, lease Execution) (*connectorExecution, error) {
	if lease == nil || !validConnectorReadScope(ConnectorReadScope{selected.Host, selected.OwnerID, selected.ComputerID, selected.ComputerGeneration}) ||
		!identifier(selected.CallID) || len(selected.CallID) > 120 {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	b := lease.Binding()
	if b.OwnerID != selected.OwnerID {
		return nil, authority.Fail("AUTHORITY_OWNER_MISMATCH", "task-grant")
	}
	return &connectorExecution{Execution: lease, selected: selected, binding: b, deadline: lease.Deadline()}, nil
}

// NewForConnector captures original provenance before Start. Trusted root must
// supply the SAME scope to the existing reservation adapter and this constructor.
// There is no setter, restore path, new journal or retrospective identity binding.
func NewForConnector(operationID string, selected ConnectorReservationScope, lease Execution, prepared Prepared, reservations Reservation, gate Gate, clock port.Clock) (*Service, error) {
	bound, err := connectorLease(selected, lease)
	if err != nil {
		return nil, err
	}
	s, err := New(operationID, bound, prepared, reservations, gate, clock)
	if err != nil {
		return nil, err
	}
	s.connector = &selected
	return s, nil
}

// NewForConnectorInvocation captures provenance before Prepare, using the SAME
// invocation engine and durable reservation as NewForInvocation.
func NewForConnectorInvocation(operationID string, selected ConnectorReservationScope, lease Execution, preparer InvocationPreparer, reservations Reservation, gate Gate, clock port.Clock) (*Service, error) {
	bound, err := connectorLease(selected, lease)
	if err != nil {
		return nil, err
	}
	s, err := NewForInvocation(operationID, bound, preparer, reservations, gate, clock)
	if err != nil {
		return nil, err
	}
	s.connector = &selected
	return s, nil
}

// Bind the original Computer selection to all original execution snapshots.
// This wrapper never admits, renews or changes the captured execution deadline.
type connectorExecution struct {
	Execution
	selected ConnectorReservationScope
	binding  port.TaskBinding
	deadline time.Time
}

func (l *connectorExecution) WithSnapshot(ctx context.Context, participant string, inspect func(port.AccessSnapshot) error) error {
	calls := 0
	var inspected error
	err := l.Execution.WithSnapshot(ctx, participant, func(snapshot port.AccessSnapshot) error {
		calls++
		p, a := snapshot.Participant, snapshot.Approval
		if calls != 1 || l.Execution.Binding() != l.binding || !l.Execution.Deadline().Equal(l.deadline) {
			inspected = fail("PROCESS_ADMISSION_UNAVAILABLE", false)
		} else if p == nil || a == nil || p.Grant.ComputerID != l.selected.ComputerID || a.ComputerID != l.selected.ComputerID ||
			p.Grant.ComputerGeneration != l.selected.ComputerGeneration || a.Generation != l.selected.ComputerGeneration {
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
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	return inspected
}

// ConnectorObserver maps a later current READ lifetime onto only this retained
// connector child. It accepts no original identity; services built by the ordinary
// constructors lack provenance and cannot acquire it here. Task/Chat Observer
// continues to require the complete original binding and invocation admission.
func (s *Service) ConnectorObserver(current ConnectorObservationAuthority, workspace ObservationWorkspace) (*Observer, error) {
	if s == nil || s.connector == nil || s.clock == nil || current == nil || workspace == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	selected := current.ConnectorScope()
	if !validConnectorReadScope(selected) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	original := *s.connector
	binding, deadline := current.Binding(), current.Deadline()
	if selected.OwnerID != original.OwnerID || binding.OwnerID != original.OwnerID {
		return nil, authority.Fail("AUTHORITY_OWNER_MISMATCH", "task-grant")
	}
	if selected.Host.ProfileID != original.Host.ProfileID || selected.ComputerID != original.ComputerID {
		return nil, authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	if !identifier(binding.SessionID) || !identifier(binding.TaskID) || !identifier(binding.ParticipantID) || !identifier(binding.TurnID) || binding.TaskEpoch > 9007199254740991 {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	now := s.clock.Now()
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || deadline.UnixMilli() <= 0 || deadline.UnixMilli() > 9007199254740991 ||
		!now.Before(deadline) || deadline.After(now.Add(authority.OrdinaryExecutionLifetime)) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	return &Observer{service: s, current: current, workspace: workspace, binding: binding, deadline: deadline, connector: &selected}, nil
}

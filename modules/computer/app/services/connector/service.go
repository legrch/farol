// Package connector owns one trusted external Computer connector lifetime.
// It stores only volatile liveness and an immutable ceiling; access Store remains
// the sole authority journal. It owns no Task, Chat, browser or provider lifecycle.
package connector

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type phase uint8

const (
	pending phase = iota
	publishing
	active
	unavailable
	withdrawn
)

type Service struct {
	gate         port.ConnectorGate
	journal      port.ConnectorJournal
	guard        port.CurrentConnectorGuard
	launch       port.ConnectorLaunch
	ceiling      port.ConnectorExecutionCeiling
	binding      port.TaskBinding
	phase        phase
	clock        port.Clock
	verification *verificationAttempt
}

var _ port.CurrentExecutionAdmission = (*Service)(nil)

// New is for trusted root, never a wire handler. It performs no persistence and
// starts pending even when the journal already contains this participant. Root
// must supply freshly minted lifetime correlations and a qualified host guard.
func New(gate port.ConnectorGate, journal port.ConnectorJournal, guard port.CurrentConnectorGuard, clock port.Clock, launch port.ConnectorLaunch) (*Service, error) {
	h := launch.Host
	i := launch.Admission
	if gate == nil || journal == nil || guard == nil || clock == nil || h.ProfileID == "" || h.BackendGeneration == "" || h.BuildID == "" || h.RuntimeID == "" || h.LaunchDigest == "" || h.ConnectorGeneration == 0 || i.OwnerID == "" || i.SessionID == "" || i.TaskID == "" || i.TaskEpoch == 0 || i.AuthorityID == "" || launch.Participant.ParticipantID == "" || launch.TurnCorrelation == "" {
		return nil, failure()
	}
	launch = cloneLaunch(launch)
	g, err := authority.Derive(launch.Approval, launch.Admission, clock.Now())
	if err != nil {
		return nil, err
	}
	p, err := authority.Create(*g, launch.Participant)
	if err != nil {
		return nil, err
	}
	s := &Service{gate: gate, journal: journal, guard: guard, launch: launch, clock: clock,
		ceiling: port.ConnectorExecutionCeiling{Participant: p.Clone(), Approval: launch.Approval.Clone()},
		binding: port.TaskBinding{Identity: i.Identity, ParticipantID: p.ParticipantID, TurnID: launch.TurnCorrelation}}
	return s, nil
}

func cloneLaunch(v port.ConnectorLaunch) port.ConnectorLaunch {
	v.Approval = v.Approval.Clone()
	v.Admission.Policy = (authority.Grant{Policy: v.Admission.Policy}).Clone().Policy
	return v
}
func failure() error {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "connector-owner")
}
func classify(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) {
		return err
	}
	return failure()
}

// guarded runs under the owner gate. Host loss/settings fences are terminal for
// this owner; a later positive guard value cannot reactivate it. Consumer errors
// (for example capability denial) do not revoke an otherwise current connector.
func (s *Service) guarded(ctx context.Context, inspect func() error) error {
	calls := 0
	var callbackErr error
	valid := false
	err := s.guard.WithConnectorCurrent(ctx, s.launch.Host, func(current bool) error {
		calls++
		if calls != 1 || !current {
			callbackErr = failure()
			return callbackErr
		}
		valid = true
		callbackErr = inspect()
		return callbackErr
	})
	if calls != 1 || !valid || err != nil && (callbackErr == nil || !errors.Is(err, callbackErr)) {
		s.phase = unavailable
		return failure()
	}
	return callbackErr
}

// Publish attempts the original participant publication ONCE. Pending duplicate
// calls never dispatch another write. All journal IO occurs outside the gate.
// A late commit, lost reply, error or failed readback leaves liveness unavailable;
// there is no activation-from-status, replay or persisted positive restore API.
func (s *Service) Publish(ctx context.Context) error {
	if s == nil {
		return failure()
	}
	s.gate.Lock()
	if s.phase != pending {
		s.gate.Unlock()
		return failure()
	}
	if ctx.Err() != nil {
		s.phase = unavailable
		s.gate.Unlock()
		return failure()
	}
	if err := s.guarded(ctx, func() error { return nil }); err != nil {
		s.gate.Unlock()
		return err
	}
	s.phase = publishing
	input := cloneLaunch(s.launch)
	s.gate.Unlock()
	result, err := s.journal.PublishConnector(ctx, input)
	s.gate.Lock()
	defer s.gate.Unlock()
	if s.phase != publishing {
		return failure()
	}
	if err != nil || ctx.Err() != nil || !result.OriginalPublished || result.Revision == 0 || !authority.SameParticipantCeiling(result.Participant, s.ceiling.Participant) || !result.Participant.Grant.ExpiresAt.Equal(s.ceiling.Participant.Grant.ExpiresAt) || !authority.SameApprovalPolicy(result.Approval, s.ceiling.Approval) {
		s.phase = unavailable
		if err != nil {
			return classify(err)
		}
		return failure()
	}
	return s.guarded(ctx, func() error { s.phase = active; return nil })
}

// WithCurrent provides an independent value under the synchronous owner gate.
// Pending/publishing is absent; unsettled/withdrawn is unavailable. No journal,
// filesystem, native host or provider call is made on entry. Only one workspace-parent
// mkdir or final file publication callback may run native IO under these locks.
func (s *Service) WithCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if s == nil || inspect == nil {
		return failure()
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "connector-owner")
	}
	if s.phase == unavailable || s.phase == withdrawn {
		return failure()
	}
	return s.guarded(ctx, func() error {
		if s.phase != active {
			return inspect(nil)
		}
		value := s.binding
		return inspect(&value)
	})
}

// Reconnect observes exact admission on this retained owner, never re-admission.
// It accepts no reconstructed IDs and returns an independent correlation value.
// Root retains the original issuer; this observation never constructs or renews
// one. Each operation still admits a fixed lease through current access/owner gates.
func (s *Service) Reconnect(ctx context.Context) (*port.TaskBinding, error) {
	var binding *port.TaskBinding
	err := s.WithCurrent(ctx, func(b *port.TaskBinding) error {
		if b == nil {
			return failure()
		}
		value := *b
		binding = &value
		return nil
	})
	if err != nil {
		return nil, err
	}
	return binding, nil
}

// ExecutionCeiling exports a deep copy only after known original publication
// while this owner is current. Root alone maps it to execution's DTO, constructs
// the issuer once, and retains it through reconnect. Copies cannot mutate the
// stored seal or activate this owner; execution must keep using this exact owner
// as CurrentExecutionAdmission for every operation and final disclosure.
func (s *Service) ExecutionCeiling(ctx context.Context) (*port.ConnectorExecutionCeiling, error) {
	var ceiling *port.ConnectorExecutionCeiling
	err := s.WithCurrent(ctx, func(b *port.TaskBinding) error {
		if b == nil {
			return failure()
		}
		ceiling = &port.ConnectorExecutionCeiling{Participant: s.ceiling.Participant.Clone(), Approval: s.ceiling.Approval.Clone()}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ceiling, nil
}

// Withdraw makes liveness negative FIRST, then publishes revocation outside the
// gate. It attempts persistence once even if admission is still pending. A late
// admission commit cannot reopen this owner; root must reconcile its retained
// journal separately without replaying Publish or this withdrawal.
func (s *Service) Withdraw(ctx context.Context) error {
	if s == nil {
		return failure()
	}
	s.gate.Lock()
	if s.phase == withdrawn {
		s.gate.Unlock()
		return failure()
	}
	s.phase = withdrawn
	id := s.binding.ParticipantID
	s.gate.Unlock()
	if err := s.journal.WithdrawConnector(ctx, id); err != nil {
		return classify(err)
	}
	return nil
}

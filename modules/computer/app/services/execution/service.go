// Package execution reissues time under the existing Computer authority owner.
// Each returned lease belongs to one operation; this service stores no mutable
// current execution, Task/Turn lifecycle, journal, executor or retry state.
package execution

import (
	"context"
	"errors"
	"slices"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// Ceiling comes from trusted existing admission/launch composition, never a
// request. Reissue requires both this sealed policy and independently current
// task and Computer owners. A restart must restore the original admitted seal.
type Ceiling struct {
	Participant authority.Participant
	Approval    authority.Approval
}
type Service struct {
	access  port.AccessRepository
	tasks   port.CurrentTaskAdmission
	clock   port.Clock
	ceiling Ceiling
}

func New(access port.AccessRepository, tasks port.CurrentTaskAdmission, clock port.Clock, ceiling Ceiling) (*Service, error) {
	if access == nil || tasks == nil || clock == nil {
		return nil, unavailable()
	}
	ceiling.Participant = ceiling.Participant.Clone()
	ceiling.Approval = ceiling.Approval.Clone()
	return &Service{access: access, tasks: tasks, clock: clock, ceiling: ceiling}, nil
}
func unavailable() error {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func cancelled(ctx context.Context) error {
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	return nil
}
func classified(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) {
		return err
	}
	return unavailable()
}

// Computer qualifies native state before entering either inspect callback.
// The task projection is synchronous and performs no native IO on entry. Only
// one workspace-parent mkdir or final file publication callback may run native
// IO under the current owners. Shared activation must adopt this one access-before-task order.
func (s *Service) withCurrent(ctx context.Context, expected *port.TaskBinding, inspect func(port.TaskBinding, port.AccessSnapshot) error) error {
	if err := cancelled(ctx); err != nil {
		return err
	}
	snapshotCalls := 0
	var snapshotResult error
	err := s.access.WithSnapshot(ctx, s.ceiling.Participant.ParticipantID, func(snapshot port.AccessSnapshot) (callbackErr error) {
		defer func() { snapshotResult = callbackErr }()
		snapshotCalls++
		if snapshotCalls != 1 {
			return unavailable()
		}
		if err := cancelled(ctx); err != nil {
			return err
		}
		if snapshot.Participant == nil || snapshot.Participant.ParticipantID != s.ceiling.Participant.ParticipantID {
			return authority.Fail("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store")
		}
		if !authority.SameParticipantCeiling(*snapshot.Participant, s.ceiling.Participant) {
			return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
		}
		if snapshot.Approval == nil {
			return authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy")
		}
		if !authority.SameApprovalPolicy(*snapshot.Approval, s.ceiling.Approval) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		}
		calls := 0
		var taskResult error
		err := s.tasks.WithCurrent(ctx, func(binding *port.TaskBinding) (callbackErr error) {
			defer func() { taskResult = callbackErr }()
			calls++
			if calls != 1 {
				return unavailable()
			}
			if err := cancelled(ctx); err != nil {
				return err
			}
			if binding == nil || binding.TurnID == "" || binding.ParticipantID != s.ceiling.Participant.ParticipantID || binding.Identity != s.ceiling.Participant.Grant.Identity || expected != nil && *binding != *expected {
				return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
			}
			return inspect(*binding, snapshot)
		})
		if err != nil {
			return classified(err)
		}
		if calls != 1 {
			return unavailable()
		}
		return taskResult
	})
	if err != nil {
		return classified(err)
	}
	if snapshotCalls != 1 {
		return unavailable()
	}
	return snapshotResult
}

// Admit observes current owners once, then returns a private immutable lease.
// It does not change the durable participant, admit an identity, clear intent,
// dispatch work or replay any operation. The owning parsed operation selects the
// budget: root-scoped Shell has 10m, composite verification 120s, other work 15s.
func (s *Service) Admit(ctx context.Context, kind authority.Capability) (*Lease, error) {
	return s.admit(ctx, kind, false)
}

// AdmitCatalogue permits observing an explicitly empty Computer approval without
// granting file access. Nonempty catalogues still require List. Both paths keep
// the same current-owner checks, immutable ceiling and fixed operation deadline.
func (s *Service) AdmitCatalogue(ctx context.Context) (*Lease, error) {
	return s.admit(ctx, authority.List, true)
}

func (s *Service) admit(ctx context.Context, kind authority.Capability, catalogue bool) (*Lease, error) {
	var out *Lease
	err := s.withCurrent(ctx, nil, func(binding port.TaskBinding, snapshot port.AccessSnapshot) error {
		p, a := snapshot.Participant.Clone(), snapshot.Approval.Clone()
		emptyCatalogue := catalogue && a.NoAccess() && p.Grant.Policy.NoAccess() && p.MutationOwnership == authority.NoOwnership
		if !emptyCatalogue && (!slices.Contains(p.Grant.Capabilities, kind) || kind == authority.NetworkUse) {
			return authority.Fail("AUTHORITY_CAPABILITY_DENIED", "task-grant")
		}
		now := s.clock.Now()
		g := p.Grant
		input := authority.Admission{Identity: g.Identity, AuthorityID: g.AuthorityID, ComputerID: g.ComputerID, ComputerGeneration: g.ComputerGeneration, Policy: g.Policy}
		outer, err := authority.Reissue(a, input, now, authority.TaskGrantLifetime)
		if err != nil {
			return err
		}
		// Derive validates current permission through the existing mechanism. Keep
		// the sealed inherited restrictions/provenance; change time alone.
		p.Grant.ExpiresAt = outer.ExpiresAt
		lifetime := authority.OrdinaryExecutionLifetime
		if kind == authority.Verify {
			lifetime = authority.VerificationExecutionLifetime
		} else if kind == authority.Shell && a.FilePolicy == authority.RootScopedFiles {
			lifetime = authority.ProcessExecutionLifetime
		}
		fixed, err := authority.Lease(p, a, now, lifetime)
		if err != nil {
			return err
		}
		if err := cancelled(ctx); err != nil {
			return err
		}
		out = &Lease{service: s, binding: binding, fixed: *fixed}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if out == nil {
		return nil, unavailable()
	}
	return out, nil
}

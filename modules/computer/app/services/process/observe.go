package process

import (
	"context"
	"errors"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ObservationAuthority is an ordinary READ lifetime selected by trusted
// composition, not a request. WithSnapshot must serialize current Computer and
// admission owners (including withdrawal), call inspect exactly once with
// independent values, refuse any change to the selected full binding, and
// perform no native IO under inspect. Approved physical identity is compared
// separately with the original seal and a fresh workspace observation.
// Binding and Deadline are immutable values. This port grants no Spawn,
// renewal or retry.
// An existing issuer's Admit(Read) lease can implement this port; it must never
// replace the process's original execution lease.
type ObservationAuthority interface {
	port.AccessRepository
	Binding() port.TaskBinding
	Deadline() time.Time
}

type ObservedWorkspace struct {
	WorkspaceID, Root string
	RootIdentity      authority.RootIdentity
}

// ObservationWorkspace is a trusted, fixed workspace selection, never a body
// path or mutable callback. Its producer re-observes the physical root using
// qualified no-follow semantics on EVERY call; saved approval metadata is not
// fresh physical proof. Calls run before owner gates and must not mutate,
// execute, renew admission, select another root or automatically retry failure.
type ObservationWorkspace interface {
	ObserveWorkspace(context.Context) (*ObservedWorkspace, error)
}

// Observer retains one admitted service and its owning child. It exposes only
// Read, shares irreversible unknown/cancel/cleanup fences, and cannot select a
// replacement process, cold restore an operation, or start another attempt.
type Observer struct {
	service   *Service
	current   ObservationAuthority
	workspace ObservationWorkspace
	binding   port.TaskBinding
	deadline  time.Time
	connector *ConnectorReadScope
}

// Observer binds an independent READ lifetime to the original operation. The
// entire binding must match: owner/session/task/epoch/participant/turn. Connector
// bindings are opaque lifetime correlation, not Task/Chat membership; a new
// connector lifetime does not inherit this process. No body IDs map authority.
// The original operation, seal, handle, invocation and execution deadline remain
// unchanged. Construction performs no admission, owner IO or process effects.
func (s *Service) Observer(current ObservationAuthority, workspace ObservationWorkspace) (*Observer, error) {
	if s == nil || current == nil || workspace == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	binding, deadline := current.Binding(), current.Deadline()
	if binding.OwnerID != s.intent.Binding.OwnerID {
		return nil, authority.Fail("AUTHORITY_OWNER_MISMATCH", "task-grant")
	}
	if binding != s.intent.Binding {
		return nil, authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
	}
	now := s.clock.Now()
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || deadline.UnixMilli() <= 0 || deadline.UnixMilli() > 9007199254740991 ||
		!now.Before(deadline) || deadline.After(now.Add(authority.OrdinaryExecutionLifetime)) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	return &Observer{service: s, current: current, workspace: workspace, binding: binding, deadline: deadline}, nil
}

func (o *Observer) Read(ctx context.Context, request ReadRequest) (*ReadResponse, error) {
	if o == nil || o.service == nil || o.current == nil || o.workspace == nil || ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	return o.service.read(ctx, request, o.withCurrent)
}

// observationGuard shares current READ policy between live and retained readers.
// It has no execution lease, service, child, admission issuer or mutable owner.
type observationGuard struct {
	current   ObservationAuthority
	binding   port.TaskBinding
	deadline  time.Time
	connector *ConnectorReadScope
	clock     port.Clock
}

func (o *Observer) withCurrent(ctx context.Context, disclose func() error) error {
	o.service.gate.Lock()
	seal := o.service.intent.Seal
	o.service.gate.Unlock()
	return withObservedWorkspace(ctx, o.workspace, seal, o.withAuthority, disclose)
}

func withObservedWorkspace(ctx context.Context, workspace ObservationWorkspace, seal Seal, current func(context.Context, func() error) error, disclose func() error) error {
	// Current READ authority gates even the physical qualification lookup.
	if err := current(ctx, nil); err != nil {
		return err
	}
	// Physical qualification runs outside all Computer/admission/app gates.
	// Saved approval metadata cannot prove that the original root still exists.
	physical, err := workspace.ObserveWorkspace(ctx)
	if err != nil || physical == nil {
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	if physical.WorkspaceID != seal.WorkspaceID || physical.Root != seal.Root || physical.RootIdentity != seal.RootIdentity {
		return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	// Qualification may yield to withdrawal, expiry or workspace-policy changes.
	return current(ctx, disclose)
}

func (o *Observer) withAuthority(ctx context.Context, disclose func() error) error {
	s := o.service
	s.gate.Lock()
	seal := s.intent.Seal
	s.gate.Unlock()
	guard := observationGuard{o.current, o.binding, o.deadline, o.connector, s.clock}
	return guard.withAuthority(ctx, seal, func(p authority.Participant) error {
		s.gate.Lock()
		wrongAdmission := o.connector == nil && s.invocation != nil && p.Grant.AuthorityID != s.invocation.AdmissionID
		s.gate.Unlock()
		if wrongAdmission {
			return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
		}
		return nil
	}, disclose)
}

func (g observationGuard) selected(now time.Time) error {
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(g.deadline) {
		return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	// A producer cannot extend or replace the independent captured lifetime.
	if g.current.Binding() != g.binding || !g.current.Deadline().Equal(g.deadline) {
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	if g.connector != nil {
		current, ok := g.current.(ConnectorObservationAuthority)
		if !ok || current.ConnectorScope() != *g.connector {
			return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
		}
	}
	return nil
}

func (g observationGuard) withAuthority(ctx context.Context, seal Seal, originalAdmission func(authority.Participant) error, disclose func() error) error {
	if ctx.Err() != nil {
		return fail("PROCESS_CANCELLED", false)
	}
	calls := 0
	var inspected error
	var grantExpiry, approvalExpiry time.Time
	err := g.current.WithSnapshot(ctx, g.binding.ParticipantID, func(snapshot port.AccessSnapshot) error {
		calls++
		reject := func(err error) error { inspected = err; return err }
		if calls != 1 || snapshot.Participant == nil || snapshot.Approval == nil {
			return reject(fail("PROCESS_ADMISSION_UNAVAILABLE", false))
		}
		now := g.clock.Now()
		if err := g.selected(now); err != nil {
			return reject(err)
		}
		p, a := snapshot.Participant.Clone(), snapshot.Approval.Clone()
		grantExpiry, approvalExpiry = p.Grant.ExpiresAt, a.ExpiresAt
		if !now.Before(grantExpiry) || !now.Before(approvalExpiry) {
			return reject(authority.Fail("AUTHORITY_EXPIRED", "task-grant"))
		}
		if p.ParticipantID != g.binding.ParticipantID {
			return reject(authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant"))
		}
		if g.connector != nil {
			if p.Grant.ComputerID != g.connector.ComputerID || a.ComputerID != g.connector.ComputerID ||
				p.Grant.ComputerGeneration != g.connector.ComputerGeneration || a.Generation != g.connector.ComputerGeneration {
				return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
			}
		}
		if originalAdmission != nil {
			if err := originalAdmission(p); err != nil {
				return reject(err)
			}
		}
		action := authority.Action{Identity: g.binding.Identity, Operation: authority.Operation{Kind: authority.Read, WorkspaceID: seal.WorkspaceID, Path: seal.Cwd}}
		if err := authority.AuthorizeComputer(p, a, action, now); err != nil {
			return reject(err)
		}
		workspace, ok := authority.FindApproved(a, seal.WorkspaceID)
		if !ok || workspace.Root != seal.Root || workspace.RootIdentity != seal.RootIdentity {
			return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
		}
		// READ may be narrower than the original Shell policy, but must still
		// authorize its original cwd. Shell/write/command rights are not required.
		if ctx.Err() != nil {
			return reject(fail("PROCESS_CANCELLED", false))
		}
		if disclose != nil {
			return reject(disclose())
		}
		return reject(nil)
	})
	if err != nil {
		var known *authority.Failure
		var local *Failure
		if errors.As(err, &known) || errors.As(err, &local) {
			return err
		}
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	if calls != 1 {
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	if ctx.Err() != nil {
		return fail("PROCESS_CANCELLED", false)
	}
	if inspected != nil {
		return inspected
	}
	// A callback may have passed and then returned late. Prepared output must
	// not escape after expiry or selected-value drift, even if the port returns
	// nil. Withdrawal/generation changes remain serialized by WithSnapshot.
	now := g.clock.Now()
	if err := g.selected(now); err != nil {
		return err
	}
	if !now.Before(grantExpiry) || !now.Before(approvalExpiry) {
		return authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	return nil
}

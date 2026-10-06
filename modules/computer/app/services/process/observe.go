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

func (o *Observer) withCurrent(ctx context.Context, disclose func() error) error {
	// Current READ authority gates even the physical qualification lookup.
	if err := o.withAuthority(ctx, nil); err != nil {
		return err
	}
	// Physical qualification is outside all Computer/admission/app inspect
	// gates, both before child IO and before final disclosure. Store snapshots
	// alone contain approved metadata and cannot prove the root still exists.
	physical, err := o.workspace.ObserveWorkspace(ctx)
	if err != nil || physical == nil {
		return fail("PROCESS_ADMISSION_UNAVAILABLE", false)
	}
	o.service.gate.Lock()
	seal := o.service.intent.Seal
	o.service.gate.Unlock()
	if physical.WorkspaceID != seal.WorkspaceID || physical.Root != seal.Root || physical.RootIdentity != seal.RootIdentity {
		return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
	}
	// Qualification may yield to withdrawal, expiry or workspace-policy changes.
	// Recheck the coherent owners before allowing child IO or disclosure.
	return o.withAuthority(ctx, disclose)
}

func (o *Observer) withAuthority(ctx context.Context, disclose func() error) error {
	if ctx.Err() != nil {
		return fail("PROCESS_CANCELLED", false)
	}
	calls := 0
	var inspected error
	err := o.current.WithSnapshot(ctx, o.binding.ParticipantID, func(snapshot port.AccessSnapshot) error {
		calls++
		reject := func(err error) error { inspected = err; return err }
		if calls != 1 || snapshot.Participant == nil || snapshot.Approval == nil {
			return reject(fail("PROCESS_ADMISSION_UNAVAILABLE", false))
		}
		now := o.service.clock.Now()
		if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(o.deadline) {
			return reject(authority.Fail("AUTHORITY_EXPIRED", "task-grant"))
		}
		// A producer must not drift its selected binding or deadline. Extending
		// this port's value cannot extend the independent captured deadline.
		if o.current.Binding() != o.binding || !o.current.Deadline().Equal(o.deadline) {
			return reject(fail("PROCESS_ADMISSION_UNAVAILABLE", false))
		}
		p, a := snapshot.Participant.Clone(), snapshot.Approval.Clone()
		if !now.Before(p.Grant.ExpiresAt) || !now.Before(a.ExpiresAt) {
			return reject(authority.Fail("AUTHORITY_EXPIRED", "task-grant"))
		}
		if p.ParticipantID != o.binding.ParticipantID {
			return reject(authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant"))
		}
		s := o.service
		if o.connector != nil {
			current, ok := o.current.(ConnectorObservationAuthority)
			if !ok || current.ConnectorScope() != *o.connector {
				return reject(fail("PROCESS_ADMISSION_UNAVAILABLE", false))
			}
			if p.Grant.ComputerID != o.connector.ComputerID || a.ComputerID != o.connector.ComputerID ||
				p.Grant.ComputerGeneration != o.connector.ComputerGeneration || a.Generation != o.connector.ComputerGeneration {
				return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
			}
		}
		s.gate.Lock()
		wrongAdmission := o.connector == nil && s.invocation != nil && p.Grant.AuthorityID != s.invocation.AdmissionID
		seal := s.intent.Seal
		s.gate.Unlock()
		if wrongAdmission {
			return reject(authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant"))
		}
		action := authority.Action{Identity: o.binding.Identity, Operation: authority.Operation{Kind: authority.Read, WorkspaceID: seal.WorkspaceID, Path: seal.Cwd}}
		if err := authority.AuthorizeComputer(p, a, action, now); err != nil {
			return reject(err)
		}
		workspace, ok := authority.FindApproved(a, seal.WorkspaceID)
		if !ok || workspace.Root != seal.Root || workspace.RootIdentity != seal.RootIdentity {
			return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
		}
		// Read authority may be narrower than the launch's Shell policy. It
		// must still authorize the original cwd in its original workspace;
		// neither ShellVerified nor write/command rights are required to read.
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
	return inspected
}

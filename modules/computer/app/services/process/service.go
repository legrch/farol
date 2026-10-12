package process

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

const MaximumOutput = 4 * 1024 * 1024
const WindowBytes = 64 * 1024

type Failure struct {
	Code    string
	Unknown bool
}

func (e *Failure) Error() string           { return e.Code }
func fail(code string, unknown bool) error { return &Failure{Code: code, Unknown: unknown} }

type State string

const (
	Running  State = "running"
	Terminal State = "terminal"
	// Exited preserves a known supervised command result without claiming that
	// all descendants have stopped. Unknown native operations remain Unknown.
	Exited  State = "exited"
	Unknown State = "unknown"
)

type Service struct {
	lease                                                  Execution
	prepared                                               Prepared
	preparer                                               InvocationPreparer
	scope                                                  Scope
	connector                                              *ConnectorReservationScope
	invocation                                             *Invocation
	reservations                                           Reservation
	gate                                                   Gate
	clock                                                  port.Clock
	intent                                                 Intent
	pending, started, uncertain, terminal, cancelAttempted bool
	handle                                                 string
	child                                                  Child
	refusal                                                error
	cancellation                                           *CancelReceipt
	cancelFailure                                          error
	completionAttempted, completionPending, completed      bool
	completionOwner                                        *ownedSelection
	completionFailure                                      error
}

// New captures one already selected operation. Callers cannot replace its
// lease, prepared launch, deadline, task/turn or participant on reconnect.
func New(operationID string, lease Execution, prepared Prepared, reservations Reservation, gate Gate, clock port.Clock) (*Service, error) {
	if !identifier(operationID) || lease == nil || prepared == nil || reservations == nil || gate == nil || clock == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	binding := lease.Binding()
	seal := prepared.Seal()
	deadline := lease.Deadline()
	if !identifier(binding.OwnerID) || !identifier(binding.SessionID) || !identifier(binding.TaskID) || !identifier(binding.ParticipantID) || !identifier(binding.TurnID) || !validSeal(seal) || deadline.UnixMilli() <= 0 {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	return &Service{lease: lease, prepared: prepared, reservations: reservations, gate: gate, clock: clock,
		intent: Intent{OperationID: operationID, Binding: binding, Seal: seal, Deadline: deadline}}, nil
}
func identifier(v string) bool {
	if len(v) < 1 || len(v) > 160 {
		return false
	}
	for _, c := range v {
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.ContainsRune("._:-", c)) {
			return false
		}
	}
	return true
}
func digest(v string) bool {
	if len(v) != 64 {
		return false
	}
	for _, c := range v {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func plainPath(v string) bool {
	return len(v) > 0 && len(v) <= 4096 && strings.HasPrefix(v, "/") && !strings.ContainsRune(v, 0) && utf8.ValidString(v)
}
func validSeal(s Seal) bool {
	return digest(s.Digest) && identifier(s.WorkspaceID) && plainPath(s.Root) && plainPath(s.Cwd) &&
		(s.Cwd == s.Root || strings.HasPrefix(s.Cwd, strings.TrimSuffix(s.Root, "/")+"/")) && s.RootIdentity.Device != "" && s.RootIdentity.Inode != ""
}
func sameIntent(a, b Intent) bool {
	return a.OperationID == b.OperationID && a.Binding == b.Binding && a.Seal == b.Seal && a.Deadline.Equal(b.Deadline)
}
func (s *Service) current(ctx context.Context) error { return s.withCurrent(ctx, nil) }
func (s *Service) withCurrent(ctx context.Context, disclose func() error) error {
	if ctx == nil || ctx.Err() != nil {
		return fail("PROCESS_CANCELLED", false)
	}
	calls := 0
	var inspected error
	err := s.lease.WithSnapshot(ctx, s.intent.Binding.ParticipantID, func(snapshot port.AccessSnapshot) error {
		calls++
		if calls != 1 {
			inspected = fail("PROCESS_ADMISSION_UNAVAILABLE", false)
			return inspected
		}
		if snapshot.Participant == nil || snapshot.Approval == nil {
			inspected = fail("PROCESS_ADMISSION_UNAVAILABLE", false)
			return inspected
		}
		now := s.clock.Now()
		if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(s.intent.Deadline) {
			inspected = authority.Fail("AUTHORITY_EXPIRED", "task-grant")
			return inspected
		}
		p, a := *snapshot.Participant, *snapshot.Approval
		if p.ParticipantID != s.intent.Binding.ParticipantID {
			inspected = authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
			return inspected
		}
		if s.invocation != nil && p.Grant.AuthorityID != s.invocation.AdmissionID {
			inspected = authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
			return inspected
		}
		action := authority.Action{Identity: s.intent.Binding.Identity, Operation: authority.Operation{Kind: authority.Shell, WorkspaceID: s.intent.Seal.WorkspaceID, Path: s.intent.Seal.Cwd, Write: s.intent.Seal.Write}}
		inspected = authority.AuthorizeComputer(p, a, action, now)
		if inspected != nil {
			return inspected
		}
		matched := false
		for _, workspace := range a.Workspaces {
			if workspace.WorkspaceID == s.intent.Seal.WorkspaceID && workspace.Root == s.intent.Seal.Root && workspace.RootIdentity == s.intent.Seal.RootIdentity && workspace.ShellVerified {
				matched = true
			}
		}
		if !matched {
			inspected = authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
			return inspected
		}
		s.gate.Lock()
		preparedPolicy, hasPreparedPolicy := s.prepared.(PolicyBound)
		preparerPolicy, hasPreparerPolicy := s.preparer.(PolicyBound)
		s.gate.Unlock()
		if (hasPreparedPolicy && !preparedPolicy.MatchesPolicy(snapshot)) || (hasPreparerPolicy && !preparerPolicy.MatchesPolicy(snapshot)) {
			inspected = authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
			return inspected
		}
		if ctx.Err() != nil {
			inspected = fail("PROCESS_CANCELLED", false)
			return inspected
		}
		if disclose != nil {
			inspected = disclose()
		}
		return inspected
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
	return inspected
}
func boundary(err error) error {
	var native *NativeFailure
	if errors.As(err, &native) && !native.Unknown {
		if native.FilesystemUnsupported {
			return fail("PROCESS_FILESYSTEM_UNSUPPORTED", false)
		}
		return fail("PROCESS_NATIVE_REFUSED", false)
	}
	return fail("PROCESS_OUTCOME_UNKNOWN", true)
}

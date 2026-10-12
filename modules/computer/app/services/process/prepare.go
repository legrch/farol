package process

import (
	"context"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

const MaximumInput = 1024 * 1024
const MaximumArguments = 256
const MaximumArgumentBytes = 64 * 1024

type PrepareRequest struct {
	OperationID string
	Invocation  Invocation
}
type PrepareResponse struct {
	OperationID, RuntimeID, SessionID, ModelID, AdmissionID, Digest string
}

// NewForInvocation captures the selected runtime scope and SAME admitted lease.
// It starts no process and supplies no native qualification. New remains the
// compatibility constructor for an already prepared root-owned command.
func NewForInvocation(operationID string, lease Execution, preparer InvocationPreparer, reservations Reservation, gate Gate, clock port.Clock) (*Service, error) {
	if !identifier(operationID) || lease == nil || preparer == nil || reservations == nil || gate == nil || clock == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	binding, scope := lease.Binding(), preparer.Scope()
	if !identifier(binding.OwnerID) || !identifier(binding.SessionID) || !identifier(binding.TaskID) || !identifier(binding.ParticipantID) || !identifier(binding.TurnID) || binding.TaskEpoch > 9007199254740991 || !validScope(scope) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	now, deadline := clock.Now(), lease.Deadline()
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || deadline.UnixMilli() <= 0 || deadline.UnixMilli() > 9007199254740991 || !now.Before(deadline) || deadline.After(now.Add(authority.ProcessExecutionLifetime)) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	seal := Seal{WorkspaceID: scope.WorkspaceID, Root: scope.Root, Cwd: scope.Cwd, RootIdentity: scope.RootIdentity, Write: scope.Write}
	return &Service{lease: lease, preparer: preparer, scope: scope, reservations: reservations, gate: gate, clock: clock, intent: Intent{OperationID: operationID, Binding: binding, Seal: seal, Deadline: deadline}}, nil
}
func validScope(s Scope) bool {
	decimal := func(v string) bool {
		if len(v) < 1 || len(v) > 20 {
			return false
		}
		for _, c := range v {
			if c < '0' || c > '9' {
				return false
			}
		}
		return true
	}
	return identifier(s.RuntimeID) && identifier(s.WorkspaceID) && authority.CanonicalPath(s.Root) && authority.CanonicalPath(s.Cwd) && authority.Within(s.Root, s.Cwd) && decimal(s.RootIdentity.Device) && decimal(s.RootIdentity.Inode)
}
func validInvocation(v Invocation) bool {
	if !identifier(v.RuntimeID) || !identifier(v.SessionID) || !identifier(v.ModelID) || !identifier(v.AdmissionID) || len(v.Arguments) > MaximumArguments || len(v.Input) > MaximumInput {
		return false
	}
	size := 0
	for _, arg := range v.Arguments {
		if !utf8.ValidString(arg) || strings.ContainsRune(arg, 0) {
			return false
		}
		size += len(arg)
		if size > MaximumArgumentBytes {
			return false
		}
	}
	return true
}
func sameInvocation(a, b Invocation) bool {
	return a.RuntimeID == b.RuntimeID && a.SessionID == b.SessionID && a.ModelID == b.ModelID && a.AdmissionID == b.AdmissionID && slices.Equal(a.Arguments, b.Arguments) && slices.Equal(a.Input, b.Input)
}
func scopeMatchesSeal(scope Scope, seal Seal) bool {
	return validSeal(seal) && scope.WorkspaceID == seal.WorkspaceID && scope.Root == seal.Root && scope.Cwd == seal.Cwd && scope.RootIdentity == seal.RootIdentity && scope.Write == seal.Write
}

func (s *Service) Prepare(ctx context.Context, request PrepareRequest) (*PrepareResponse, error) {
	if s == nil || ctx == nil || request.OperationID != s.intent.OperationID || !validInvocation(request.Invocation) {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	invocation := request.Invocation.Clone()
	s.gate.Lock()
	if s.preparer == nil {
		s.gate.Unlock()
		return nil, fail("PROCESS_PREPARATION_UNAVAILABLE", false)
	}
	if invocation.RuntimeID != s.scope.RuntimeID {
		s.gate.Unlock()
		return nil, fail("PROCESS_INVOCATION_MISMATCH", false)
	}
	if s.invocation != nil && !sameInvocation(*s.invocation, invocation) {
		s.gate.Unlock()
		return nil, fail("PROCESS_INVOCATION_CONFLICT", false)
	}
	if s.pending {
		s.gate.Unlock()
		return nil, fail("PROCESS_PREPARATION_PENDING", false)
	}
	if s.refusal != nil {
		err := s.refusal
		s.gate.Unlock()
		return nil, err
	}
	if s.prepared != nil {
		s.gate.Unlock()
		return s.preparation(ctx)
	}
	s.invocation = &invocation
	s.pending = true
	s.gate.Unlock()
	finish := func(err error) (*PrepareResponse, error) {
		s.gate.Lock()
		s.pending = false
		s.refusal = err
		s.gate.Unlock()
		return nil, err
	}
	if err := s.current(ctx); err != nil {
		return finish(err)
	}
	// Preparation is outside both owner and app gates. It cannot dispatch. Start
	// remains separately guarded by durable Reserve and the native Start check.
	prepared, err := s.preparer.Prepare(ctx, invocation.Clone())
	if err != nil {
		return finish(boundary(err))
	}
	if prepared == nil {
		return finish(fail("PROCESS_PREPARATION_UNKNOWN", true))
	}
	seal := prepared.Seal()
	if !sameInvocation(invocation, prepared.Invocation()) || !scopeMatchesSeal(s.scope, seal) {
		return finish(fail("PROCESS_PREPARATION_UNKNOWN", true))
	}
	if err = s.current(ctx); err != nil {
		return finish(err)
	}
	s.gate.Lock()
	s.prepared = prepared
	s.intent.Seal = seal
	s.pending = false
	s.gate.Unlock()
	// Denied disclosure does not discard/rebuild the selected launch.
	return s.preparation(ctx)
}
func (s *Service) preparation(ctx context.Context) (*PrepareResponse, error) {
	var out *PrepareResponse
	err := s.withCurrent(ctx, func() error {
		s.gate.Lock()
		defer s.gate.Unlock()
		selected, ok := s.prepared.(Selected)
		if !ok || s.invocation == nil || !scopeMatchesSeal(s.scope, selected.Seal()) || selected.Seal() != s.intent.Seal || !sameInvocation(*s.invocation, selected.Invocation()) {
			s.refusal = fail("PROCESS_PREPARATION_UNKNOWN", true)
			return s.refusal
		}
		v := s.invocation
		out = &PrepareResponse{OperationID: s.intent.OperationID, RuntimeID: v.RuntimeID, SessionID: v.SessionID, ModelID: v.ModelID, AdmissionID: v.AdmissionID, Digest: s.intent.Seal.Digest}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

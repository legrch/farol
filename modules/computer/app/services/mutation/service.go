// Package mutation owns request checking and one selected mutation attempt.
package mutation

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type Service struct {
	lease       Execution
	gate        Gate
	clock       port.Clock
	repository  port.MutationRepository
	native      port.MutableWorkspace
	digester    port.MutationDigester
	operationID string
	selected    port.TaskBinding
	deadline    time.Time
	pending     bool
	binding     *state.Binding
	terminal    *state.State
	publication string
	blocked     error
}

// New retains the pure Check-only compatibility surface.
func New() *Service { return &Service{} }

// NewForExecution captures a trusted, already selected ordinary lease. It does
// not mint authority, select an owner by request ID, or renew an existing lease.
func NewForExecution(operationID string, lease Execution, repository port.MutationRepository, native port.MutableWorkspace, digester port.MutationDigester, gate Gate, clock port.Clock) (*Service, error) {
	if !state.Identifier(operationID, 160) || lease == nil || repository == nil || native == nil || digester == nil || gate == nil || clock == nil {
		return nil, invalid()
	}
	b := lease.Binding()
	if !state.Identifier(b.OwnerID, 80) || !state.Identifier(b.SessionID, 160) || !state.Identifier(b.TaskID, 160) || !state.Identifier(b.ParticipantID, 160) || !state.Identifier(b.TurnID, 160) || b.TaskEpoch > state.MaxSafeInteger {
		return nil, invalid()
	}
	now := clock.Now()
	deadline := lease.Deadline()
	if now.UnixMilli() <= 0 || uint64(now.UnixMilli()) > state.MaxSafeInteger || !now.Before(deadline) || deadline.UnixMilli() <= 0 || uint64(deadline.UnixMilli()) > state.MaxSafeInteger || deadline.After(now.Add(authority.OrdinaryExecutionLifetime)) {
		return nil, authority.Fail("AUTHORITY_EXPIRED", "task-grant")
	}
	return &Service{operationID: operationID, lease: lease, selected: b, deadline: deadline, repository: repository, native: native, digester: digester, gate: gate, clock: clock}, nil
}
func invalid() error { return authority.Fail("COMPUTER_INVALID_REQUEST", "contract") }
func storeUnavailable() error {
	return authority.Fail("COMPUTER_MUTATION_STORE_UNAVAILABLE", "operation-store")
}
func unknown(source string) error {
	return authority.Fail("WORKSPACE_MUTATION_OUTCOME_UNKNOWN", source)
}
func classify(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) {
		return authority.Fail(f.Code, f.Source)
	}
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func convert(op Operation) state.Operation {
	switch v := op.(type) {
	case Write:
		return state.Write{RelativePath: v.RelativePath, Content: v.Content, ExpectedSHA256: cloneHash(v.ExpectedSHA256)}
	case Edit:
		edits := make([]state.TextEdit, len(v.Edits))
		for i, e := range v.Edits {
			edits[i] = state.TextEdit{OldText: e.OldText, NewText: e.NewText}
		}
		return state.Edit{RelativePath: v.RelativePath, Edits: edits, ExpectedSHA256: v.ExpectedSHA256}
	}
	return nil
}
func identity(r CheckRequest) state.Identity {
	return state.Identity{OperationID: r.OperationID, OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID}
}
func (s *Service) matches(r CheckRequest) bool {
	return s != nil && s.lease != nil && r.OperationID == s.operationID && r.OwnerID == s.selected.OwnerID && r.SessionID == s.selected.SessionID && r.TaskID == s.selected.TaskID && r.TaskEpoch == s.selected.TaskEpoch && r.ParticipantID == s.selected.ParticipantID && r.TurnID == s.selected.TurnID
}
func sameDescriptor(a, b port.MutationDescriptor) bool {
	return a.WorkspaceID == b.WorkspaceID && a.Root == b.Root && a.ApprovedRoot == b.ApprovedRoot && slices.Equal(a.DeniedPaths, b.DeniedPaths) && slices.Equal(a.WriteDeniedPaths, b.WriteDeniedPaths)
}

// current constructs disclosure under the selected owners. Native IO and the
// journal never execute inside the callback. Current exclusions remain binding.
func (s *Service) current(ctx context.Context, workspaceID, path string, expected *port.MutationDescriptor, disclose func() error) (port.MutationDescriptor, error) {
	var descriptor port.MutationDescriptor
	if ctx == nil || ctx.Err() != nil {
		return descriptor, authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	calls := 0
	var inspected error
	err := s.lease.WithSnapshot(ctx, s.selected.ParticipantID, func(snapshot port.AccessSnapshot) error {
		calls++
		reject := func(err error) error { inspected = err; return err }
		if calls != 1 {
			return reject(authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store"))
		}
		if snapshot.Participant == nil || snapshot.Participant.ParticipantID != s.selected.ParticipantID {
			return reject(authority.Fail("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store"))
		}
		if snapshot.Approval == nil {
			return reject(authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy"))
		}
		now := s.clock.Now()
		if now.UnixMilli() <= 0 || uint64(now.UnixMilli()) > state.MaxSafeInteger || !now.Before(s.deadline) {
			return reject(authority.Fail("AUTHORITY_EXPIRED", "task-grant"))
		}
		p, a := snapshot.Participant.Clone(), snapshot.Approval.Clone()
		scope, ok := authority.FindScope(p.Grant, workspaceID)
		approved, found := authority.FindApproved(a, workspaceID)
		if !ok || !found || !authority.CanonicalPath(scope.Root) || !state.RelativePath(path) {
			return reject(authority.Fail("AUTHORITY_PATH_DENIED", "task-grant"))
		}
		absolute := strings.TrimSuffix(scope.Root, "/") + "/" + path
		action := authority.Action{Identity: s.selected.Identity, Operation: authority.Operation{Kind: authority.Write, WorkspaceID: workspaceID, Path: absolute, Write: true}}
		if err := authority.AuthorizeComputer(p, a, action, now); err != nil {
			return reject(err)
		}
		descriptor = port.MutationDescriptor{WorkspaceID: workspaceID, Root: scope.Root, ApprovedRoot: port.Root{Path: approved.Root, Device: approved.RootIdentity.Device, Inode: approved.RootIdentity.Inode}}
		depth := len(strings.Split(strings.TrimPrefix(scope.Root, "/"), "/"))
		if scope.Root == "/" {
			depth = 0
		}
		for _, ex := range append(slices.Clone(p.Grant.ExcludedPaths), a.ExcludedPaths...) {
			if ex.WorkspaceID != workspaceID || !authority.ComparableWithin(scope.Root, ex.Path) {
				continue
			}
			parts := strings.Split(strings.TrimPrefix(ex.Path, "/"), "/")
			if len(parts) > depth {
				relative := strings.Join(parts[depth:], "/")
				if !slices.Contains(descriptor.DeniedPaths, relative) {
					descriptor.DeniedPaths = append(descriptor.DeniedPaths, relative)
				}
			}
		}
		if expected != nil && !sameDescriptor(*expected, descriptor) {
			return reject(authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy"))
		}
		if ctx.Err() != nil {
			return reject(authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace"))
		}
		if disclose != nil {
			return reject(disclose())
		}
		return nil
	})
	if err != nil {
		return descriptor, classify(err)
	}
	if calls != 1 {
		return descriptor, authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	return descriptor, inspected
}

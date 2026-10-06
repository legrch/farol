package mutation

import (
	"context"
	"strings"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type ownerAuthority struct {
	selected OwnerSelection
	source   port.CurrentOwnerApproval
	initial  authority.Approval
	clock    port.Clock
	deadline time.Time
}

func (s *ownerAuthority) matches(a authority.Approval) error {
	if a.OwnerID != s.selected.OwnerID {
		return authority.Fail("AUTHORITY_OWNER_MISMATCH", "computer-approval")
	}
	if a.ComputerID != s.selected.ComputerID || a.Generation != s.selected.ComputerGeneration {
		return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
	}
	return nil
}
func (s *ownerAuthority) live(ctx context.Context) error {
	if ctx == nil || ctx.Err() != nil {
		return authority.Fail("WORKSPACE_MUTATION_CANCELLED", "native-workspace")
	}
	now := s.clock.Now()
	if now.UnixMilli() <= 0 || uint64(now.UnixMilli()) > state.MaxSafeInteger || !now.Before(s.deadline) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	return nil
}

func (s *ownerAuthority) current(ctx context.Context, workspaceID, path string, expected *port.MutationDescriptor, disclose func() error) (port.MutationDescriptor, error) {
	var descriptor port.MutationDescriptor
	if err := s.live(ctx); err != nil {
		return descriptor, err
	}
	err := s.withCurrent(ctx, func(a authority.Approval) error {
		if err := s.live(ctx); err != nil {
			return err
		}
		if err := s.matches(a); err != nil {
			return err
		}
		if !authority.SameApprovalPolicy(s.initial, a) || !s.initial.ExpiresAt.Equal(a.ExpiresAt) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		w, ok := authority.FindApproved(a, workspaceID)
		if !ok || !state.RelativePath(path) {
			return authority.Fail("AUTHORITY_PATH_DENIED", "computer-approval")
		}
		if err := authority.AuthorizeOwnerWrite(a, workspaceID, w.Root+"/"+path, s.clock.Now()); err != nil {
			return err
		}
		descriptor = port.MutationDescriptor{FilePolicy: a.FilePolicy, WorkspaceID: workspaceID, Root: w.Root, ApprovedRoot: port.Root{Path: w.Root, Device: w.RootIdentity.Device, Inode: w.RootIdentity.Inode}}
		for _, ex := range a.ExcludedPaths {
			if ex.WorkspaceID == workspaceID && authority.Within(w.Root, ex.Path) && ex.Path != w.Root {
				descriptor.DeniedPaths = append(descriptor.DeniedPaths, strings.TrimPrefix(ex.Path, w.Root+"/"))
			}
		}
		if expected != nil && !sameDescriptor(*expected, descriptor) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		if disclose != nil {
			return disclose()
		}
		return nil
	})
	if err != nil {
		return descriptor, err
	}
	return descriptor, s.live(ctx)
}

// The port owns synchronization and calls back synchronously. Refuse skipped,
// repeated, late, swallowed or subsequently mutated snapshots. IO never occurs
// inside this callback, including journal admission and terminal publication.
func (s *ownerAuthority) withCurrent(ctx context.Context, inspect func(authority.Approval) error) error {
	calls, closed := 0, false
	var callbackErr error
	var original *authority.Approval
	var captured authority.Approval
	unavailable := func() error { return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store") }
	err := s.source.WithCurrent(ctx, func(a *authority.Approval) error {
		if closed {
			return unavailable()
		}
		calls++
		if calls != 1 {
			callbackErr = unavailable()
			return callbackErr
		}
		if a == nil {
			callbackErr = authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-approval")
			return callbackErr
		}
		original, captured = a, a.Clone()
		callbackErr = inspect(captured.Clone())
		return callbackErr
	})
	closed = true
	if calls > 1 || calls == 0 && err == nil {
		return unavailable()
	}
	if callbackErr != nil {
		return callbackErr
	}
	if calls == 1 && (original == nil || !authority.SameApprovalPolicy(*original, captured) || !original.ExpiresAt.Equal(captured.ExpiresAt)) {
		return unavailable()
	}
	if err != nil {
		return classify(err)
	}
	return nil
}

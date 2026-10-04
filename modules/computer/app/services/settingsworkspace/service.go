// Package settingsworkspace owns pure, bounded owner Settings listings.
package settingsworkspace

import (
	"context"
	"errors"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Service struct {
	current port.CurrentOwnerApproval
	native  port.Workspace
	clock   port.Clock
}

// Composition supplies concrete nonnil dependencies. CurrentOwnerApproval owns
// synchronization; its callback is synchronous and cannot escape to another goroutine.
func New(current port.CurrentOwnerApproval, native port.Workspace, clock port.Clock) *Service {
	return &Service{current: current, native: native, clock: clock}
}

type Request struct{ WorkspaceID, RelativePath string }
type Result struct {
	WorkspaceID, RelativePath string
	Root                      port.Root
	Entries                   []string
	Truncated                 bool
}

// List dispatches exactly one native listing between two current-approval reads.
// The fixed lease gates dispatch and disclosure through the injected clock. It
// does not create an ambient timer or promise to interrupt blocked native IO;
// native execution retains the caller's cancellation context.
func (s *Service) List(ctx context.Context, request Request) (*Result, error) {
	if s == nil || s.current == nil || s.native == nil || s.clock == nil {
		return nil, unavailable()
	}
	if err := active(ctx, s.clock.Now()); err != nil {
		return nil, err
	}
	if !identifier(request.WorkspaceID) || !relative(request.RelativePath) {
		return nil, authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	var initial authority.Approval
	var descriptor port.Descriptor
	var target string
	var deadline time.Time
	err := s.withCurrent(ctx, func(a authority.Approval) error {
		now := s.clock.Now()
		if err := active(ctx, now); err != nil {
			return err
		}
		w, found := authority.FindApproved(a, request.WorkspaceID)
		if !found {
			return authority.Fail("AUTHORITY_PATH_DENIED", "computer-approval")
		}
		target = join(w.Root, request.RelativePath)
		if err := authority.AuthorizeOwnerList(a, request.WorkspaceID, target, now); err != nil {
			return err
		}
		initial = a.Clone()
		deadline = now.Add(authority.OrdinaryExecutionLifetime)
		if a.ExpiresAt.Before(deadline) {
			deadline = a.ExpiresAt
		}
		if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
			deadline = d
		}
		descriptor = port.Descriptor{WorkspaceID: w.WorkspaceID, Root: w.Root,
			ApprovedRoot: port.Root{Path: w.Root, Device: w.RootIdentity.Device, Inode: w.RootIdentity.Inode}}
		for _, e := range a.ExcludedPaths {
			if e.WorkspaceID == w.WorkspaceID && authority.Within(w.Root, e.Path) && e.Path != w.Root {
				descriptor.DeniedPaths = append(descriptor.DeniedPaths, strings.TrimPrefix(e.Path, w.Root+"/"))
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := liveLease(ctx, s.clock.Now(), deadline); err != nil {
		return nil, err
	}
	nativeRequest := port.ListRequest{Workspace: descriptor, RelativePath: request.RelativePath}
	nativeRequest.Workspace.DeniedPaths = slices.Clone(descriptor.DeniedPaths)
	checked, err := s.native.List(ctx, nativeRequest)
	if err != nil {
		return nil, err
	}
	if checked == nil || checked.Binding == nil || len(checked.Entries) > 500 {
		return nil, malformed()
	}
	binding := *checked.Binding
	// Keep empty listings representable as a JSON array at the wire boundary.
	entries := append([]string{}, checked.Entries...)
	truncated := checked.Truncated
	if binding.RelativePath != request.RelativePath || binding.Root != descriptor.Root || binding.ApprovedRoot != descriptor.ApprovedRoot {
		return nil, authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		name := strings.TrimSuffix(entry, "/")
		if len(entry) > 1024 || !relative(name) || name == "." || strings.Contains(name, "/") || seen[name] {
			return nil, malformed()
		}
		seen[name] = true
		if err := authority.AuthorizeOwnerList(initial, request.WorkspaceID, target+"/"+name, s.clock.Now()); err != nil {
			return nil, err
		}
	}
	var result *Result
	err = s.withCurrent(ctx, func(current authority.Approval) error {
		now := s.clock.Now()
		if err := liveLease(ctx, now, deadline); err != nil {
			return err
		}
		if !authority.SameApprovalPolicy(initial, current) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		if err := authority.AuthorizeOwnerList(current, request.WorkspaceID, target, now); err != nil {
			return err
		}
		result = &Result{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath,
			Root: binding.ApprovedRoot, Entries: slices.Clone(entries), Truncated: truncated}
		return nil
	})
	// A successful callback is insufficient: the enclosing port must also succeed.
	if err != nil {
		return nil, err
	}
	if err := liveLease(ctx, s.clock.Now(), deadline); err != nil {
		return nil, err
	}
	return result, nil
}

// Preserve callback failures even if a broken port swallows them. A skipped,
// repeated, late or mutated callback snapshot cannot admit or disclose output.
func (s *Service) withCurrent(ctx context.Context, inspect func(authority.Approval) error) error {
	calls := 0
	closed := false
	var callbackErr error
	var original *authority.Approval
	var captured authority.Approval
	err := s.current.WithCurrent(ctx, func(a *authority.Approval) error {
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
		return currentFailure(err)
	}
	return nil
}

// Preserve classified current-authority refusals, including refusals before a
// snapshot is available. Raw store diagnostics never leave this adapter seam.
func currentFailure(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && f != nil {
		switch f.Source {
		case "computer-approval", "computer-policy", "authority-store":
			switch f.Code {
			case "COMPUTER_APPROVAL_NOT_FOUND", "COMPUTER_APPROVAL_INVALID", "COMPUTER_APPROVAL_STORE_UNAVAILABLE",
				"COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "AUTHORITY_OWNER_MISMATCH", "AUTHORITY_COMPUTER_MISMATCH",
				"AUTHORITY_EXPIRED", "AUTHORITY_CAPABILITY_DENIED", "AUTHORITY_PATH_DENIED":
				return authority.Fail(f.Code, f.Source)
			}
		}
	}
	return unavailable()
}

func unavailable() error {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func malformed() error { return authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace") }
func active(ctx context.Context, now time.Time) error {
	if ctx == nil || ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	if d, ok := ctx.Deadline(); ok && !now.Before(d) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	return nil
}
func liveLease(ctx context.Context, now, deadline time.Time) error {
	if err := active(ctx, now); err != nil {
		return err
	}
	if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(deadline) {
		return authority.Fail("AUTHORITY_EXPIRED", "computer-approval")
	}
	return nil
}
func identifier(v string) bool {
	if v == "" || !utf8.ValidString(v) {
		return false
	}
	units := 0
	for _, r := range v {
		if r < 32 || r == 127 {
			return false
		}
		units++
		if r > 0xffff {
			units++
		}
	}
	return units <= 120
}
func relative(v string) bool {
	if v == "." {
		return true
	}
	if v == "" || !utf8.ValidString(v) || len(v) > 4096 || strings.Contains(v, "\\") {
		return false
	}
	parts := strings.Split(v, "/")
	if len(parts) > 256 {
		return false
	}
	for _, p := range parts {
		if p == "" || p == "." || p == ".." || len(p) > 255 {
			return false
		}
		for _, r := range p {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}
func join(root, relative string) string {
	if relative == "." {
		return root
	}
	return root + "/" + relative
}

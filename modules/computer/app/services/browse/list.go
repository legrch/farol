package browse

import (
	"context"
	"slices"
	"strings"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// ListQuery reads one approved directory; it changes no state.
type ListQuery struct{ WorkspaceID, RelativePath string }
type ListResult struct {
	WorkspaceID, RelativePath string
	Root                      port.Root
	Entries                   []string
	Truncated                 bool
}

// List dispatches exactly one native listing between two current-approval reads.
// The fixed lease gates dispatch and disclosure through the injected clock. It
// does not create an ambient timer or promise to interrupt blocked native IO;
// native execution retains the caller's cancellation context.
func (s *Service) List(ctx context.Context, query ListQuery) (*ListResult, error) {
	return s.directory(ctx, query, false)
}

// Inspect returns physical directory access, without collecting child entries.
func (s *Service) Inspect(ctx context.Context, query ListQuery) (*ListResult, error) {
	return s.directory(ctx, query, true)
}

func (s *Service) directory(ctx context.Context, query ListQuery, inspectOnly bool) (*ListResult, error) {
	if s == nil || s.current == nil || s.native == nil || s.clock == nil {
		return nil, unavailable()
	}
	if err := active(ctx, s.clock.Now()); err != nil {
		return nil, err
	}
	if !identifier(query.WorkspaceID) || !relative(query.RelativePath) {
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
		w, found := authority.FindApproved(a, query.WorkspaceID)
		if !found {
			return authority.Fail("AUTHORITY_PATH_DENIED", "computer-approval")
		}
		target = join(w.Root, query.RelativePath)
		if err := authority.AuthorizeOwnerList(a, query.WorkspaceID, target, now); err != nil {
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
		descriptor = port.Descriptor{FilePolicy: a.FilePolicy, WorkspaceID: w.WorkspaceID, Root: w.Root,
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
	nativeRequest := port.ListRequest{Workspace: descriptor, RelativePath: query.RelativePath}
	nativeRequest.Workspace.DeniedPaths = slices.Clone(descriptor.DeniedPaths)
	var checked *port.ListResponse
	if inspectOnly {
		inspector, ok := s.native.(port.DirectoryInspector)
		if !ok {
			return nil, unavailable()
		}
		binding, failure := inspector.Inspect(ctx, nativeRequest)
		err = failure
		checked = &port.ListResponse{Binding: binding}
	} else {
		checked, err = s.native.List(ctx, nativeRequest)
	}
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
	if binding.RelativePath != query.RelativePath || binding.Root != descriptor.Root || binding.ApprovedRoot != descriptor.ApprovedRoot {
		return nil, authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
	}
	seen := map[string]bool{}
	for _, entry := range entries {
		name := strings.TrimSuffix(entry, "/")
		if len(entry) > 1024 || !relative(name) || name == "." || strings.Contains(name, "/") || seen[name] {
			return nil, malformed()
		}
		seen[name] = true
		if err := authority.AuthorizeOwnerList(initial, query.WorkspaceID, target+"/"+name, s.clock.Now()); err != nil {
			return nil, err
		}
	}
	var result *ListResult
	err = s.withCurrent(ctx, func(current authority.Approval) error {
		now := s.clock.Now()
		if err := liveLease(ctx, now, deadline); err != nil {
			return err
		}
		if !authority.SameApprovalPolicy(initial, current) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		if err := authority.AuthorizeOwnerList(current, query.WorkspaceID, target, now); err != nil {
			return err
		}
		result = &ListResult{WorkspaceID: query.WorkspaceID, RelativePath: query.RelativePath,
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

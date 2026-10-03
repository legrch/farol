// Package workspace owns read disclosure under current task and Computer
// authority. Native IO and repository lifetimes are supplied by composition.
package workspace

import (
	"context"
	"errors"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Service struct {
	access    port.AccessRepository
	workspace port.Workspace
	clock     port.Clock
}

func New(access port.AccessRepository, workspace port.Workspace, clock port.Clock) *Service {
	return &Service{access: access, workspace: workspace, clock: clock}
}

type caller struct {
	identity                  authority.Identity
	participantID             string
	workspaceID, relativePath string
}
type admission struct {
	action                              authority.Action
	descriptor                          port.Descriptor
	mode                                authority.Mode
	authorityID, computerID             string
	computerGeneration                  uint64
	grantExclusions, approvalExclusions []authority.Exclusion
}

func absoluteTarget(root, relative string) (string, bool) {
	if !authority.CanonicalPath(root) || !utf8.ValidString(relative) {
		return "", false
	}
	if relative == "." {
		return root, true
	}
	if relative == "" || strings.HasPrefix(relative, "/") || strings.Contains(relative, "\\") {
		return "", false
	}
	units := 0
	for _, r := range relative {
		units++
		if r > 0xffff {
			units++
		}
		if r < 32 || r == 127 {
			return "", false
		}
	}
	if units > 4096 {
		return "", false
	}
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." {
			return "", false
		}
	}
	if root == "/" {
		return "/" + relative, true
	}
	return root + "/" + relative, true
}
func (s *Service) withAuthority(ctx context.Context, caller caller, inspect func(*authority.Participant, *authority.Approval) error) error {
	called := false
	err := s.access.WithSnapshot(ctx, caller.participantID, func(snapshot port.AccessSnapshot) error {
		if called {
			return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
		}
		called = true
		if err := cancelled(ctx); err != nil {
			return err
		}
		if snapshot.Participant == nil || snapshot.Participant.ParticipantID != caller.participantID {
			return authority.Fail("COMPUTER_PARTICIPANT_NOT_FOUND", "authority-store")
		}
		p := *snapshot.Participant
		p.Grant = snapshot.Participant.Grant.Clone()
		if err := authority.AuthorizeIdentity(p, caller.identity); err != nil {
			return err
		}
		if snapshot.Approval == nil {
			return authority.Fail("COMPUTER_APPROVAL_NOT_FOUND", "computer-policy")
		}
		a := *snapshot.Approval
		a.Workspaces = slices.Clone(a.Workspaces)
		a.ExcludedPaths = slices.Clone(a.ExcludedPaths)
		a.Capabilities = slices.Clone(a.Capabilities)
		return inspect(&p, &a)
	})
	if err != nil {
		var classified *authority.Failure
		if errors.As(err, &classified) {
			return err
		}
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	if !called {
		return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
	}
	return nil
}

func descriptor(scope authority.Scope, p authority.Participant, a authority.Approval) (port.Descriptor, error) {
	approved, found := authority.FindApproved(a, scope.WorkspaceID)
	if !found {
		return port.Descriptor{}, authority.Fail("AUTHORITY_PATH_DENIED", "computer-approval")
	}
	d := port.Descriptor{WorkspaceID: scope.WorkspaceID, Root: scope.Root, ApprovedRoot: port.Root{Path: approved.Root, Device: approved.RootIdentity.Device, Inode: approved.RootIdentity.Inode}}
	// Include current policy exclusions as well as inherited grant exclusions.
	// Component comparison keeps aliases of excluded descendants visible to the
	// native deny comparator even beneath a narrower root.
	rootParts := strings.Split(strings.TrimPrefix(scope.Root, "/"), "/")
	depth := len(rootParts)
	if scope.Root == "/" {
		depth = 0
	}
	exclusions := append(append([]authority.Exclusion(nil), p.Grant.ExcludedPaths...), a.ExcludedPaths...)
	for _, exclusion := range exclusions {
		if exclusion.WorkspaceID != scope.WorkspaceID || !authority.ComparableWithin(scope.Root, exclusion.Path) {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(exclusion.Path, "/"), "/")
		if len(parts) <= depth {
			continue
		}
		relative := strings.Join(parts[depth:], "/")
		if !slices.Contains(d.DeniedPaths, relative) {
			d.DeniedPaths = append(d.DeniedPaths, relative)
		}
	}
	if scope.Mode == authority.Exact {
		d.ExactFilePaths = make([]string, 0, len(scope.Paths))
		prefix := scope.Root + "/"
		if scope.Root == "/" {
			prefix = "/"
		}
		for _, path := range scope.Paths {
			if !authority.Within(scope.Root, path) {
				return port.Descriptor{}, authority.Fail("AUTHORITY_PATH_DENIED", "task-grant")
			}
			relative := "."
			if path != scope.Root {
				relative = strings.TrimPrefix(path, prefix)
			}
			d.ExactFilePaths = append(d.ExactFilePaths, relative)
		}
	}
	return d, nil
}
func (s *Service) admit(ctx context.Context, caller caller, kind authority.Capability) (*admission, error) {
	if err := cancelled(ctx); err != nil {
		return nil, err
	}
	var admitted *admission
	err := s.withAuthority(ctx, caller, func(p *authority.Participant, a *authority.Approval) error {
		scope, found := authority.FindScope(p.Grant, caller.workspaceID)
		if !found {
			return authority.Fail("AUTHORITY_PATH_DENIED", "task-grant")
		}
		target, valid := absoluteTarget(scope.Root, caller.relativePath)
		if !valid {
			return authority.Fail("COMPUTER_PATH_INVALID", "task-grant")
		}
		action := authority.Action{Identity: caller.identity, Operation: authority.Operation{Kind: kind, WorkspaceID: caller.workspaceID, Path: target}}
		if err := authority.AuthorizeComputer(*p, *a, action, s.clock.Now()); err != nil {
			return err
		}
		if kind == authority.List && scope.Mode == authority.Exact {
			return authority.Fail("AUTHORITY_PATH_DENIED", "task-grant")
		}
		d, err := descriptor(scope, *p, *a)
		if err != nil {
			return err
		}
		if err := cancelled(ctx); err != nil {
			return err
		}
		admitted = &admission{action: action, descriptor: d, mode: scope.Mode, authorityID: p.Grant.AuthorityID, computerID: p.Grant.ComputerID, computerGeneration: p.Grant.ComputerGeneration, grantExclusions: slices.Clone(p.Grant.ExcludedPaths), approvalExclusions: slices.Clone(a.ExcludedPaths)}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return admitted, nil
}

func (s *Service) disclose(ctx context.Context, caller caller, initial admission, publish func()) error {
	if err := cancelled(ctx); err != nil {
		return err
	}
	return s.withAuthority(ctx, caller, func(p *authority.Participant, a *authority.Approval) error {
		if err := authority.AuthorizeComputer(*p, *a, initial.action, s.clock.Now()); err != nil {
			return err
		}
		scope, found := authority.FindScope(p.Grant, caller.workspaceID)
		if !found {
			return authority.Fail("AUTHORITY_PATH_DENIED", "task-grant")
		}
		current, err := descriptor(scope, *p, *a)
		if err != nil {
			return err
		}
		if current.Root != initial.descriptor.Root || scope.Mode != initial.mode || current.ApprovedRoot != initial.descriptor.ApprovedRoot {
			return authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
		}
		if p.Grant.AuthorityID != initial.authorityID || p.Grant.ComputerID != initial.computerID || p.Grant.ComputerGeneration != initial.computerGeneration {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-policy")
		}
		// Re-authorizing just the directory is insufficient for list output: a newly
		// excluded descendant or changed exact-file allowlist can revoke disclosure.
		if !slices.Equal(current.DeniedPaths, initial.descriptor.DeniedPaths) || !slices.Equal(current.ExactFilePaths, initial.descriptor.ExactFilePaths) {
			source := authority.DenialSource(scope.RestrictionSource)
			if !slices.Equal(a.ExcludedPaths, initial.approvalExclusions) {
				source = "computer-policy"
			} else {
				for _, exclusion := range p.Grant.ExcludedPaths {
					if !slices.Contains(initial.grantExclusions, exclusion) {
						source = authority.DenialSource(exclusion.RestrictionSource)
						break
					}
				}
			}
			return authority.Fail("AUTHORITY_PATH_DENIED", source)
		}
		if err := cancelled(ctx); err != nil {
			return err
		}
		publish()
		return nil
	})
}

func cancelled(ctx context.Context) error {
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
	}
	return nil
}
func nativeFailure(err error) error {
	var failure *authority.Failure
	if errors.As(err, &failure) {
		return authority.Fail(failure.Code, "native-workspace")
	}
	return authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
}
func cloneDescriptor(d port.Descriptor) port.Descriptor {
	d.DeniedPaths = slices.Clone(d.DeniedPaths)
	d.ExactFilePaths = slices.Clone(d.ExactFilePaths)
	return d
}

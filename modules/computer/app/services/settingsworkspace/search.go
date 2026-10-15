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

type SearchRequest struct{ WorkspaceID, RelativePath, Pattern string }
type SearchMatch struct {
	Path      string
	Line      uint64
	Text      string
	Truncated bool
}
type SearchResult struct {
	WorkspaceID, RelativePath, Pattern string
	Root                               port.Root
	Matches                            []SearchMatch
	ResultLimited, ScanLimited         bool
}

// Search uses the same current owner publication and fixed Settings lease as
// List. It grants no Task/Turn authority and invokes only the selected native
// Search capability, with no interpreter or alternate producer fallback.
func (s *Service) Search(ctx context.Context, request SearchRequest) (*SearchResult, error) {
	if s == nil || s.current == nil || s.native == nil || s.clock == nil {
		return nil, unavailable()
	}
	if err := active(ctx, s.clock.Now()); err != nil {
		return nil, err
	}
	if !identifier(request.WorkspaceID) || !relative(request.RelativePath) {
		return nil, authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	if !searchPattern(request.Pattern) {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "contract")
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
		if err := authority.AuthorizeOwnerSearch(a, request.WorkspaceID, target, now); err != nil {
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
	native, ok := s.native.(port.Search)
	if !ok {
		return nil, malformed()
	}
	nativeRequest := port.SearchRequest{Workspace: descriptor, RelativePath: request.RelativePath, Pattern: request.Pattern}
	nativeRequest.Workspace.DeniedPaths = slices.Clone(descriptor.DeniedPaths)
	checked, err := native.Search(ctx, nativeRequest)
	if err != nil {
		return nil, searchNativeFailure(err)
	}
	if checked == nil || checked.Binding == nil || len(checked.Matches) > 100 {
		return nil, malformed()
	}
	// Capture every native value before another current-authority callback.
	// Neither the producer nor a callback can replace validated output afterward.
	binding := *checked.Binding
	matches := append([]port.SearchMatch{}, checked.Matches...)
	resultLimited, scanLimited := checked.ResultLimited, checked.ScanLimited
	if binding.RelativePath != request.RelativePath || binding.Root != descriptor.Root || binding.ApprovedRoot != descriptor.ApprovedRoot {
		return nil, authority.Fail("WORKSPACE_ROOT_CHANGED", "native-workspace")
	}
	for _, match := range matches {
		if !searchMatch(match, request.RelativePath) {
			return nil, malformed()
		}
		if err := authority.AuthorizeOwnerSearch(initial, request.WorkspaceID, join(descriptor.Root, match.Path), s.clock.Now()); err != nil {
			return nil, err
		}
	}
	var result *SearchResult
	err = s.withCurrent(ctx, func(current authority.Approval) error {
		now := s.clock.Now()
		if err := liveLease(ctx, now, deadline); err != nil {
			return err
		}
		if !authority.SameApprovalPolicy(initial, current) {
			return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "computer-approval")
		}
		if err := authority.AuthorizeOwnerSearch(current, request.WorkspaceID, target, now); err != nil {
			return err
		}
		out := make([]SearchMatch, len(matches))
		for i, match := range matches {
			out[i] = SearchMatch{Path: match.Path, Line: match.Line, Text: match.Text, Truncated: match.Truncated}
		}
		result = &SearchResult{WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Pattern: request.Pattern,
			Root: binding.ApprovedRoot, Matches: out, ResultLimited: resultLimited, ScanLimited: scanLimited}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if err := liveLease(ctx, s.clock.Now(), deadline); err != nil {
		return nil, err
	}
	return result, nil
}

func searchPattern(pattern string) bool {
	if pattern == "" || len(pattern) > 4096 || !utf8.ValidString(pattern) {
		return false
	}
	for _, r := range pattern {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}

func searchMatch(match port.SearchMatch, scope string) bool {
	if match.Path == "." || !relative(match.Path) || match.Line == 0 || match.Line > 9007199254740991 ||
		!utf8.ValidString(match.Text) || utf8.RuneCountInString(match.Text) > 500 ||
		(scope != "." && match.Path != scope && !strings.HasPrefix(match.Path, scope+"/")) {
		return false
	}
	for _, r := range match.Text {
		if r != '\t' && (r < 32 || r == 127) {
			return false
		}
	}
	return true
}

func searchNativeFailure(err error) error {
	var f *authority.Failure
	if errors.As(err, &f) && f != nil && f.Source == "native-workspace" {
		switch f.Code {
		case "WORKSPACE_INVALID_REQUEST", "WORKSPACE_POLICY_TOO_LARGE", "WORKSPACE_REQUEST_CANCELLED",
			"WORKSPACE_PATH_REFUSED", "WORKSPACE_ROOT_CHANGED", "WORKSPACE_NOT_FOUND",
			"WORKSPACE_RACE_DETECTED", "WORKSPACE_HELPER_FAILED", "WORKSPACE_FILE_TOO_LARGE",
			"WORKSPACE_NOT_TEXT", "WORKSPACE_NOT_A_FILE", "WORKSPACE_SEARCH_TIMEOUT":
			return authority.Fail(f.Code, f.Source)
		}
	}
	return malformed()
}

package workspace

import (
	"context"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type SearchRequest struct {
	OwnerID, SessionID, TaskID                 string
	TaskEpoch                                  uint64
	ParticipantID, TurnID                      string
	Generation                                 uint64
	CallID, WorkspaceID, RelativePath, Pattern string
}
type SearchMatch struct {
	Path      string
	Line      uint64
	Text      string
	Truncated bool
}
type SearchResponse struct {
	OwnerID, SessionID, TaskID        string
	TaskEpoch                         uint64
	ParticipantID, TurnID             string
	Generation                        uint64
	CallID, WorkspaceID, RelativePath string
	Matches                           []SearchMatch
	ResultLimited, ScanLimited        bool
}

// Search uses the selected operation's existing execution lease for both native
// admission and final disclosure. It publishes no transport or fallback route.
func (s *Service) Search(ctx context.Context, request SearchRequest) (*SearchResponse, error) {
	if !validIdentifier(request.Pattern, 4096) {
		return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "contract")
	}
	for _, r := range request.Pattern {
		if r < 32 || r == 127 {
			return nil, authority.Fail("WORKSPACE_INVALID_REQUEST", "contract")
		}
	}
	binding := correlation{TaskBinding: port.TaskBinding{Identity: authority.Identity{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch}, ParticipantID: request.ParticipantID, TurnID: request.TurnID}, generation: request.Generation, callID: request.CallID}
	if err := s.withDiscovery(ctx, binding, func(*authority.Participant, *authority.Approval) error { return nil }); err != nil {
		return nil, err
	}
	caller := caller{identity: binding.Identity, participantID: request.ParticipantID, workspaceID: request.WorkspaceID, relativePath: request.RelativePath}
	admitted, err := s.admit(ctx, caller, authority.Search)
	if err != nil {
		return nil, err
	}
	search, ok := s.workspace.(port.Search)
	if !ok {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	result, err := search.Search(ctx, port.SearchRequest{Workspace: cloneDescriptor(admitted.descriptor), RelativePath: request.RelativePath, Pattern: request.Pattern})
	if err != nil {
		return nil, nativeFailure(err)
	}
	// Seal the adapter's response before another authority callback. A store
	// callback cannot replace already-validated matches through shared slices.
	if result != nil {
		independent := *result
		independent.Matches = slices.Clone(result.Matches)
		if result.Binding != nil {
			binding := *result.Binding
			independent.Binding = &binding
		}
		result = &independent
	}
	if !validSearchResult(result, request, admitted.descriptor) {
		return nil, authority.Fail("WORKSPACE_HELPER_FAILED", "native-workspace")
	}
	var response *SearchResponse
	err = s.disclose(ctx, caller, *admitted, func() {
		matches := make([]SearchMatch, len(result.Matches))
		for i, m := range result.Matches {
			matches[i] = SearchMatch{Path: m.Path, Line: m.Line, Text: m.Text, Truncated: m.Truncated}
		}
		response = &SearchResponse{OwnerID: request.OwnerID, SessionID: request.SessionID, TaskID: request.TaskID, TaskEpoch: request.TaskEpoch, ParticipantID: request.ParticipantID, TurnID: request.TurnID, Generation: request.Generation, CallID: request.CallID, WorkspaceID: request.WorkspaceID, RelativePath: request.RelativePath, Matches: matches, ResultLimited: result.ResultLimited, ScanLimited: result.ScanLimited}
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

func validSearchResult(result *port.SearchResponse, request SearchRequest, d port.Descriptor) bool {
	if result == nil || result.Binding == nil || !validContextBinding(*result.Binding) || result.Binding.RelativePath != request.RelativePath || result.Binding.Root != d.Root || result.Binding.ApprovedRoot != d.ApprovedRoot || len(result.Matches) > 100 {
		return false
	}
	for _, m := range result.Matches {
		if m.Path == "." || m.Line == 0 || m.Line > 9007199254740991 || !utf8.ValidString(m.Text) || utf8.RuneCountInString(m.Text) > 500 {
			return false
		}
		absolute, valid := absoluteTarget(d.Root, m.Path)
		if !valid || (request.RelativePath != "." && m.Path != request.RelativePath && !strings.HasPrefix(m.Path, request.RelativePath+"/")) {
			return false
		}
		if d.ExactFilePaths != nil && !slices.Contains(d.ExactFilePaths, m.Path) {
			return false
		}
		for _, denied := range d.DeniedPaths {
			target, valid := absoluteTarget(d.Root, denied)
			if !valid || authority.ComparableWithin(target, absolute) {
				return false
			}
		}
		for _, r := range m.Text {
			if r != '\t' && (r < 32 || r == 127) {
				return false
			}
		}
	}
	return true
}

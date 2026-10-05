package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	wire "github.com/legrch/farol/gen/desktop/v1"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/pkg/ipc"
)

// SearchFactory selects the existing owner and one execution lease after parsing.
// Request correlation cannot mint authority or select another physical root.
type SearchFactory func(context.Context, workspacect.SearchRequest) (*workspacect.Contract, error)

func SearchMethod(resolve SearchFactory, peer wire.Context) Method {
	return Method{Handle: func(ctx context.Context, request Request) (*Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerSearchRequest", request.Body) != nil {
			return searchRefusal(nil, "invalid_search_request", "transport"), nil
		}
		var body wire.ComputerSearchRequest
		if err := json.Unmarshal(request.Body, &body); err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			return searchRefusal(&body, "WORKSPACE_REQUEST_CANCELLED", "native-workspace"), nil
		}
		if resolve == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		epoch, _ := strconv.ParseUint(body.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(body.Generation, 10, 64)
		input := workspacect.SearchRequest{OwnerID: body.OwnerId, SessionID: body.SessionId, TaskID: body.TaskId, TaskEpoch: epoch, ParticipantID: body.ParticipantId, TurnID: body.TurnId, Generation: generation, CallID: body.CallId, WorkspaceID: body.WorkspaceId, RelativePath: body.RelativePath, Pattern: body.Pattern}
		contract, err := resolve(ctx, input)
		if err != nil {
			return searchFailure(&body, err)
		}
		if contract == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		out, err := contract.Search(ctx, input)
		if err != nil {
			return searchFailure(&body, err)
		}
		if out == nil || out.OwnerID != input.OwnerID || out.SessionID != input.SessionID || out.TaskID != input.TaskID || out.TaskEpoch != input.TaskEpoch || out.ParticipantID != input.ParticipantID || out.TurnID != input.TurnID || out.Generation != input.Generation || out.CallID != input.CallID || out.WorkspaceID != input.WorkspaceID || out.RelativePath != input.RelativePath {
			return nil, errors.New("crossed Computer search result")
		}
		if len(out.Matches) > 100 {
			return nil, errors.New("invalid Computer search result")
		}
		matches := make([]wire.ComputerSearchMatch, 0, len(out.Matches))
		for _, match := range out.Matches {
			if match.Line == 0 || match.Line > 9007199254740991 || !utf8.ValidString(match.Text) || utf8.RuneCountInString(match.Text) > 500 || !validSearchResultPath(match.Path, body.RelativePath) {
				return nil, errors.New("invalid Computer search match")
			}
			for _, r := range match.Text {
				if r != '\t' && (r < 32 || r == 127) {
					return nil, errors.New("invalid Computer search match")
				}
			}
			value := wire.ComputerSearchMatch{Path: match.Path, Line: strconv.FormatUint(match.Line, 10), Text: match.Text, Truncated: match.Truncated}
			raw, err := json.Marshal(value)
			if err != nil || wire.Validate("ComputerSearchMatch", raw) != nil {
				return nil, errors.New("invalid Computer search match")
			}
			matches = append(matches, value)
		}
		encodedMatches, err := json.Marshal(matches)
		if err != nil {
			return nil, err
		}
		result := wire.ComputerSearchResponse{OwnerId: out.OwnerID, SessionId: out.SessionID, TaskId: out.TaskID, TaskEpoch: strconv.FormatUint(out.TaskEpoch, 10), ParticipantId: out.ParticipantID, TurnId: out.TurnID, Generation: strconv.FormatUint(out.Generation, 10), CallId: out.CallID, WorkspaceId: out.WorkspaceID, RelativePath: out.RelativePath, Pattern: input.Pattern, Matches: encodedMatches, ResultLimited: out.ResultLimited, ScanLimited: out.ScanLimited}
		data, err := json.Marshal(result)
		if err != nil || wire.Validate("ComputerSearchResponse", data) != nil {
			return nil, errors.New("invalid Computer search result")
		}
		encoded, err := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: request.RequestID, Context: peer, Data: data}})
		if err != nil {
			return nil, err
		}
		if len(encoded) > ipc.MaxFrameBytes {
			return searchRefusal(&body, "output_bound", "transport"), nil
		}
		return &Outcome{Status: "ok", Data: data}, nil
	}}
}

func searchFailure(request *wire.ComputerSearchRequest, err error) (*Outcome, error) {
	var failure *workspacect.Failure
	if errors.As(err, &failure) && failure.Retry == "never" {
		out := searchRefusal(request, failure.Code, failure.Source)
		if wire.Validate("ComputerSearchRefusal", out.Data) == nil {
			return out, nil
		}
	}
	return nil, err
}

func searchRefusal(request *wire.ComputerSearchRequest, code, source string) *Outcome {
	data, _ := json.Marshal(wire.ComputerSearchRefusal{Request: request, Code: code, Source: source, Retry: "never"})
	return &Outcome{Status: "refused", Code: code, Data: data}
}

// This validates response shape only. The owning service has already checked
// the exact selected root, exclusions and final authority before disclosure.
func validSearchResultPath(value, selected string) bool {
	if !utf8.ValidString(value) || len(value) == 0 || len(value) > 4096 || strings.Contains(value, "\\") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	for _, r := range value {
		if r < 32 || r == 127 {
			return false
		}
	}
	return selected == "." || value == selected || strings.HasPrefix(value, selected+"/")
}

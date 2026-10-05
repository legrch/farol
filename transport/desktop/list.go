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

// ListFactory selects the existing owner and one execution lease after parsing.
// Request correlation cannot mint authority or select another physical root.
type ListFactory func(context.Context, workspacect.ListRequest) (*workspacect.Contract, error)

func ListMethod(resolve ListFactory, peer wire.Context) Method {
	return Method{Handle: func(ctx context.Context, request Request) (*Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerListRequest", request.Body) != nil {
			return listRefusal(nil, "invalid_list_request", "transport"), nil
		}
		var body wire.ComputerListRequest
		if err := json.Unmarshal(request.Body, &body); err != nil {
			return nil, err
		}
		if ctx.Err() != nil {
			return listRefusal(&body, "WORKSPACE_REQUEST_CANCELLED", "native-workspace"), nil
		}
		if resolve == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		epoch, _ := strconv.ParseUint(body.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(body.Generation, 10, 64)
		input := workspacect.ListRequest{OwnerID: body.OwnerId, SessionID: body.SessionId, TaskID: body.TaskId, TaskEpoch: epoch, ParticipantID: body.ParticipantId, TurnID: body.TurnId, Generation: generation, CallID: body.CallId, WorkspaceID: body.WorkspaceId, RelativePath: body.RelativePath}
		contract, err := resolve(ctx, input)
		if err != nil {
			return listFailure(&body, err)
		}
		if contract == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		out, err := contract.List(ctx, input)
		if err != nil {
			return listFailure(&body, err)
		}
		if out == nil || out.OwnerID != input.OwnerID || out.SessionID != input.SessionID || out.TaskID != input.TaskID || out.TaskEpoch != input.TaskEpoch || out.ParticipantID != input.ParticipantID || out.TurnID != input.TurnID || out.Generation != input.Generation || out.CallID != input.CallID || out.WorkspaceID != input.WorkspaceID || out.RelativePath != input.RelativePath {
			return nil, errors.New("crossed Computer list result")
		}
		if len(out.Entries) > 500 {
			return nil, errors.New("invalid Computer list result")
		}
		entries := make([]string, 0, len(out.Entries))
		seen := make(map[string]bool, len(out.Entries))
		for _, entry := range out.Entries {
			name := strings.TrimSuffix(entry, "/")
			if !utf8.ValidString(name) || len(name) == 0 || len(name) > 255 || name == "." || name == ".." || strings.ContainsAny(name, "/\\") || seen[name] {
				return nil, errors.New("invalid Computer list entry")
			}
			for _, r := range name {
				if r < 32 || r == 127 {
					return nil, errors.New("invalid Computer list entry")
				}
			}
			seen[name] = true
			entries = append(entries, entry)
		}
		encodedEntries, err := json.Marshal(entries)
		if err != nil {
			return nil, err
		}
		result := wire.ComputerListResponse{OwnerId: out.OwnerID, SessionId: out.SessionID, TaskId: out.TaskID, TaskEpoch: strconv.FormatUint(out.TaskEpoch, 10), ParticipantId: out.ParticipantID, TurnId: out.TurnID, Generation: strconv.FormatUint(out.Generation, 10), CallId: out.CallID, WorkspaceId: out.WorkspaceID, RelativePath: out.RelativePath, Entries: encodedEntries, Truncated: out.Truncated}
		data, err := json.Marshal(result)
		if err != nil || wire.Validate("ComputerListResponse", data) != nil {
			return nil, errors.New("invalid Computer list result")
		}
		encoded, err := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: request.RequestID, Context: peer, Data: data}})
		if err != nil {
			return nil, err
		}
		if len(encoded) > ipc.MaxFrameBytes {
			return listRefusal(&body, "output_bound", "transport"), nil
		}
		return &Outcome{Status: "ok", Data: data}, nil
	}}
}

func listFailure(request *wire.ComputerListRequest, err error) (*Outcome, error) {
	var failure *workspacect.Failure
	if errors.As(err, &failure) && failure.Retry == "never" {
		out := listRefusal(request, failure.Code, failure.Source)
		if wire.Validate("ComputerListRefusal", out.Data) == nil {
			return out, nil
		}
	}
	return nil, err
}

func listRefusal(request *wire.ComputerListRequest, code, source string) *Outcome {
	data, _ := json.Marshal(wire.ComputerListRefusal{Request: request, Code: code, Source: source, Retry: "never"})
	return &Outcome{Status: "refused", Code: code, Data: data}
}

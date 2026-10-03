package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/pkg/ipc"
)

// ReadMethod maps the generated wire into Computer's independent final contract.
// peer must be the same trusted incarnation used to construct the Server.
// It carries correlation only; no root, grant or home is admitted on this wire.
func ReadMethod(contract *workspacect.Contract, peer wire.Context) Method {
	return Method{Handle: func(ctx context.Context, request Request) (*Outcome, error) {
		if ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerReadRequest", request.Body) != nil {
			return readRefusal(nil, "invalid_read_request", "transport"), nil
		}
		var body wire.ComputerReadRequest
		if err := json.Unmarshal(request.Body, &body); err != nil {
			return nil, err
		}
		if contract == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		// Parsing cannot fail after canonical uint64 schema validation.
		epoch, _ := strconv.ParseUint(body.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(body.Generation, 10, 64)
		input := workspacect.ReadRequest{OwnerID: body.OwnerId, SessionID: body.SessionId, TaskID: body.TaskId, TaskEpoch: epoch, ParticipantID: body.ParticipantId, TurnID: body.TurnId, Generation: generation, CallID: body.CallId, WorkspaceID: body.WorkspaceId, RelativePath: body.RelativePath}
		if body.Range != nil {
			offset, _ := strconv.ParseUint(body.Range.Offset, 10, 64)
			input.Range = &workspacect.Range{Offset: offset, Length: body.Range.Length}
		}
		output, err := contract.Read(ctx, input)
		if err != nil {
			var failure *workspacect.Failure
			if errors.As(err, &failure) && failure.Retry == "never" {
				refused := readRefusal(&body, failure.Code, failure.Source)
				if wire.Validate("ComputerReadRefusal", refused.Data) == nil {
					return refused, nil
				}
			}
			return readRefusal(&body, "WORKSPACE_HELPER_FAILED", "contract"), nil
		}
		if output == nil {
			return nil, errors.New("missing Computer result")
		}
		// A mismatched owner result is unknown, never disclosed as success.
		if output.OwnerID != input.OwnerID || output.SessionID != input.SessionID || output.TaskID != input.TaskID || output.TaskEpoch != input.TaskEpoch || output.ParticipantID != input.ParticipantID || output.TurnID != input.TurnID || output.Generation != input.Generation || output.CallID != input.CallID || output.WorkspaceID != input.WorkspaceID || output.RelativePath != input.RelativePath {
			return nil, errors.New("crossed Computer result")
		}
		result := wire.ComputerReadResponse{OwnerId: output.OwnerID, SessionId: output.SessionID, TaskId: output.TaskID, TaskEpoch: strconv.FormatUint(output.TaskEpoch, 10), ParticipantId: output.ParticipantID, TurnId: output.TurnID, Generation: strconv.FormatUint(output.Generation, 10), CallId: output.CallID, WorkspaceId: output.WorkspaceID, RelativePath: output.RelativePath, Text: output.Text, Bytes: strconv.FormatUint(output.Bytes, 10), Sha256: output.SHA256}
		if output.Page != nil {
			result.Page = &wire.ComputerReadPage{Offset: strconv.FormatUint(output.Page.Offset, 10), Size: strconv.FormatUint(output.Page.Size, 10)}
			if output.Page.NextOffset != nil {
				next := strconv.FormatUint(*output.Page.NextOffset, 10)
				result.Page.NextOffset = &next
			}
		}
		data, err := json.Marshal(result)
		if err != nil {
			return nil, err
		}
		// The exact JSON response (including HTML/control escaping and envelope) is
		// bounded BEFORE Serve writes a frame. Native byte bounds alone do not suffice.
		encoded, err := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: request.RequestID, Context: peer, Data: data}})
		if err != nil {
			return nil, err
		}
		if len(encoded) > ipc.MaxFrameBytes {
			return readRefusal(&body, "output_bound", "transport"), nil
		}
		if wire.Validate("ComputerReadResponse", data) != nil {
			return nil, errors.New("invalid Computer result")
		}
		return &Outcome{Status: "ok", Data: data}, nil
	}}
}

func readRefusal(request *wire.ComputerReadRequest, code, source string) *Outcome {
	data, _ := json.Marshal(wire.ComputerReadRefusal{Request: request, Code: code, Source: source, Retry: "never"})
	return &Outcome{Status: "refused", Code: code, Data: data}
}

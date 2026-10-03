package desktop

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"unicode/utf8"

	wire "github.com/legrch/farol/gen/desktop/v1"
	workspacect "github.com/legrch/farol/modules/computer/contracts/workspace"
	"github.com/legrch/farol/pkg/ipc"
)

// Factories are consumer-owned per-operation selectors, called once after
// canonical parsing. They must supply an already trusted Contract whose service
// holds one immutable execution lease for every phase. Correlation is not proof
// of admission. This adapter neither creates, renews nor caches that lease.
type CatalogueFactory func(context.Context, workspacect.CatalogueRequest) (*workspacect.Contract, error)
type BootstrapFactory func(context.Context, workspacect.BootstrapRequest) (*workspacect.Contract, error)

// CatalogueMethod is inert until explicitly registered by trusted composition.
// peer must equal the owning Server's trusted incarnation.
func CatalogueMethod(factory CatalogueFactory, peer wire.Context) Method {
	return Method{Handle: func(ctx context.Context, request Request) (*Outcome, error) {
		if ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerCatalogueRequest", request.Body) != nil {
			return catalogueRefusal(nil, "invalid_catalogue_request", "transport"), nil
		}
		var body wire.ComputerCatalogueRequest
		if err := json.Unmarshal(request.Body, &body); err != nil {
			return nil, err
		}
		if err := discoveryEnvelope(request, peer); err != nil {
			return nil, err
		}
		refuse := func(code, source string) *Outcome { return catalogueRefusal(&body, code, source) }
		if ctx.Err() != nil {
			return refuse("WORKSPACE_REQUEST_CANCELLED", "transport"), nil
		}
		if factory == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		epoch, _ := strconv.ParseUint(body.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(body.Generation, 10, 64)
		input := workspacect.CatalogueRequest{OwnerID: body.OwnerId, SessionID: body.SessionId, TaskID: body.TaskId, TaskEpoch: epoch, ParticipantID: body.ParticipantId, TurnID: body.TurnId, Generation: generation, CallID: body.CallId}
		contract, err := factory(ctx, input)
		if err != nil {
			return discoveryFailure(err, "ComputerCatalogueRefusal", refuse)
		}
		if ctx.Err() != nil {
			return refuse("WORKSPACE_REQUEST_CANCELLED", "transport"), nil
		}
		if contract == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		output, err := contract.Catalogue(ctx, input)
		if err != nil {
			return discoveryFailure(err, "ComputerCatalogueRefusal", refuse)
		}
		result, err := catalogueResult(input, output)
		if err != nil {
			return nil, err
		}
		return discoveryResult("ComputerCatalogueResponse", result, request, peer, refuse)
	}}
}

// BootstrapMethod selects the same trusted Contract once for the entire
// composite operation. Instruction text cannot select a contract or grant access.
func BootstrapMethod(factory BootstrapFactory, peer wire.Context) Method {
	return Method{Handle: func(ctx context.Context, request Request) (*Outcome, error) {
		if ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerBootstrapRequest", request.Body) != nil {
			return bootstrapRefusal(nil, "invalid_bootstrap_request", "transport"), nil
		}
		var body wire.ComputerBootstrapRequest
		if err := json.Unmarshal(request.Body, &body); err != nil {
			return nil, err
		}
		if err := discoveryEnvelope(request, peer); err != nil {
			return nil, err
		}
		refuse := func(code, source string) *Outcome { return bootstrapRefusal(&body, code, source) }
		if ctx.Err() != nil {
			return refuse("WORKSPACE_REQUEST_CANCELLED", "transport"), nil
		}
		if factory == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		epoch, _ := strconv.ParseUint(body.TaskEpoch, 10, 64)
		generation, _ := strconv.ParseUint(body.Generation, 10, 64)
		input := workspacect.BootstrapRequest{OwnerID: body.OwnerId, SessionID: body.SessionId, TaskID: body.TaskId, TaskEpoch: epoch, ParticipantID: body.ParticipantId, TurnID: body.TurnId, Generation: generation, CallID: body.CallId, WorkspaceID: body.WorkspaceId, RelativeDirectory: body.RelativeDirectory}
		contract, err := factory(ctx, input)
		if err != nil {
			return discoveryFailure(err, "ComputerBootstrapRefusal", refuse)
		}
		if ctx.Err() != nil {
			return refuse("WORKSPACE_REQUEST_CANCELLED", "transport"), nil
		}
		if contract == nil {
			return &Outcome{Status: "unavailable", Code: "capability_unavailable"}, nil
		}
		output, err := contract.Bootstrap(ctx, input)
		if err != nil {
			return discoveryFailure(err, "ComputerBootstrapRefusal", refuse)
		}
		result, err := bootstrapResult(input, output)
		if err != nil {
			return nil, err
		}
		return discoveryResult("ComputerBootstrapResponse", result, request, peer, refuse)
	}}
}

func discoveryEnvelope(request Request, peer wire.Context) error {
	if request.OperationID != "" || validate("id", request.RequestID) != nil || validate("Context", peer) != nil {
		return errors.New("invalid discovery envelope")
	}
	return nil
}

// Only a typed, canonical, nonretryable refusal establishes a known failure.
// Unknown/unclassified factory errors propagate unchanged to Server's unknown
// outcome; neither selection nor the Computer operation is replayed.
func discoveryFailure(err error, name string, refuse func(string, string) *Outcome) (*Outcome, error) {
	var failure *workspacect.Failure
	if errors.As(err, &failure) && failure != nil && failure.Retry == "never" {
		out := refuse(failure.Code, failure.Source)
		if wire.Validate(name, out.Data) == nil {
			return out, nil
		}
	}
	return nil, err
}

func catalogueRefusal(request *wire.ComputerCatalogueRequest, code, source string) *Outcome {
	data, _ := json.Marshal(wire.ComputerCatalogueRefusal{Request: request, Code: code, Source: source, Retry: "never"})
	return &Outcome{Status: "refused", Code: code, Data: data}
}
func bootstrapRefusal(request *wire.ComputerBootstrapRequest, code, source string) *Outcome {
	data, _ := json.Marshal(wire.ComputerBootstrapRefusal{Request: request, Code: code, Source: source, Retry: "never"})
	return &Outcome{Status: "refused", Code: code, Data: data}
}

func catalogueResult(input workspacect.CatalogueRequest, output *workspacect.CatalogueResponse) (*wire.ComputerCatalogueResponse, error) {
	if output == nil || output.OwnerID != input.OwnerID || output.SessionID != input.SessionID || output.TaskID != input.TaskID || output.TaskEpoch != input.TaskEpoch || output.ParticipantID != input.ParticipantID || output.TurnID != input.TurnID || output.Generation != input.Generation || output.CallID != input.CallID || len(output.Workspaces) > 32 || !discoveryStrings(output.Consistency, output.Next) {
		return nil, errors.New("invalid Computer catalogue correlation or collection")
	}
	entries := make([]wire.ComputerCatalogueEntry, 0, len(output.Workspaces))
	for _, entry := range output.Workspaces {
		if !discoveryStrings(entry.Root, entry.ApprovedRoot.Path, entry.ApprovedRoot.Device, entry.ApprovedRoot.Inode) {
			return nil, errors.New("invalid Computer catalogue strings")
		}
		mapped := wire.ComputerCatalogueEntry{WorkspaceId: entry.WorkspaceID, Root: entry.Root, ApprovedRoot: discoveryRoot(entry.ApprovedRoot)}
		if validate("ComputerCatalogueEntry", mapped) != nil {
			return nil, errors.New("invalid Computer catalogue entry")
		}
		entries = append(entries, mapped)
	}
	data, err := json.Marshal(entries)
	if err != nil {
		return nil, err
	}
	return &wire.ComputerCatalogueResponse{OwnerId: output.OwnerID, SessionId: output.SessionID, TaskId: output.TaskID, TaskEpoch: strconv.FormatUint(output.TaskEpoch, 10), ParticipantId: output.ParticipantID, TurnId: output.TurnID, Generation: strconv.FormatUint(output.Generation, 10), CallId: output.CallID, Workspaces: data, Consistency: output.Consistency, Next: output.Next}, nil
}

func bootstrapResult(input workspacect.BootstrapRequest, output *workspacect.BootstrapResponse) (*wire.ComputerBootstrapResponse, error) {
	if output == nil || output.OwnerID != input.OwnerID || output.SessionID != input.SessionID || output.TaskID != input.TaskID || output.TaskEpoch != input.TaskEpoch || output.ParticipantID != input.ParticipantID || output.TurnID != input.TurnID || output.Generation != input.Generation || output.CallID != input.CallID || output.WorkspaceID != input.WorkspaceID || output.RelativeDirectory != input.RelativeDirectory || len(output.Instructions) > 33 || !discoveryStrings(output.Root, output.ApprovedRoot.Path, output.ApprovedRoot.Device, output.ApprovedRoot.Inode, output.Scope, output.Coverage, output.Consistency, output.Precedence) {
		return nil, errors.New("invalid Computer bootstrap correlation or collection")
	}
	// farol-wire/2 has no typed arrays or boolean primitive. Map each closed
	// variant into its canonical DTO before embedding the bounded JSON array;
	// complete comes only from the owning boolean, never opaque input JSON.
	instructions := make([]json.RawMessage, 0, len(output.Instructions))
	for _, instruction := range output.Instructions {
		mapped, err := discoveryInstruction(instruction)
		if err != nil {
			return nil, err
		}
		instructions = append(instructions, mapped)
	}
	data, err := json.Marshal(instructions)
	if err != nil {
		return nil, err
	}
	complete, _ := json.Marshal(output.Complete)
	return &wire.ComputerBootstrapResponse{OwnerId: output.OwnerID, SessionId: output.SessionID, TaskId: output.TaskID, TaskEpoch: strconv.FormatUint(output.TaskEpoch, 10), ParticipantId: output.ParticipantID, TurnId: output.TurnID, Generation: strconv.FormatUint(output.Generation, 10), CallId: output.CallID, WorkspaceId: output.WorkspaceID, RelativeDirectory: output.RelativeDirectory, Root: output.Root, ApprovedRoot: discoveryRoot(output.ApprovedRoot), Scope: output.Scope, Complete: complete, Instructions: data, Coverage: output.Coverage, Consistency: output.Consistency, Precedence: output.Precedence}, nil
}
func discoveryRoot(root workspacect.Root) wire.ComputerApprovedRoot {
	return wire.ComputerApprovedRoot{Path: root.Path, Device: root.Device, Inode: root.Inode}
}
func discoveryInstruction(instruction workspacect.Instruction) (json.RawMessage, error) {
	var name string
	var value any
	switch entry := instruction.(type) {
	case workspacect.ReadInstruction:
		if !discoveryStrings(entry.RelativePath, entry.Text) {
			return nil, errors.New("invalid Computer read instruction strings")
		}
		name, value = "ComputerInstructionRead", wire.ComputerInstructionRead{Status: "read", RelativePath: entry.RelativePath, Text: entry.Text, Bytes: strconv.FormatUint(entry.Bytes, 10)}
	case workspacect.MissingInstruction:
		if !discoveryStrings(entry.RelativePath) {
			return nil, errors.New("invalid Computer missing instruction path")
		}
		name, value = "ComputerInstructionMissing", wire.ComputerInstructionMissing{Status: "not_found", RelativePath: entry.RelativePath}
	case workspacect.UnavailableInstruction:
		if !discoveryStrings(entry.RelativePath, entry.Code) {
			return nil, errors.New("invalid Computer unavailable instruction strings")
		}
		name, value = "ComputerInstructionUnavailable", wire.ComputerInstructionUnavailable{Status: "unavailable", RelativePath: entry.RelativePath, Code: entry.Code}
	default:
		return nil, errors.New("unclassified Computer instruction")
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err := wire.Validate(name, data); err != nil {
		return nil, err
	}
	return data, nil
}

func discoveryResult(name string, value any, request Request, peer wire.Context, refuse func(string, string) *Outcome) (*Outcome, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if wire.Validate(name, data) != nil {
		return nil, errors.New("invalid Computer discovery result")
	}
	// Measure the COMPLETE encoded success, including escaping and the exact
	// envelope/context, before any frame. The unchanged ceiling is shared by IPC.
	encoded, err := json.Marshal(wire.Response{Jsonrpc: "2.0", Id: &request.RequestID, Result: &wire.Outcome{Status: "ok", RequestId: request.RequestID, Context: peer, Data: data}})
	if err != nil {
		return nil, err
	}
	if len(encoded) > ipc.MaxFrameBytes {
		return refuse("output_bound", "transport"), nil
	}
	return &Outcome{Status: "ok", Data: data}, nil
}

// Reject invalid UTF-8 before encoding/json can silently substitute U+FFFD.
func discoveryStrings(values ...string) bool {
	for _, value := range values {
		if !utf8.ValidString(value) {
			return false
		}
	}
	return true
}

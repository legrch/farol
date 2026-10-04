package boot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"

	wire "github.com/legrch/farol/gen/desktop/v1"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	mutationrepo "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"github.com/legrch/farol/transport/desktop"
)

// NewChatComputerMutationIngress binds already qualified concrete owners. It
// does not open/create storage, migrate an old TS writer, or add write approval.
// Runtime activation requires the exclusive handoff independently of this join.
func NewChatComputerMutationIngress(chat *ChatIngress, computer *ComputerIngress, journal *mutationrepo.Repository, native *filesystem.Mutable) (*ChatComputerIngress, error) {
	if journal == nil || native == nil {
		return nil, computerUnavailable()
	}
	return chatComputerMutationIngress(chat, computer, computerMutationDependencies{repository: journal, native: native, digester: filesystem.Digester{}})
}

func chatComputerMutationIngress(chat *ChatIngress, computer *ComputerIngress, dependencies computerMutationDependencies) (*ChatComputerIngress, error) {
	if dependencies.repository == nil || dependencies.native == nil || dependencies.digester == nil {
		return nil, computerUnavailable()
	}
	joined, err := NewChatComputerIngress(chat, computer)
	if err != nil {
		return nil, err
	}
	joined.mutations = dependencies
	return joined, nil
}

func mutationWireResult(operation *computerMutationOperation, output *mutationct.ExecuteResponse) (*wire.ComputerMutationResponse, error) {
	invalid := func() (*wire.ComputerMutationResponse, error) {
		return nil, errors.New("chat_computer_mutation_result_crossed")
	}
	if operation == nil || output == nil {
		return invalid()
	}
	in := operation.request
	if output.OperationID != in.OperationID || output.WorkspaceID != in.WorkspaceID || output.CallID != in.CallID || output.TurnID != in.TurnID || output.Generation != in.Generation {
		return invalid()
	}
	result := &wire.ComputerMutationResponse{OperationId: output.OperationID, WorkspaceId: output.WorkspaceID, CallId: output.CallID, TurnId: output.TurnID, Generation: decimal(output.Generation), Phase: output.Phase, Publication: output.Publication}
	switch output.Phase {
	case "completed":
		if output.Receipt == nil || output.Failure != nil {
			return invalid()
		}
		receipt := output.Receipt
		var kind, path string
		var before *string
		switch input := in.Operation.(type) {
		case mutationct.Write:
			kind, path, before = "write", input.RelativePath, input.ExpectedSHA256
			if receipt.Replacements != 0 {
				return invalid()
			}
		case mutationct.Edit:
			kind, path, before = "edit", input.RelativePath, &input.ExpectedSHA256
			if receipt.Replacements < 1 {
				return invalid()
			}
		default:
			return invalid()
		}
		if receipt.Operation != kind || receipt.RelativePath != path || receipt.Bytes > 8*1024*1024 || receipt.Replacements > 256 || (before == nil) != (receipt.BeforeSHA256 == nil) || before != nil && *before != *receipt.BeforeSHA256 {
			return invalid()
		}
		result.Receipt = &wire.ComputerMutationReceipt{Operation: receipt.Operation, RelativePath: receipt.RelativePath, Bytes: decimal(receipt.Bytes), Replacements: receipt.Replacements, AfterSHA256: receipt.AfterSHA256}
		if receipt.BeforeSHA256 != nil {
			value := *receipt.BeforeSHA256
			result.Receipt.BeforeSHA256 = &value
		}
	case "failed", "outcome_unknown":
		if output.Receipt != nil || output.Failure == nil || output.Failure.Retry != "never" {
			return invalid()
		}
		if (output.Phase == "outcome_unknown") != (output.Failure.Code == "WORKSPACE_MUTATION_OUTCOME_UNKNOWN") {
			return invalid()
		}
		result.Failure = &wire.ComputerMutationFailure{Code: output.Failure.Code, Source: output.Failure.Source, Retry: output.Failure.Retry}
	default:
		return invalid()
	}
	raw, err := json.Marshal(result)
	if err != nil || wire.Validate("ComputerMutationResponse", raw) != nil || len(raw) > 64*1024 {
		return invalid()
	}
	return result, nil
}

func (s *ChatComputerIngress) mutate(ctx context.Context, operation string, input wire.ChatComputerRead, action mutationct.Operation) (*wire.ChatComputerOutput, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || !validIngressID(operation) || validateIngress("ChatComputerRead", input) != nil || s.mutations.repository == nil || s.mutations.native == nil || s.mutations.digester == nil {
		return nil, mutationInvalid()
	}
	h, err := s.chat.get(input.HandleId)
	if err != nil {
		return nil, err
	}
	correlation, err := h.handle.ComputerContext(ctx)
	if err != nil {
		return nil, err
	}
	id, err := randomIngressID()
	if err != nil {
		return nil, err
	}
	key := chatComputerKey{input.HandleId, input.CallId}
	record := &chatComputerReturn{}
	s.mu.Lock()
	if _, exists := s.calls[key]; exists || len(s.calls) >= 1024 {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	turn := s.turns[h.handle]
	if turn != nil && (turn.binding != h.binding || turn.last == nil || !turn.last.settled) {
		s.mu.Unlock()
		return nil, computerUnavailable()
	}
	if turn == nil {
		turn = &chatComputerTurn{binding: h.binding}
		s.turns[h.handle] = turn
	}
	s.calls[key], turn.last = record, record
	selected := turn.route
	s.mu.Unlock()
	joined, err := s.computer.mutateConversationOnRoute(ctx, h.handle, *correlation, operation, input.CallId, input.WorkspaceId, action, s.mutations, selected)
	// Retain partial/uncertain operations for observation only. A failed result
	// never gets a fabricated relay receipt or a replacement execution owner.
	s.mu.Lock()
	if joined != nil {
		record.mutation, record.call, turn.route = joined.operation, joined.call, joined.route
	}
	record.correlation = *correlation
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	if joined == nil || joined.call == nil || ctx.Err() != nil {
		return nil, errors.New("chat_computer_mutation_result_unknown")
	}
	result, err := mutationWireResult(joined.operation, joined.response)
	if err != nil {
		return nil, err
	}
	// A known in-memory result is useful evidence, not a durable settled chain.
	// Publication-unknown/Prepared/native-unknown stays closed without an ACK.
	if result.Publication != "durable" || result.Phase == "outcome_unknown" {
		return nil, errors.New("chat_computer_mutation_result_unsettled")
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(raw)
	receipt := wire.ChatComputerReceipt{ReceiptId: id, HandleId: input.HandleId, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, OutputSHA256: hex.EncodeToString(digest[:]), OutputBytes: decimal(uint64(len(raw)))}
	if validateIngress("ChatComputerReceipt", receipt) != nil {
		return nil, errors.New("chat_computer_receipt_invalid")
	}
	s.mu.Lock()
	record.receipt = receipt
	s.mu.Unlock()
	return &wire.ChatComputerOutput{Receipt: receipt, Output: string(raw)}, nil
}

func (s *ChatComputerIngress) observeMutation(ctx context.Context, input wire.ChatComputerMutationRead) (*wire.ChatComputerMutationObservation, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || validateIngress("ChatComputerMutationRead", input) != nil {
		return nil, mutationInvalid()
	}
	h, err := s.chat.get(input.HandleId)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	record := s.calls[chatComputerKey{input.HandleId, input.CallId}]
	var operation *computerMutationOperation
	if record != nil && record.correlation.Binding == h.binding {
		operation = record.mutation
	}
	s.mu.Unlock()
	if operation == nil {
		return nil, computerUnavailable()
	}
	output, err := operation.read(ctx)
	if err != nil {
		return nil, err
	}
	result, err := mutationWireResult(operation, output)
	if err != nil {
		return nil, err
	}
	return &wire.ChatComputerMutationObservation{HandleId: input.HandleId, CallId: input.CallId, Result: *result}, nil
}

func (s *ChatComputerIngress) mutationMethods() map[string]desktop.Method {
	return map[string]desktop.Method{
		"chat.computer.write": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var input wire.ChatComputerWrite
			if r.OperationID == "" || chatDecode("ChatComputerWrite", r, &input) != nil {
				return invalidIngress()
			}
			selected := wire.ChatComputerRead{HandleId: input.HandleId, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, WorkspaceId: input.WorkspaceId, RelativePath: input.RelativePath}
			output, err := s.mutate(ctx, r.OperationID, selected, mutationct.Write{RelativePath: input.RelativePath, Content: input.Content, ExpectedSHA256: input.ExpectedSHA256})
			if err != nil {
				return nil, err
			}
			return chatOutcome("ChatComputerOutput", output, nil)
		}},
		"chat.computer.edit": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var input wire.ChatComputerEdit
			if r.OperationID == "" || chatDecode("ChatComputerEdit", r, &input) != nil {
				return invalidIngress()
			}
			edits := make([]mutationct.TextEdit, len(input.Edits))
			for i, edit := range input.Edits {
				edits[i] = mutationct.TextEdit{OldText: edit.OldText, NewText: edit.NewText}
			}
			selected := wire.ChatComputerRead{HandleId: input.HandleId, CallId: input.CallId, RelayBinding: input.RelayBinding, RequestSHA256: input.RequestSHA256, WorkspaceId: input.WorkspaceId, RelativePath: input.RelativePath}
			output, err := s.mutate(ctx, r.OperationID, selected, mutationct.Edit{RelativePath: input.RelativePath, Edits: edits, ExpectedSHA256: input.ExpectedSHA256})
			if err != nil {
				return nil, err
			}
			return chatOutcome("ChatComputerOutput", output, nil)
		}},
		"chat.computer.mutation.read": {Handle: func(ctx context.Context, r desktop.Request) (*desktop.Outcome, error) {
			var input wire.ChatComputerMutationRead
			if r.OperationID != "" || chatDecode("ChatComputerMutationRead", r, &input) != nil {
				return invalidIngress()
			}
			output, err := s.observeMutation(ctx, input)
			if err != nil {
				return nil, err
			}
			return chatOutcome("ChatComputerMutationObservation", output, nil)
		}},
	}
}

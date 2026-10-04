package boot

import (
	"context"
	"encoding/json"
	"slices"
	"sync"

	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	computerport "github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type computerConversationIntent uint8

const (
	computerReadIntent computerConversationIntent = iota + 1
	computerWriteIntent
)

func conversationIntentPolicy(approval authority.Approval, ids []string, intent computerConversationIntent) (authority.Policy, authority.Ownership, error) {
	policy, err := readIntentPolicy(approval, ids)
	if err != nil {
		return authority.Policy{}, authority.NoOwnership, err
	}
	if intent == computerReadIntent {
		return policy, authority.NoOwnership, nil
	}
	if intent != computerWriteIntent || !slices.Contains(approval.Capabilities, authority.Write) {
		return authority.Policy{}, authority.NoOwnership, computerUnavailable()
	}
	for i, scope := range policy.Workspaces {
		approved, ok := authority.FindApproved(approval, scope.WorkspaceID)
		if !ok || approved.Access != authority.WriteAccess {
			return authority.Policy{}, authority.NoOwnership, computerUnavailable()
		}
		policy.Workspaces[i].Access = authority.WriteAccess
	}
	policy.Capabilities = append(policy.Capabilities, authority.Write)
	return policy, authority.TaskOwnership, nil
}

// These are existing Computer ports selected by trusted Root. Neither a relay
// request nor a Task process reservation can select the mutation journal/adapter.
// Production qualification remains the concrete runtime composition's duty.
type computerMutationDependencies struct {
	repository computerport.MutationRepository
	native     computerport.MutableWorkspace
	digester   computerport.MutationDigester
}

// One operation retains its original lease, copied request and service. Observing
// a pending or memory-only result never constructs a replacement execution lease.
type computerMutationOperation struct {
	mu        sync.Mutex
	attempted bool
	contract  *mutationct.Contract
	request   mutationct.ExecuteRequest
}

func mutationInputCopy(input mutationct.Operation) mutationct.Operation {
	switch value := input.(type) {
	case mutationct.Write:
		if value.ExpectedSHA256 != nil {
			hash := *value.ExpectedSHA256
			value.ExpectedSHA256 = &hash
		}
		return value
	case mutationct.Edit:
		value.Edits = slices.Clone(value.Edits)
		return value
	default:
		return nil
	}
}

func mutationInvalid() error {
	return &mutationct.Failure{Code: "COMPUTER_INVALID_REQUEST", Source: "contract", Retry: "never"}
}

func (r *ComputerRoute) selectMutation(ctx context.Context, input mutationct.ExecuteRequest, dependencies computerMutationDependencies) (*computerMutationOperation, error) {
	if r == nil || r.issuer == nil || ctx == nil || ctx.Err() != nil || dependencies.repository == nil || dependencies.native == nil || dependencies.digester == nil {
		return nil, computerUnavailable()
	}
	input.Operation = mutationInputCopy(input.Operation)
	if _, err := mutationct.New(mutationsvc.New()).Check(ctx, input); err != nil {
		return nil, err
	}
	lease, err := r.issuer.Admit(ctx, authority.Write)
	if err != nil {
		return nil, computerFailure(err)
	}
	expected := operationBinding(input.OwnerID, input.SessionID, input.TaskID, input.TaskEpoch, input.ParticipantID, input.TurnID)
	if lease.Binding() != expected {
		return nil, &mutationct.Failure{Code: "AUTHORITY_TASK_MISMATCH", Source: "task-grant", Retry: "never"}
	}
	service, err := mutationsvc.NewForExecution(input.OperationID, lease, dependencies.repository, dependencies.native, dependencies.digester, &sync.Mutex{}, r.clock)
	if err != nil {
		return nil, computerFailure(err)
	}
	return &computerMutationOperation{contract: mutationct.New(service), request: input}, nil
}

func (o *computerMutationOperation) execute(ctx context.Context) (*mutationct.ExecuteResponse, error) {
	if o == nil || o.contract == nil || ctx == nil || ctx.Err() != nil {
		return nil, mutationInvalid()
	}
	o.mu.Lock()
	if o.attempted {
		o.mu.Unlock()
		return nil, &mutationct.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store", Retry: "never"}
	}
	o.attempted = true
	o.mu.Unlock()
	return o.contract.Execute(ctx, o.request)
}

func (o *computerMutationOperation) read(ctx context.Context) (*mutationct.ReadResponse, error) {
	if o == nil || o.contract == nil || ctx == nil || ctx.Err() != nil {
		return nil, mutationInvalid()
	}
	return o.contract.Read(ctx, o.request)
}

type chatComputerMutation struct {
	operation *computerMutationOperation
	call      *conversation.ComputerCall
	route     *ComputerRoute
	response  *mutationct.ExecuteResponse
}

// This is the internal Computer execution join, distinct from Responses tools
// executed by an external caller. Chat intent, Computer admission, native effect,
// terminal journal publication and the actual relay return are separate facts.
func (s *ComputerIngress) mutateConversationOnRoute(ctx context.Context, h *conversation.Handle, correlation conversation.ComputerContext, operation, callID, workspaceID string, input mutationct.Operation, dependencies computerMutationDependencies, route *ComputerRoute) (*chatComputerMutation, error) {
	if s == nil || ctx == nil || ctx.Err() != nil || h == nil || !validIngressID(operation) || !validIngressID(callID) || !validIngressID(workspaceID) || dependencies.repository == nil || dependencies.native == nil || dependencies.digester == nil {
		return nil, mutationInvalid()
	}
	b := correlation.Binding
	request := mutationct.ExecuteRequest{OperationID: operation, OwnerID: b.OwnerID, SessionID: b.SessionID, TaskID: b.TaskID, TaskEpoch: b.TaskEpoch, ParticipantID: b.ParticipantID, TurnID: b.TurnID, Generation: b.TurnGeneration, CallID: callID, WorkspaceID: workspaceID, Operation: mutationInputCopy(input)}
	if _, err := mutationct.New(mutationsvc.New()).Check(ctx, request); err != nil {
		return nil, err
	}
	// Reserve room for the framing envelope and relay correlation. Large native
	// payload support does not authorize chunking/retrying a framed mutation.
	raw, err := json.Marshal(request)
	if err != nil || len(raw) > 512*1024 {
		return nil, mutationInvalid()
	}
	current, err := h.Admission()
	if err != nil {
		return nil, err
	}
	if err = currentConversation(ctx, current, b); err != nil {
		return nil, err
	}
	call, err := h.BeginComputer(ctx, correlation, callID)
	if err != nil {
		return nil, err
	}
	joined := &chatComputerMutation{call: call, route: route}
	if route == nil {
		joined.route, err = s.bindConversationIntent(ctx, operation, b, current, []string{workspaceID}, computerWriteIntent)
	} else {
		err = s.claim(operation)
	}
	if err != nil {
		return joined, err
	}
	joined.operation, err = joined.route.selectMutation(ctx, request, dependencies)
	if err != nil {
		return joined, err
	}
	joined.response, err = joined.operation.execute(ctx)
	return joined, err
}

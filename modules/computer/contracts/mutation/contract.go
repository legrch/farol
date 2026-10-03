// Package mutation publishes an independent in-process request-check contract.
// This is not the mutable wire Execute endpoint or a positive admission proof.
package mutation

import (
	"context"
	"errors"

	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type Contract struct{ service *mutationsvc.Service }

func New(service *mutationsvc.Service) *Contract { return &Contract{service: service} }

type Operation interface{ operation() }
type Write struct {
	RelativePath, Content string
	ExpectedSHA256        *string
}
type TextEdit struct{ OldText, NewText string }
type Edit struct {
	RelativePath   string
	Edits          []TextEdit
	ExpectedSHA256 string
}

func (Write) operation() {}
func (Edit) operation()  {}

type CheckRequest struct {
	OperationID, OwnerID, SessionID, TaskID string
	TaskEpoch                               uint64
	ParticipantID, TurnID                   string
	Generation                              uint64
	CallID, WorkspaceID                     string
	Operation                               Operation
}
type Summary struct {
	Kind, RelativePath string
	ExpectedSHA256     *string
}
type CheckResponse struct {
	OperationID, OwnerID, SessionID, TaskID string
	TaskEpoch                               uint64
	ParticipantID, TurnID                   string
	Generation                              uint64
	CallID, WorkspaceID, RelativePath       string
	Operation                               Summary
}
type Failure struct{ Code, Source, Retry string }

func (f *Failure) Error() string { return f.Code + " (" + f.Source + ")" }
func cloneHash(v *string) *string {
	if v == nil {
		return nil
	}
	copy := *v
	return &copy
}
func (c *Contract) Check(ctx context.Context, r CheckRequest) (*CheckResponse, error) {
	app := mutationsvc.CheckRequest{OperationID: r.OperationID, OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID, WorkspaceID: r.WorkspaceID}
	switch v := r.Operation.(type) {
	case Write:
		app.Operation = mutationsvc.Write{RelativePath: v.RelativePath, Content: v.Content, ExpectedSHA256: cloneHash(v.ExpectedSHA256)}
	case Edit:
		edits := make([]mutationsvc.TextEdit, 0, len(v.Edits))
		for _, e := range v.Edits {
			edits = append(edits, mutationsvc.TextEdit{OldText: e.OldText, NewText: e.NewText})
		}
		app.Operation = mutationsvc.Edit{RelativePath: v.RelativePath, Edits: edits, ExpectedSHA256: v.ExpectedSHA256}
	}
	out, err := c.service.Check(ctx, app)
	if err != nil || out == nil {
		var f *authority.Failure
		if errors.As(err, &f) && f.Code == "COMPUTER_INVALID_REQUEST" && f.Source == "contract" {
			return nil, &Failure{Code: f.Code, Source: f.Source, Retry: "never"}
		}
		return nil, &Failure{Code: "COMPUTER_INVALID_REQUEST", Source: "contract", Retry: "never"}
	}
	return &CheckResponse{OperationID: out.OperationID, OwnerID: out.OwnerID, SessionID: out.SessionID, TaskID: out.TaskID, TaskEpoch: out.TaskEpoch, ParticipantID: out.ParticipantID, TurnID: out.TurnID, Generation: out.Generation, CallID: out.CallID, WorkspaceID: out.WorkspaceID, RelativePath: out.RelativePath, Operation: Summary{Kind: out.Operation.Kind, RelativePath: out.Operation.RelativePath, ExpectedSHA256: cloneHash(out.Operation.ExpectedSHA256)}}, nil
}

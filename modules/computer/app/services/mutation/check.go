package mutation

import (
	"context"
	"slices"

	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

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

func cloneHash(v *string) *string {
	if v == nil {
		return nil
	}
	copy := *v
	return &copy
}

// Check returns only a content-free correlation summary. It observes no Task,
// Computer, journal or filesystem and never admits or dispatches an operation.
func (s *Service) Check(_ context.Context, r CheckRequest) (*CheckResponse, error) {
	if !mutation.Identifier(r.OwnerID, 80) || r.TaskEpoch > mutation.MaxSafeInteger || r.Generation > mutation.MaxSafeInteger {
		return nil, authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
	}
	for _, id := range []string{r.OperationID, r.SessionID, r.TaskID, r.ParticipantID, r.TurnID, r.CallID, r.WorkspaceID} {
		if !mutation.Identifier(id, 160) {
			return nil, authority.Fail("COMPUTER_INVALID_REQUEST", "contract")
		}
	}
	var op mutation.Operation
	var summary Summary
	switch v := r.Operation.(type) {
	case Write:
		op = mutation.Write{RelativePath: v.RelativePath, Content: v.Content, ExpectedSHA256: cloneHash(v.ExpectedSHA256)}
		summary = Summary{Kind: "workspace.write", RelativePath: v.RelativePath, ExpectedSHA256: cloneHash(v.ExpectedSHA256)}
	case Edit:
		edits := make([]mutation.TextEdit, 0, len(v.Edits))
		for _, e := range slices.Clone(v.Edits) {
			edits = append(edits, mutation.TextEdit{OldText: e.OldText, NewText: e.NewText})
		}
		op = mutation.Edit{RelativePath: v.RelativePath, Edits: edits, ExpectedSHA256: v.ExpectedSHA256}
		hash := v.ExpectedSHA256
		summary = Summary{Kind: "workspace.edit", RelativePath: v.RelativePath, ExpectedSHA256: &hash}
	}
	if err := mutation.ValidateInput(op); err != nil {
		return nil, err
	}
	return &CheckResponse{OperationID: r.OperationID, OwnerID: r.OwnerID, SessionID: r.SessionID, TaskID: r.TaskID, TaskEpoch: r.TaskEpoch, ParticipantID: r.ParticipantID, TurnID: r.TurnID, Generation: r.Generation, CallID: r.CallID, WorkspaceID: r.WorkspaceID, RelativePath: summary.RelativePath, Operation: summary}, nil
}

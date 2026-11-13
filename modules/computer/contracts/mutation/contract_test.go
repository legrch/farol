package mutation

import (
	"context"
	"errors"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	"strings"
	"testing"
)

func fixture() CheckRequest {
	return CheckRequest{OperationID: "operation", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "main", TurnID: "turn", Generation: 3, CallID: "call", WorkspaceID: "work", Operation: Write{RelativePath: "README.md", Content: "new text payload"}}
}
func TestCheckOnlyReturnsIndependentContentFreeCorrelation(t *testing.T) {
	c := New(mutationsvc.New())
	r := fixture()
	hash := strings.Repeat("a", 64)
	r.Operation = Write{RelativePath: "README.md", Content: "new text payload", ExpectedSHA256: &hash}
	out, err := c.Check(context.Background(), r)
	if err != nil || out == nil {
		t.Fatal(err)
	}
	if out.OperationID != r.OperationID || out.OwnerID != r.OwnerID || out.SessionID != r.SessionID || out.TaskID != r.TaskID || out.TaskEpoch != r.TaskEpoch || out.ParticipantID != r.ParticipantID || out.TurnID != r.TurnID || out.Generation != r.Generation || out.CallID != r.CallID || out.WorkspaceID != r.WorkspaceID || out.RelativePath != "README.md" || out.Operation.Kind != "workspace.write" || *out.Operation.ExpectedSHA256 != hash {
		t.Fatal("lost correlation")
	}
	hash = strings.Repeat("b", 64)
	if *out.Operation.ExpectedSHA256 != strings.Repeat("a", 64) {
		t.Fatal("expected hash aliases request")
	}
	r = fixture()
	r.Operation = Edit{RelativePath: "README.md", ExpectedSHA256: strings.Repeat("c", 64), Edits: []TextEdit{{OldText: "old", NewText: "new"}}}
	out, err = c.Check(context.Background(), r)
	if err != nil || out == nil || out.Operation.Kind != "workspace.edit" || out.Operation.ExpectedSHA256 == nil {
		t.Fatal("edit mapping")
	}
}
func TestCheckPreservesHeaderBoundsAndRejectsInvalidShapes(t *testing.T) {
	for _, change := range []func(*CheckRequest){func(r *CheckRequest) { r.OperationID = "" }, func(r *CheckRequest) { r.OwnerID = strings.Repeat("x", 81) }, func(r *CheckRequest) { r.CallID = strings.Repeat("😀", 81) }, func(r *CheckRequest) { r.TaskEpoch = 9007199254740992 }, func(r *CheckRequest) { r.Generation = 9007199254740992 }, func(r *CheckRequest) { r.Operation = nil }, func(r *CheckRequest) { r.Operation = Write{RelativePath: "."} }, func(r *CheckRequest) { r.Operation = Edit{RelativePath: "a", ExpectedSHA256: strings.Repeat("a", 64)} }, func(r *CheckRequest) { r.Operation = Write{RelativePath: "a", Content: "\x00"} }} {
		r := fixture()
		change(&r)
		out, err := New(mutationsvc.New()).Check(context.Background(), r)
		var f *Failure
		if out != nil || !errors.As(err, &f) || f.Code != "COMPUTER_INVALID_REQUEST" || f.Source != "contract" || f.Retry != "never" {
			t.Fatalf("invalid request: %v", err)
		}
	}
	r := fixture()
	r.CallID = strings.Repeat("😀", 80)
	if out, err := New(mutationsvc.New()).Check(context.Background(), r); err != nil || out == nil {
		t.Fatal("160 UTF16 mutation header bound narrowed to readonly120")
	}
}
func TestCheckDoesNotSelectOrProveAnyCurrentAuthority(t *testing.T) {
	// There are intentionally no injected owners, native/journal or Execute.
	// A syntactically valid arbitrary identity is only a checked summary.
	r := fixture()
	r.OwnerID = "unadmitted-owner"
	r.TaskID = "unadmitted-task"
	out, err := New(mutationsvc.New()).Check(context.Background(), r)
	if err != nil || out == nil || out.OwnerID != r.OwnerID {
		t.Fatal("pure check incorrectly selected an owner")
	}
}

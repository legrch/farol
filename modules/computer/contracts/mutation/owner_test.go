package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	app "github.com/legrch/farol/modules/computer/app/services/mutation"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

type ownerApproval struct {
	a    authority.Approval
	fail error
}

func (s *ownerApproval) WithCurrent(_ context.Context, inspect func(*authority.Approval) error) error {
	if s.fail != nil {
		return s.fail
	}
	a := s.a.Clone()
	return inspect(&a)
}
func TestOwnerContractDelegatesExactEditAndObservesWithoutWriteLease(t *testing.T) {
	_, lease, store, native, task := contractFixture(t)
	a := lease.a.Clone()
	a.Network = authority.NoNetwork
	a.Commands = authority.NoCommands
	source := &ownerApproval{a: a}
	selection := app.OwnerSelection{OperationID: "owner-operation", OwnerID: a.OwnerID, ProfileID: "profile", ComputerID: a.ComputerID, ComputerGeneration: a.Generation}
	svc, err := app.NewForOwnerExecution(context.Background(), selection, source, store, native, contractDigest{}, &sync.Mutex{}, contractClock{time.Unix(1700000000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	c := NewOwnerExecution(svc)
	r := OwnerRequest{WorkspaceID: task.WorkspaceID, Operation: task.Operation}
	out, err := c.Execute(context.Background(), r)
	if err != nil || out.OperationID != selection.OperationID || out.ComputerGeneration != 7 || out.Phase != "completed" || out.Receipt.Replacements != 1 || store.record.Binding().Identity.TaskID != "" {
		t.Fatalf("%#v %v", out, err)
	}
	*out.Receipt.BeforeSHA256 = "caller changed"
	native.receipt.AfterSHA256 = "native changed"
	source.fail = errors.New("withdrawn approval")
	observer, err := app.NewOwnerObserver(selection, store)
	if err != nil {
		t.Fatal(err)
	}
	reader := NewOwnerObservation(observer)
	for _, contract := range []*OwnerContract{c, reader} {
		out, err = contract.Observe(context.Background(), OwnerObservation{"work", "note.md"})
		if err != nil || out.Phase != "completed" || *out.Receipt.BeforeSHA256 != strings.Repeat("b", 64) || out.Receipt.AfterSHA256 != strings.Repeat("c", 64) {
			t.Fatalf("retained copy %#v %v", out, err)
		}
	}
	if out, err = reader.Execute(context.Background(), r); err == nil || out != nil {
		t.Fatal("observer acquired execute")
	}
	if native.calls != 1 || store.admit != 1 || store.save != 1 {
		t.Fatal("contract repeated effect")
	}
}
func TestOwnerContractClosedFailureNeverReturnsDiagnostics(t *testing.T) {
	for _, err := range []error{errors.New("private detail"), authority.Fail("PRIVATE_ERROR", "authority-store"), authority.Fail("AUTHORITY_EXPIRED", "private-source"), authority.Fail("COMPUTER_APPROVAL_INVALID", "private-source")} {
		var f *Failure
		if !errors.As(ownerBoundary(err), &f) || f.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || f.Retry != "never" {
			t.Fatal("raw diagnostics escaped")
		}
	}
	for _, code := range []string{"COMPUTER_APPROVAL_INVALID", "COMPUTER_PATH_INVALID", "COMPUTER_APPROVAL_STORE_UNAVAILABLE", "AUTHORITY_EXPIRED", "AUTHORITY_COMPUTER_MISMATCH"} {
		var f *Failure
		if !errors.As(ownerBoundary(authority.Fail(code, "computer-approval")), &f) || f.Code != code || f.Retry != "never" {
			t.Fatal("classified refusal lost")
		}
	}
	for _, c := range []*OwnerContract{nil, NewOwnerExecution(nil), NewOwnerObservation(nil)} {
		if out, err := c.Execute(context.Background(), OwnerRequest{}); err == nil || out != nil {
			t.Fatal("nil execute accepted")
		}
		if out, err := c.Observe(context.Background(), OwnerObservation{}); err == nil || out != nil {
			t.Fatal("nil observe accepted")
		}
	}
}
func TestOwnerContractOperationMappingOwnsEditsAndHash(t *testing.T) {
	hash := strings.Repeat("a", 64)
	write := toAppOperation(Write{RelativePath: "a", Content: "body", ExpectedSHA256: &hash}).(app.Write)
	hash = "changed"
	if *write.ExpectedSHA256 != strings.Repeat("a", 64) {
		t.Fatal("hash aliases request")
	}
	edits := []TextEdit{{OldText: "before", NewText: "after"}}
	edit := toAppOperation(Edit{RelativePath: "a", Edits: edits, ExpectedSHA256: strings.Repeat("b", 64)}).(app.Edit)
	edits[0].OldText = "changed"
	if edit.Edits[0].OldText != "before" || toAppOperation(nil) != nil {
		t.Fatal("edit mapping escaped ownership")
	}
}

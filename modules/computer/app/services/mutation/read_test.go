package mutation

import (
	"context"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestMutationReadMissingAndPreparedNeverAdmit(t *testing.T) {
	f := newExecutionFixture(t)
	_, err := f.service.Read(context.Background(), f.request)
	requireCode(t, err, "COMPUTER_MUTATION_OPERATION_NOT_FOUND")
	prepared, err := mutation.NewPrepared(bindingFor(f.request, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
	if err != nil {
		t.Fatal(err)
	}
	f.store.record = prepared
	out, err := f.service.Read(context.Background(), f.request)
	if err != nil || out.Phase != "outcome_unknown" || f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
		t.Fatalf("%#v %v", out, err)
	}
}
func TestMutationReadRetainedResultUnderNewSelectedTurn(t *testing.T) {
	f := newExecutionFixture(t)
	_, err := f.service.Execute(context.Background(), f.request)
	if err != nil {
		t.Fatal(err)
	}
	f.lease.binding.TurnID = "new-turn"
	f.request.TurnID = "new-turn"
	f.request.CallID = "read-call"
	f.request.Generation = 100
	reader, err := NewForExecution("op", f.lease, f.store, f.native, testDigest{}, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	out, err := reader.Read(context.Background(), f.request)
	if err != nil || out.Phase != "completed" || out.TurnID != "new-turn" || out.Generation != 100 || f.native.calls != 1 || f.store.admissions != 1 || f.store.saves != 1 {
		t.Fatalf("%#v %v", out, err)
	}
	f.lease.a.Generation++
	out, err = reader.Read(context.Background(), f.request)
	if err == nil || out != nil {
		t.Fatal("disclosed after generation change")
	}
}

func TestMutationReadPreparedPeerCanLaterObserveTerminal(t *testing.T) {
	f := newExecutionFixture(t)
	prepared, err := mutation.NewPrepared(bindingFor(f.request, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
	if err != nil {
		t.Fatal(err)
	}
	f.store.record = prepared
	out, err := f.service.Execute(context.Background(), f.request)
	if err != nil || out.Phase != "outcome_unknown" {
		t.Fatalf("%#v %v", out, err)
	}
	terminal, err := prepared.Complete(mutation.Receipt{Operation: mutation.WriteKind, RelativePath: "note.md", Bytes: 3, AfterSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"})
	if err != nil {
		t.Fatal(err)
	}
	// Simulated first owner completion, not a retry/tombstone by this observer.
	f.store.record = terminal
	out, err = f.service.Read(context.Background(), f.request)
	if err != nil || out.Phase != "completed" || f.native.calls != 0 || f.store.saves != 0 || f.store.admissions != 1 {
		t.Fatalf("%#v %v", out, err)
	}
}

func TestMutationReadInvalidStoredStateIsUnavailable(t *testing.T) {
	f := newExecutionFixture(t)
	f.store.record = &mutation.State{}
	_, err := f.service.Read(context.Background(), f.request)
	requireCode(t, err, "COMPUTER_MUTATION_STORE_UNAVAILABLE")
	if f.store.admissions != 0 || f.store.saves != 0 || f.native.calls != 0 {
		t.Fatal("invalid state caused effect")
	}
}

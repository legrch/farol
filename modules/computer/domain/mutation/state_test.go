package mutation

import (
	"errors"
	"strings"
	"testing"
)

func binding() Binding {
	return Binding{Identity: Identity{OperationID: "operation", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 7, ParticipantID: "main"}, WorkspaceID: "work", RequestDigest: digest("a")}
}
func prepared(t *testing.T) *State {
	t.Helper()
	r, err := NewPrepared(binding())
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func receipt() Receipt {
	return Receipt{Operation: WriteKind, RelativePath: "README.md", Bytes: 8, BeforeSHA256: hash("a"), AfterSHA256: digest("b")}
}
func expectState(t *testing.T, err error, code string) {
	t.Helper()
	var e *StateError
	if !errors.As(err, &e) || e.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}
func TestPreparedRecoveryIsUnknownAndNeverExecutionPermission(t *testing.T) {
	r := prepared(t)
	out, err := r.Recover(binding())
	if err != nil {
		t.Fatal(err)
	}
	interrupted, ok := out.(InterruptedRecovery)
	if !ok || interrupted.Tombstone.Phase() != OutcomeUnknown || interrupted.Tombstone.Failure().Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || interrupted.Tombstone.Failure().Source != "operation-store" {
		t.Fatal("prepared became executable")
	}
	again, err := interrupted.Tombstone.Recover(binding())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := again.(FailedRecovery); !ok {
		t.Fatal("unknown became executable")
	}
	if r.Phase() != Prepared {
		t.Fatal("pure recovery mutated input")
	}
}
func TestCompletedAndRefusedResultsRecoverWithoutReexecution(t *testing.T) {
	r, err := prepared(t).Complete(receipt())
	if err != nil {
		t.Fatal(err)
	}
	out, err := r.Recover(binding())
	if err != nil {
		t.Fatal(err)
	}
	v, ok := out.(CompletedRecovery)
	if !ok || v.Receipt.AfterSHA256 != digest("b") {
		t.Fatal("completed receipt lost")
	}
	for _, f := range []Failure{{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}, {Code: "AUTHORITY_EXPIRED", Source: "task-grant"}, {Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"}} {
		failed, err := prepared(t).Refuse(f)
		if err != nil {
			t.Fatal(err)
		}
		got, err := failed.Recover(binding())
		if err != nil {
			t.Fatal(err)
		}
		if v, ok := got.(FailedRecovery); !ok || v.Failure != f {
			t.Fatal("original refusal/unknown lost")
		}
	}
}
func TestSameKeyConflictsAndEveryIdentityDimensionRemainDistinct(t *testing.T) {
	r := prepared(t)
	for _, change := range []func(*Binding){func(b *Binding) { b.WorkspaceID = "other" }, func(b *Binding) { b.RequestDigest = digest("b") }, func(b *Binding) { b.Identity.OperationID = "other" }, func(b *Binding) { b.Identity.OwnerID = "other" }, func(b *Binding) { b.Identity.SessionID = "other" }, func(b *Binding) { b.Identity.TaskID = "other" }, func(b *Binding) { b.Identity.TaskEpoch++ }, func(b *Binding) { b.Identity.ParticipantID = "other" }} {
		b := binding()
		change(&b)
		out, err := r.Recover(b)
		if out != nil {
			t.Fatal("rebound record returned")
		}
		expectCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
}
func TestTerminalStateCannotBeReopenedChangedOrRebound(t *testing.T) {
	for _, phase := range []Phase{Completed, Failed, OutcomeUnknown} {
		var r *State
		var err error
		switch phase {
		case Completed:
			r, err = prepared(t).Complete(receipt())
		case Failed:
			r, err = prepared(t).Refuse(Failure{Code: "WORKSPACE_NOT_FOUND", Source: "native-workspace"})
		case OutcomeUnknown:
			r, err = prepared(t).Refuse(Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := r.Apply(r.Clone()); err != nil {
			t.Fatal("idempotent terminal rejected")
		}
		_, err = r.Apply(*prepared(t))
		expectState(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
		changed, err := prepared(t).Complete(Receipt{Operation: WriteKind, RelativePath: "other", AfterSHA256: digest("c")})
		if err != nil {
			t.Fatal(err)
		}
		_, err = r.Apply(*changed)
		expectState(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
		changed.binding.WorkspaceID = "other"
		_, err = r.Apply(*changed)
		expectState(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
	}
}
func TestJournalRestoreRejectsImpossibleStatesAndPreservesSchemaLimits(t *testing.T) {
	r := receipt()
	f := Failure{Code: "WORKSPACE_NOT_FOUND", Source: "native-workspace"}
	for _, v := range []struct {
		phase Phase
		r     *Receipt
		f     *Failure
	}{{Prepared, &r, nil}, {Completed, nil, nil}, {Completed, &r, &f}, {Failed, &r, &f}, {OutcomeUnknown, nil, &f}, {"invented", nil, nil}} {
		out, err := Restore(binding(), v.phase, v.r, v.f)
		if out != nil {
			t.Fatal("invalid state restored")
		}
		expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	}
	wrong := Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "task-grant"}
	out, err := Restore(binding(), OutcomeUnknown, nil, &wrong)
	if out != nil {
		t.Fatal("authority-sourced unknown")
	}
	expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	wrong.Source = "native-workspace"
	out, err = Restore(binding(), Failed, nil, &wrong)
	if out != nil {
		t.Fatal("unknown stored as deterministic failed")
	}
	expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	// The private TS journal accepts a bounded receipt path without treating it
	// as a canonical file target. Preserve that schema; native correlation is
	// stricter and no restored receipt itself grants path access.
	r.RelativePath = "../journal-metadata"
	if out, err := Restore(binding(), Completed, &r, nil); err != nil || out == nil {
		t.Fatal("journal schema changed")
	}
	zero := State{}
	if _, err := zero.Recover(binding()); err == nil {
		t.Fatal("zero record recovered")
	}
}
func TestStateAndRecoveryCopiesCannotAlterStoredReceipt(t *testing.T) {
	in := receipt()
	r, err := prepared(t).Complete(in)
	if err != nil {
		t.Fatal(err)
	}
	*in.BeforeSHA256 = digest("c")
	exposed := r.Receipt()
	*exposed.BeforeSHA256 = digest("d")
	out, err := r.Recover(binding())
	if err != nil {
		t.Fatal(err)
	}
	v := out.(CompletedRecovery)
	*v.Receipt.BeforeSHA256 = digest("e")
	if *r.Receipt().BeforeSHA256 != digest("a") {
		t.Fatal("stored receipt aliases external values")
	}
}
func TestNativeFailureClassificationPreservesUnknownAndNeverInventsRetry(t *testing.T) {
	for _, v := range []struct{ in, out string }{{"WORKSPACE_RACE_DETECTED", "WORKSPACE_MUTATION_CONFLICT"}, {"WORKSPACE_REQUEST_CANCELLED", "WORKSPACE_MUTATION_CANCELLED"}, {"WORKSPACE_HELPER_FAILED", "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"}, {"WORKSPACE_REQUEST_INTERRUPTED", "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"}, {"unclassified private diagnostic", "WORKSPACE_MUTATION_OUTCOME_UNKNOWN"}, {"WORKSPACE_EDIT_OVERLAP", "WORKSPACE_EDIT_OVERLAP"}} {
		got := NativeFailure(v.in)
		if got.Code != v.out || got.Source != "native-workspace" {
			t.Fatal("wrong mapping")
		}
	}
}

func TestJournalOwnerBoundRemains160WhilePublicRequestBoundIs80(t *testing.T) {
	b := binding()
	b.Identity.OwnerID = strings.Repeat("x", 160)
	if out, err := NewPrepared(b); err != nil || out == nil {
		t.Fatal("journal owner bound narrowed")
	}
	b.Identity.OwnerID += "x"
	out, err := NewPrepared(b)
	if out != nil {
		t.Fatal("journal owner bound expanded")
	}
	expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
}

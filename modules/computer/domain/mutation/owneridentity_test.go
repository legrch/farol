package mutation

import (
	"strings"
	"testing"
)

func ownerBinding() Binding {
	return Binding{Identity: Identity{Scope: ScopeOwnerSettings, OperationID: "operation", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, ComputerGeneration: 7, WorkspaceID: "work", RelativePath: "README.md", RequestDigest: digest("a")}
}

func TestOwnerIdentityScopeAndForbiddenTaskMixing(t *testing.T) {
	for name, b := range map[string]Binding{"task": binding(), "owner": ownerBinding()} {
		t.Run(name, func(t *testing.T) {
			if !ValidIdentity(b.Identity) {
				t.Fatal("valid identity rejected")
			}
			if _, err := NewPrepared(b); err != nil {
				t.Fatal(err)
			}
		})
	}
	cases := map[string]func(*Identity){
		"missing-scope":     func(i *Identity) { i.Scope = "" },
		"task-alias":        func(i *Identity) { i.Scope = "task" },
		"unknown-scope":     func(i *Identity) { i.Scope = "owner" },
		"missing-operation": func(i *Identity) { i.OperationID = "" },
		"missing-owner":     func(i *Identity) { i.OwnerID = "" },
		"missing-profile":   func(i *Identity) { i.ProfileID = "" },
		"missing-computer":  func(i *Identity) { i.ComputerID = "" },
		"session":           func(i *Identity) { i.SessionID = "session" },
		"task":              func(i *Identity) { i.TaskID = "task" },
		"epoch":             func(i *Identity) { i.TaskEpoch = 1 },
		"participant":       func(i *Identity) { i.ParticipantID = "main" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			b := ownerBinding()
			change(&b.Identity)
			if ValidIdentity(b.Identity) {
				t.Fatal("mixed/incomplete identity accepted")
			}
			out, err := NewPrepared(b)
			if out != nil {
				t.Fatal("mixed/incomplete identity restored")
			}
			expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		})
	}
	for _, change := range []func(*Identity){
		func(i *Identity) { i.Scope = "task" },
		func(i *Identity) { i.Scope = ScopeOwnerSettings },
		func(i *Identity) { i.ProfileID = "profile" },
		func(i *Identity) { i.ComputerID = "computer" },
	} {
		b := binding()
		change(&b.Identity)
		if ValidIdentity(b.Identity) {
			t.Fatal("task identity accepts new fields or explicit scope")
		}
		if _, err := NewPrepared(b); err == nil {
			t.Fatal("mixed task identity restored")
		}
	}
}

func TestOwnerIdentityAndBindingBounds(t *testing.T) {
	fields := map[string]func(*Binding, string){
		"operation": func(b *Binding, v string) { b.Identity.OperationID = v },
		"owner":     func(b *Binding, v string) { b.Identity.OwnerID = v },
		"profile":   func(b *Binding, v string) { b.Identity.ProfileID = v },
		"computer":  func(b *Binding, v string) { b.Identity.ComputerID = v },
		"workspace": func(b *Binding, v string) { b.WorkspaceID = v },
	}
	for name, set := range fields {
		t.Run(name, func(t *testing.T) {
			for _, v := range []string{strings.Repeat("x", 160), strings.Repeat("😀", 80)} {
				b := ownerBinding()
				set(&b, v)
				if _, err := NewPrepared(b); err != nil {
					t.Fatal("UTF-16 limit narrowed", err)
				}
			}
			for _, v := range []string{"", strings.Repeat("x", 161), strings.Repeat("😀", 80) + "x", string([]byte{0xff})} {
				b := ownerBinding()
				set(&b, v)
				out, err := NewPrepared(b)
				if out != nil {
					t.Fatal("invalid identifier restored")
				}
				expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
			}
		})
	}
	for _, generation := range []uint64{0, MaxSafeInteger} {
		b := ownerBinding()
		b.ComputerGeneration = generation
		if _, err := NewPrepared(b); err != nil {
			t.Fatal("valid owner generation rejected", err)
		}
	}
	for _, b := range []Binding{
		{Identity: ownerBinding().Identity, ComputerGeneration: MaxSafeInteger + 1, WorkspaceID: "work", RequestDigest: digest("a")},
		{Identity: binding().Identity, ComputerGeneration: 1, WorkspaceID: "work", RequestDigest: digest("a")},
		{Identity: ownerBinding().Identity, WorkspaceID: "work", RequestDigest: "private diagnostic"},
	} {
		out, err := NewPrepared(b)
		if out != nil {
			t.Fatal("invalid binding restored")
		}
		expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
	}
}

func TestOwnerStateAllPhasesRejectRebindingAndReopening(t *testing.T) {
	b := ownerBinding()
	prepared, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	r := receipt()
	failed := Failure{Code: "COMPUTER_AUTHORITY_STORE_UNAVAILABLE", Source: "authority-store"}
	unknown := Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
	for _, v := range []struct {
		phase   Phase
		receipt *Receipt
		failure *Failure
	}{{Prepared, nil, nil}, {Completed, &r, nil}, {Failed, nil, &failed}, {OutcomeUnknown, nil, &unknown}} {
		t.Run(string(v.phase), func(t *testing.T) {
			state, err := Restore(b, v.phase, v.receipt, v.failure)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := prepared.Apply(*state); err != nil {
				t.Fatal("prepared transition rejected", err)
			}
			if _, err := state.Apply(state.Clone()); err != nil {
				t.Fatal("idempotent state rejected", err)
			}
			for _, change := range []func(*Binding){
				func(b *Binding) { b.ComputerGeneration++ },
				func(b *Binding) { b.WorkspaceID = "other" },
				func(b *Binding) { b.RequestDigest = digest("c") },
				func(b *Binding) { b.Identity.OperationID = "other" },
				func(b *Binding) { b.Identity.OwnerID = "other" },
				func(b *Binding) { b.Identity.ProfileID = "other" },
				func(b *Binding) { b.Identity.ComputerID = "other" },
				func(b *Binding) { *b = binding() },
			} {
				changed := b
				change(&changed)
				next, err := Restore(changed, v.phase, v.receipt, v.failure)
				if err != nil {
					t.Fatal(err)
				}
				out, err := state.Apply(*next)
				if out != nil {
					t.Fatal("rebound state returned")
				}
				expectState(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
				outcome, err := state.Recover(changed)
				if outcome != nil {
					t.Fatal("changed binding recovered")
				}
				expectCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
			}
			if v.phase != Prepared {
				_, err := state.Apply(*prepared)
				expectState(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
			}
			if state.Binding() != b || state.Phase() != v.phase {
				t.Fatal("pure transition/recovery mutated input")
			}
		})
	}
}

func TestOwnerPreparedRecoveryRetainsBindingWithoutExecution(t *testing.T) {
	b := ownerBinding()
	s, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s.Recover(b)
	if err != nil {
		t.Fatal(err)
	}
	interrupted, ok := got.(InterruptedRecovery)
	if !ok || interrupted.Tombstone.Binding() != b || interrupted.Tombstone.Phase() != OutcomeUnknown {
		t.Fatal("owner preparation became an execution permit or lost binding")
	}
	got, err = interrupted.Tombstone.Recover(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := got.(FailedRecovery); !ok {
		t.Fatal("unknown recovered as execution")
	}
}

func TestOwnerTargetIsRequiredBoundedAndCannotChange(t *testing.T) {
	b := ownerBinding()
	for _, path := range []string{"", ".", "../escape", "/absolute", "a//b", strings.Repeat("x", 4097), "bad\x00name"} {
		x := b
		x.RelativePath = path
		if _, err := NewPrepared(x); err == nil {
			t.Fatal("invalid owner target accepted")
		}
	}
	task := binding()
	task.RelativePath = "file"
	if _, err := NewPrepared(task); err == nil {
		t.Fatal("task v1 acquired owner target")
	}
	prepared, _ := NewPrepared(b)
	other := b
	other.RelativePath = "other.md"
	next, _ := NewPrepared(other)
	if _, err := prepared.Apply(*next); err == nil {
		t.Fatal("owner target rebound")
	}
	wrong := receipt()
	wrong.RelativePath = "other.md"
	if _, err := prepared.Complete(wrong); err == nil {
		t.Fatal("completed a different target")
	}
}

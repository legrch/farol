package mutation

import (
	"strings"
	"testing"
)

// Pure journal values only. These tests do not establish execution authority.
func connectorV3Binding() Binding {
	return Binding{
		Identity:           Identity{Scope: ScopeConnector, OperationID: "op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"},
		ComputerGeneration: 7, WorkspaceID: "work", RelativePath: "file.md", RequestDigest: digest("a"),
		Connector: ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2,
			SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: WriteKind},
	}
}

func TestConnectorV3IdentityRejectsMissingAndMixedFields(t *testing.T) {
	b := connectorV3Binding()
	if !ValidIdentity(b.Identity) || !b.Connector.Valid() {
		t.Fatal("canonical connector identity/origin rejected")
	}
	for name, change := range map[string]func(*Identity){
		"scope":              func(i *Identity) { i.Scope = "connector" },
		"operation":          func(i *Identity) { i.OperationID = "" },
		"owner":              func(i *Identity) { i.OwnerID = "" },
		"profile":            func(i *Identity) { i.ProfileID = "" },
		"computer":           func(i *Identity) { i.ComputerID = "" },
		"legacy-session":     func(i *Identity) { i.SessionID = "session" },
		"legacy-task":        func(i *Identity) { i.TaskID = "task" },
		"legacy-epoch":       func(i *Identity) { i.TaskEpoch = 1 },
		"legacy-participant": func(i *Identity) { i.ParticipantID = "participant" },
	} {
		t.Run(name, func(t *testing.T) {
			b := connectorV3Binding()
			change(&b.Identity)
			if ValidIdentity(b.Identity) {
				t.Fatal("missing/mixed stable identity accepted")
			}
			got, err := NewPrepared(b)
			if got != nil {
				t.Fatal("invalid state returned")
			}
			expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		})
	}
}

func TestConnectorV3OriginBoundsAndLegacyExclusion(t *testing.T) {
	fields := map[string]func(*ConnectorOrigin, string){
		"build":       func(o *ConnectorOrigin, v string) { o.BuildID = v },
		"backend":     func(o *ConnectorOrigin, v string) { o.BackendGeneration = v },
		"runtime":     func(o *ConnectorOrigin, v string) { o.RuntimeID = v },
		"session":     func(o *ConnectorOrigin, v string) { o.SessionID = v },
		"task":        func(o *ConnectorOrigin, v string) { o.TaskID = v },
		"participant": func(o *ConnectorOrigin, v string) { o.ParticipantID = v },
		"turn":        func(o *ConnectorOrigin, v string) { o.TurnID = v },
		"call":        func(o *ConnectorOrigin, v string) { o.CallID = v },
	}
	for name, set := range fields {
		t.Run(name, func(t *testing.T) {
			for _, value := range []string{strings.Repeat("x", 120), strings.Repeat("😀", 60)} {
				b := connectorV3Binding()
				set(&b.Connector, value)
				if !b.Connector.Valid() {
					t.Fatal("120 UTF-16 units rejected")
				}
				if _, err := NewPrepared(b); err != nil {
					t.Fatal(err)
				}
			}
			for _, value := range []string{"", strings.Repeat("x", 121), strings.Repeat("😀", 60) + "x", string([]byte{0xff})} {
				b := connectorV3Binding()
				set(&b.Connector, value)
				if b.Connector.Valid() {
					t.Fatal("invalid origin identifier accepted")
				}
				got, err := NewPrepared(b)
				if got != nil {
					t.Fatal("invalid origin restored")
				}
				expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
			}
		})
	}
	for name, set := range map[string]func(*Binding, uint64){
		"connector-generation": func(b *Binding, v uint64) { b.Connector.ConnectorGeneration = v },
		"task-epoch":           func(b *Binding, v uint64) { b.Connector.TaskEpoch = v },
		"generation":           func(b *Binding, v uint64) { b.Connector.Generation = v },
		"computer-generation":  func(b *Binding, v uint64) { b.ComputerGeneration = v },
	} {
		t.Run(name, func(t *testing.T) {
			for _, value := range []uint64{0, 1, MaxSafeInteger, MaxSafeInteger + 1} {
				b := connectorV3Binding()
				set(&b, value)
				got, err := NewPrepared(b)
				valid := value <= MaxSafeInteger && (name != "connector-generation" || value > 0)
				if valid {
					if err != nil || got == nil {
						t.Fatalf("valid value %d rejected: %v", value, err)
					}
				} else {
					if got != nil {
						t.Fatal("invalid numeric origin restored")
					}
					expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
				}
			}
		})
	}
	for _, kind := range []Kind{WriteKind, EditKind, "", "read"} {
		b := connectorV3Binding()
		b.Connector.Operation = kind
		got, err := NewPrepared(b)
		if kind == WriteKind || kind == EditKind {
			if err != nil || got == nil {
				t.Fatal("write/edit rejected", err)
			}
		} else {
			if got != nil {
				t.Fatal("unsupported origin operation restored")
			}
			expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		}
	}
	for name, b := range map[string]Binding{"v1": binding(), "v2": ownerBinding(), "v3-missing": connectorV3Binding()} {
		t.Run(name, func(t *testing.T) {
			if name == "v3-missing" {
				b.Connector = ConnectorOrigin{}
			} else {
				b.Connector = ConnectorOrigin{CallID: "call"}
			}
			got, err := NewPrepared(b)
			if got != nil {
				t.Fatal("missing/mixed origin restored")
			}
			expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
		})
	}
}

func TestConnectorV3ExactOriginRequiredForTransitionAndRecovery(t *testing.T) {
	b := connectorV3Binding()
	changes := map[string]func(*Binding){
		"build":                func(b *Binding) { b.Connector.BuildID += "2" },
		"backend":              func(b *Binding) { b.Connector.BackendGeneration += "2" },
		"runtime":              func(b *Binding) { b.Connector.RuntimeID += "2" },
		"connector-generation": func(b *Binding) { b.Connector.ConnectorGeneration++ },
		"session":              func(b *Binding) { b.Connector.SessionID += "2" },
		"task":                 func(b *Binding) { b.Connector.TaskID += "2" },
		"participant":          func(b *Binding) { b.Connector.ParticipantID += "2" },
		"turn":                 func(b *Binding) { b.Connector.TurnID += "2" },
		"call":                 func(b *Binding) { b.Connector.CallID += "2" },
		"epoch":                func(b *Binding) { b.Connector.TaskEpoch++ },
		"generation":           func(b *Binding) { b.Connector.Generation++ },
		"operation":            func(b *Binding) { b.Connector.Operation = EditKind },
	}
	r := Receipt{Operation: WriteKind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: digest("b")}
	failed := Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
	unknown := Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"}
	prepared, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []struct {
		phase   Phase
		receipt *Receipt
		failure *Failure
	}{
		{Prepared, nil, nil}, {Completed, &r, nil}, {Failed, nil, &failed}, {OutcomeUnknown, nil, &unknown},
	} {
		t.Run(string(v.phase), func(t *testing.T) {
			state, err := Restore(b, v.phase, v.receipt, v.failure)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := prepared.Apply(*state); err != nil {
				t.Fatal("valid transition rejected", err)
			}
			if _, err := state.Apply(state.Clone()); err != nil {
				t.Fatal("exact replay rejected", err)
			}
			recovery, err := state.Recover(b)
			if err != nil {
				t.Fatal(err)
			}
			switch got := recovery.(type) {
			case InterruptedRecovery:
				if v.phase != Prepared || got.Tombstone.Binding() != b || got.Tombstone.Phase() != OutcomeUnknown || *got.Tombstone.Failure() != unknown {
					t.Fatal("prepared recovery changed binding/outcome")
				}
			case CompletedRecovery:
				if v.phase != Completed || got.Receipt != r {
					t.Fatal("completed recovery changed receipt")
				}
			case FailedRecovery:
				if v.failure == nil || got.Failure != *v.failure {
					t.Fatal("refused recovery changed failure")
				}
			default:
				t.Fatalf("unexpected recovery %T", recovery)
			}
			for name, change := range changes {
				t.Run(name, func(t *testing.T) {
					changed := b
					change(&changed)
					other, err := NewPrepared(changed)
					if err != nil {
						t.Fatal(err)
					}
					out, err := state.Apply(*other)
					if out != nil {
						t.Fatal("origin mismatch transitioned")
					}
					expectState(t, err, "WORKSPACE_MUTATION_BINDING_MISMATCH")
					recovered, err := state.Recover(changed)
					if recovered != nil {
						t.Fatal("origin mismatch recovered")
					}
					expectCode(t, err, "COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
				})
			}
			if state.Phase() != v.phase || state.Binding() != b {
				t.Fatal("pure operation mutated input")
			}
			if v.phase != Prepared {
				out, err := state.Apply(*prepared)
				if out != nil {
					t.Fatal("terminal reopened")
				}
				expectState(t, err, "WORKSPACE_MUTATION_TERMINAL_IMMUTABLE")
			}
		})
	}
}

func TestConnectorV3CompletedReceiptMatchesOriginAndTarget(t *testing.T) {
	for _, kind := range []Kind{WriteKind, EditKind} {
		t.Run(string(kind), func(t *testing.T) {
			b := connectorV3Binding()
			b.Connector.Operation = kind
			s, err := NewPrepared(b)
			if err != nil {
				t.Fatal(err)
			}
			r := Receipt{Operation: kind, RelativePath: b.RelativePath, Bytes: 12, AfterSHA256: digest("b")}
			if kind == EditKind {
				r.Replacements = 1
				r.BeforeSHA256 = hash("a")
			}
			if _, err := s.Complete(r); err != nil {
				t.Fatal("matching receipt rejected", err)
			}
			for _, change := range []func(*Receipt){
				func(r *Receipt) { r.RelativePath = "other.md" },
				func(r *Receipt) {
					if kind == WriteKind {
						r.Operation = EditKind
					} else {
						r.Operation = WriteKind
					}
				},
			} {
				bad := r.Clone()
				change(&bad)
				out, err := s.Complete(bad)
				if out != nil {
					t.Fatal("mismatched receipt completed")
				}
				expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
				out, err = Restore(b, Completed, &bad, nil)
				if out != nil {
					t.Fatal("mismatched receipt restored")
				}
				expectState(t, err, "WORKSPACE_MUTATION_STATE_INVALID")
			}
		})
	}
}

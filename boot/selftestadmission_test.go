package boot

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Real V4 coordinator and connector policy, with an in-memory journal and a
// counting native double. No workspace, process, provider or owner state is used.
func TestSelfTestV4ScratchRefusalRetainsReasonAndUnknown(t *testing.T) {
	for _, coldChild := range []bool{false, true} {
		for _, lostSave := range []bool{false, true} {
			t.Run(map[bool]string{false: "absent-child", true: "cold-unknown-child"}[coldChild]+"/"+map[bool]string{false: "saved", true: "lost-save"}[lostSave], func(t *testing.T) {
				s, _, journal, native, in := connectorMutationFixture(t)
				store := &factoryJournal{chatMutationJournal: journal, durablePlanStore: &durablePlanStore{}}
				s.mutations.dependencies.repository = store
				s.mutations.stageBaseline = false
				const id = "00000000-0000-4000-8000-000000000001"
				execution, err := s.newConnectorSelfTest(context.Background(), s.current, "work", id, in.Publication)
				if err != nil {
					t.Fatal(err)
				}
				var child *state.State
				if coldChild {
					binding := state.Binding{Identity: execution.binding.Identity, WorkspaceID: "work", ComputerGeneration: execution.binding.ComputerGeneration, RelativePath: state.ScratchPath(id), RequestDigest: strings.Repeat("a", 64)}
					binding.Scratch = state.ScratchBinding{RunID: id, Root: "/disposable", Leaf: binding.RelativePath, RootIdentity: state.DirectoryIdentity{Device: "1", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
					child, err = state.Restore(binding, state.OutcomeUnknown, nil, &state.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
					if err != nil {
						t.Fatal(err)
					}
					journal.records[binding.Identity] = child.Clone()
				}
				if !execution.admitMarker(context.Background(), store) || !execution.reserveForStart(context.Background()) {
					t.Fatal("fixture did not admit the original parent")
				}
				if lostSave {
					store.saveErr = errors.New("controlled missing save acknowledgement")
				}
				out := execution.executeReserved(context.Background())
				if out.Status != "unknown" || len(out.Steps) != 1 || out.Steps[0].Status != "unknown" || out.Steps[0].Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || out.Steps[0].Operation != id {
					t.Fatalf("scratch uncertainty lost its original reason or became a known refusal: %+v", out)
				}
				if journal.admits != 0 || native.calls != 0 || s.mutations.operations[id] != nil || s.mutations.selfTestRun != nil {
					t.Fatal("refused scratch reached a child admission or native operation")
				}
				phase := state.OutcomeUnknown
				if lostSave {
					phase = state.Prepared
				}
				if store.record == nil || store.record.Phase() != phase || store.durablePlanStore.saves != 1 || store.marker.Phase() != state.SelfTestMarkerSelected {
					t.Fatal("unknown parent or selected marker was settled")
				}
				observed, err := s.observeConnectorSelfTest(context.Background(), s.current, execution.binding)
				if err != nil || observed.Status != "unknown" {
					t.Fatal("original observation changed uncertainty", observed, err)
				}
				if !lostSave && (len(observed.Steps) != 1 || observed.Steps[0].Code != out.Steps[0].Code) {
					t.Fatal("saved diagnostic reason was not observable", observed)
				}
				_ = execution.executeReserved(context.Background())
				if journal.admits != 0 || native.calls != 0 || store.durablePlanStore.saves != 1 {
					t.Fatal("consumed parent dispatched another attempt")
				}
				if child != nil && !reflect.DeepEqual(journal.records[child.Binding().Identity], child.Clone()) {
					t.Fatal("cold UNKNOWN child was reinterpreted")
				}
			})
		}
	}
}

func TestSelfTestWorkspaceFailureAfterPossibleEffectStaysUnknown(t *testing.T) {
	// This same failure can follow a native result with missing directory
	// custody. Its no-retry classification never proves absence of an effect.
	out := selfTestFailure("scratch", "original", computerUnavailable())
	if out.Status != "unknown" || out.Code != "COMPUTER_AUTHORITY_STORE_UNAVAILABLE" || out.Operation != "original" {
		t.Fatal("workspace failure became effect settlement", out)
	}
}

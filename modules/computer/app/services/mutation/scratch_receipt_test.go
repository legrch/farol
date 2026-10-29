package mutation

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Injected app-layer evidence only; these do not qualify native publication.
type stagedTestNative struct {
	*testNative
	mode string
	late func(*port.MutationReceipt, error) error
}

func (n *stagedTestNative) MutateAndFinish(ctx context.Context, request port.MutationRequest, finish func(*port.MutationReceipt, error) error) error {
	switch n.mode {
	case "missing":
		return nil
	case "late":
		n.late = finish
		return nil
	}
	receipt, err := n.Mutate(ctx, request)
	if n.mode == "concurrent" {
		var wg sync.WaitGroup
		wg.Add(2)
		for i := 0; i < 2; i++ {
			go func() { defer wg.Done(); _ = finish(receipt, err) }()
		}
		wg.Wait()
		return nil
	}
	first := finish(receipt, err)
	if n.mode == "double" {
		_ = finish(receipt, err)
	}
	if n.mode == "contradictory" {
		return errors.New("contradictory stage result")
	}
	return first
}

func TestScratchResultRetainsDirectoryIdentityAndNeverReexecutes(t *testing.T) {
	for _, interrupted := range []bool{false, true} {
		t.Run(map[bool]string{false: "completed", true: "unknown"}[interrupted], func(t *testing.T) {
			f := newOwnerFixture(t)
			f.service.engine.native = &stagedTestNative{testNative: f.native}
			id := "00000000-0000-4000-8000-000000000001"
			scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
			identity := f.selected.identity()
			identity.OperationID = id
			binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
			directory := state.DirectoryIdentity{Device: "7", Inode: "44"}
			f.native.run = func(_ context.Context, _ port.MutationRequest) (*port.MutationReceipt, error) {
				receipt := &port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: scratch.Leaf, Directory: directory}
				if interrupted {
					return receipt, errors.New("publication outcome unavailable")
				}
				return receipt, nil
			}
			got, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
			if err != nil {
				t.Fatal(err)
			}
			if interrupted {
				if got.Phase != string(state.OutcomeUnknown) || got.Failure == nil || got.Failure.Directory != directory || got.Failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" {
					t.Fatalf("unknown receipt: %#v", got)
				}
			} else if got.Phase != string(state.Completed) || got.Receipt == nil || got.Receipt.Directory != directory {
				t.Fatalf("completion receipt: %#v", got)
			}
			again, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
			if err != nil || again.Phase != got.Phase || f.native.calls != 1 || f.store.saves != 1 {
				t.Fatalf("reexecuted: %#v %v calls=%d saves=%d", again, err, f.native.calls, f.store.saves)
			}
			restarted := f.restart(t)
			again, err = restarted.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
			if err != nil || again.Phase != got.Phase || f.native.calls != 1 || f.store.saves != 1 {
				t.Fatalf("reexecuted after restart: %#v %v calls=%d saves=%d", again, err, f.native.calls, f.store.saves)
			}
		})
	}
}

func TestScratchInvalidDirectoryEvidenceDoesNotBecomeRefusal(t *testing.T) {
	f := newOwnerFixture(t)
	f.service.engine.native = &stagedTestNative{testNative: f.native}
	id := "00000000-0000-4000-8000-000000000001"
	scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	identity := f.selected.identity()
	identity.OperationID = id
	binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
	f.native.run = func(_ context.Context, _ port.MutationRequest) (*port.MutationReceipt, error) {
		return &port.MutationReceipt{Directory: state.DirectoryIdentity{Device: "invalid", Inode: "44"}}, authority.Fail("WORKSPACE_NOT_FOUND", "native-workspace")
	}
	got, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err != nil || got.Phase != string(state.OutcomeUnknown) || got.Failure == nil || got.Failure.Directory != (state.DirectoryIdentity{}) {
		t.Fatalf("malformed evidence became a refusal: %#v %v", got, err)
	}
}

func TestScratchStageCallbackContractCannotReplayOrOverwrite(t *testing.T) {
	for _, mode := range []string{"missing", "late", "double", "concurrent", "contradictory"} {
		t.Run(mode, func(t *testing.T) {
			f := newOwnerFixture(t)
			stage := &stagedTestNative{testNative: f.native, mode: mode}
			f.service.engine.native = stage
			id := "00000000-0000-4000-8000-000000000001"
			scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
			identity := f.selected.identity()
			identity.OperationID = id
			binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
			directory := state.DirectoryIdentity{Device: "7", Inode: "44"}
			f.native.run = func(_ context.Context, _ port.MutationRequest) (*port.MutationReceipt, error) {
				return &port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: scratch.Leaf, Directory: directory}, nil
			}
			out, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
			if mode == "missing" || mode == "late" {
				if err == nil || out != nil || f.store.record.Phase() != state.Prepared {
					t.Fatalf("missing callback: %#v %v", out, err)
				}
			} else if err == nil || out != nil || f.store.record.Phase() != state.Completed {
				t.Fatalf("contradictory callback: %#v %v", out, err)
			}
			if mode == "late" {
				if stage.late == nil || stage.late(&port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: scratch.Leaf, Directory: directory}, nil) == nil {
					t.Fatal("late callback accepted")
				}
			}
			wantSaves := 1
			if mode == "missing" || mode == "late" {
				wantSaves = 0
			}
			if f.store.saves != wantSaves {
				t.Fatalf("saved %d times", f.store.saves)
			}
			beforeCalls := f.native.calls
			restarted := f.restart(t)
			again, err := restarted.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
			if err != nil || again == nil || f.native.calls != beforeCalls || f.store.saves != wantSaves {
				t.Fatalf("replayed: %#v %v", again, err)
			}
		})
	}
}

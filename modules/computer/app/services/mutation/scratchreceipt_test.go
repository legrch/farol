package mutation

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// Injected app-layer evidence only; these do not qualify native publication.
type stagedTestNative struct {
	*testNative
	unavailable bool
	partial     bool
	released    chan struct{}
}

func (n *stagedTestNative) BeginStage(_ context.Context, request port.MutationRequest) (port.StagedMutation, error) {
	if n.unavailable {
		return nil, errors.New("stage unavailable")
	}
	if n.partial {
		return &stagedTestAttempt{owner: n, request: request}, errors.New("partial stage")
	}
	return &stagedTestAttempt{owner: n, request: request}, nil
}

type stagedTestAttempt struct {
	owner   *stagedTestNative
	request port.MutationRequest
}

func (a *stagedTestAttempt) Execute(ctx context.Context) (*port.MutationReceipt, error) {
	return a.owner.Mutate(ctx, a.request)
}
func (a *stagedTestAttempt) Release() {
	if a.owner.released != nil {
		close(a.owner.released)
	}
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

type blockingScratchStore struct {
	*testStore
	entered, continueSave chan struct{}
}

func (s *blockingScratchStore) Save(ctx context.Context, record *state.State) error {
	close(s.entered)
	<-s.continueSave
	return s.testStore.Save(ctx, record)
}

func TestScratchStageHeldThroughOriginalTerminalSave(t *testing.T) {
	f := newOwnerFixture(t)
	stage := &stagedTestNative{testNative: f.native, released: make(chan struct{})}
	f.service.engine.native = stage
	store := &blockingScratchStore{testStore: f.store, entered: make(chan struct{}), continueSave: make(chan struct{})}
	f.service.engine.repository = store
	id := "00000000-0000-4000-8000-000000000001"
	scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	identity := f.selected.identity()
	identity.OperationID = id
	binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
	f.native.run = func(_ context.Context, _ port.MutationRequest) (*port.MutationReceipt, error) {
		return &port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: scratch.Leaf, Directory: state.DirectoryIdentity{Device: "7", Inode: "44"}}, nil
	}
	done := make(chan error, 1)
	go func() {
		_, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
		done <- err
	}()
	<-store.entered
	select {
	case <-stage.released:
		t.Fatal("gate released before terminal save")
	default:
	}
	close(store.continueSave)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	select {
	case <-stage.released:
	default:
		t.Fatal("gate not released after save")
	}
	if f.native.calls != 1 || f.store.saves != 1 {
		t.Fatal("attempt repeated")
	}
}

func TestScratchStageUnavailablePreservesPreparedWithoutEffect(t *testing.T) {
	f := newOwnerFixture(t)
	stage := &stagedTestNative{testNative: f.native, unavailable: true}
	f.service.engine.native = stage
	id := "00000000-0000-4000-8000-000000000001"
	scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	identity := f.selected.identity()
	identity.OperationID = id
	binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
	out, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err == nil || out != nil || f.store.record.Phase() != state.Prepared || f.native.calls != 0 || f.store.saves != 0 {
		t.Fatal("unavailable stage changed original attempt")
	}
	restarted := f.restart(t)
	out, err = restarted.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err != nil || out == nil || out.Phase != string(state.OutcomeUnknown) || f.native.calls != 0 || f.store.saves != 0 {
		t.Fatal("reopen replayed unavailable stage")
	}
}

func TestScratchLostTerminalSaveDoesNotReplay(t *testing.T) {
	f := newOwnerFixture(t)
	f.service.engine.native = &stagedTestNative{testNative: f.native}
	f.store.saveErr = errors.New("terminal acknowledgement unavailable")
	id := "00000000-0000-4000-8000-000000000001"
	scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	identity := f.selected.identity()
	identity.OperationID = id
	binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
	f.native.run = func(_ context.Context, _ port.MutationRequest) (*port.MutationReceipt, error) {
		return &port.MutationReceipt{Operation: string(state.ScratchKind), RelativePath: scratch.Leaf, Directory: state.DirectoryIdentity{Device: "7", Inode: "44"}}, nil
	}
	out, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err != nil || out == nil || out.Phase != string(state.Completed) || out.Publication != "memory_only" || f.store.record.Phase() != state.Prepared {
		t.Fatal("lost acknowledgement misclassified")
	}
	restarted := f.restart(t)
	out, err = restarted.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err != nil || out == nil || out.Phase != string(state.OutcomeUnknown) || f.native.calls != 1 || f.store.saves != 1 {
		t.Fatal("lost acknowledgement replayed")
	}
}

func TestScratchPartialBeginReleasesGateWithoutDispatch(t *testing.T) {
	f := newOwnerFixture(t)
	stage := &stagedTestNative{testNative: f.native, partial: true, released: make(chan struct{})}
	f.service.engine.native = stage
	id := "00000000-0000-4000-8000-000000000001"
	scratch := state.ScratchBinding{RunID: id, Root: "/work", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	identity := f.selected.identity()
	identity.OperationID = id
	binding := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 7, RelativePath: scratch.Leaf, RequestDigest: strings.Repeat("a", 64), Scratch: scratch}
	out, err := f.service.engine.executeBound(context.Background(), binding, state.Scratch{Binding: scratch})
	if err == nil || out != nil || f.native.calls != 0 || f.store.saves != 0 {
		t.Fatal("partial begin dispatched effect")
	}
	select {
	case <-stage.released:
	default:
		t.Fatal("partial gate not released")
	}
}

package boot

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

type stagedScratchMissingCustody struct{}

func (stagedScratchMissingCustody) Mutate(context.Context, port.MutationRequest) (*port.MutationReceipt, error) {
	return nil, errors.New("unexpected ordinary mutation")
}
func (stagedScratchMissingCustody) CreateStagedScratch(_ context.Context, r port.MutationRequest, _ int, _ port.Root) (*port.MutationReceipt, error) {
	if !r.HoldScratchDirectory {
		return nil, errors.New("custody not requested")
	}
	return &port.MutationReceipt{Operation: "scratch", RelativePath: r.Operation.Path(), Directory: mutation.DirectoryIdentity{Device: "7", Inode: "44"}}, nil
}

func TestStagedScratchMissingCustodyIsUnknownBeforeSave(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	binding := mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: mutation.ScratchPath(id), RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{id: {workspace: "work", path: binding.Leaf, pending: true, stageScratch: true}}}
	w := &stagedScratchWorkspace{ledger: ledger, operation: id, native: stagedScratchMissingCustody{}, hold: true}
	selected, err := w.BeginStage(context.Background(), port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work"}, Operation: mutation.Scratch{Binding: binding}})
	if err != nil {
		t.Fatal(err)
	}
	attempt := selected.(*stagedScratchAttempt)
	attempt.lease.runNative = func(ctx context.Context, use func(context.Context, int, NativeRoot) error) error {
		return use(ctx, 1, NativeRoot{})
	}
	receipt, err := attempt.Execute(context.Background())
	var f *authority.Failure
	if !errors.As(err, &f) || f.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || receipt == nil || !receipt.Directory.Valid() {
		t.Fatal("unqualified creation promoted", receipt, err)
	}
	attempt.Release()
}

// In-memory ledger and injected native lifetime. This does not exercise the
// filesystem producer, a runtime, a real process or a live profile.
func TestStagedScratchWorkspaceBindsOriginalOperationAndWorkspace(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	binding := mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: mutation.ScratchPath(id), RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{id: {workspace: "work", path: binding.Leaf, pending: true, stageScratch: true}}}
	w := &stagedScratchWorkspace{ledger: ledger, operation: id, native: filesystem.NewMutable("/work")}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work"}, Operation: mutation.Scratch{Binding: binding}}
	foreign := request
	foreign.Workspace.WorkspaceID = "other"
	if value, err := w.BeginStage(context.Background(), foreign); value != nil || err == nil {
		t.Fatal("foreign workspace admitted")
	}
	if ledger.operations[id].stageAttempted {
		t.Fatal("foreign request consumed original attempt")
	}
	selected, err := w.BeginStage(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	attempt := selected.(*stagedScratchAttempt)
	attempt.lease.runNative = func(context.Context, func(context.Context, int, NativeRoot) error) error {
		return errors.New("native result unconfirmed")
	}
	if _, err := attempt.Execute(context.Background()); err == nil {
		t.Fatal("unknown native result promoted")
	}
	if _, err := attempt.Execute(context.Background()); err == nil {
		t.Fatal("native attempt repeated")
	}
	attempt.Release()
	attempt.Release()
	if value, err := w.BeginStage(context.Background(), request); value != nil || err == nil {
		t.Fatal("original attempt readmitted")
	}
	ledger.closeSelfTestStageAdmission()
	ledger.waitSelfTestStage()
}

func TestStagedScratchExecuteCancellationReachesOriginalLease(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	binding := mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: mutation.ScratchPath(id), RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{id: {workspace: "work", path: binding.Leaf, pending: true, stageScratch: true}}}
	w := &stagedScratchWorkspace{ledger: ledger, operation: id, native: filesystem.NewMutable("/work")}
	selected, err := w.BeginStage(context.Background(), port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work"}, Operation: mutation.Scratch{Binding: binding}})
	if err != nil {
		t.Fatal(err)
	}
	attempt := selected.(*stagedScratchAttempt)
	entered := make(chan struct{})
	attempt.lease.runNative = func(ctx context.Context, _ func(context.Context, int, NativeRoot) error) error {
		close(entered)
		<-ctx.Done()
		return ctx.Err()
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := attempt.Execute(ctx); done <- err }()
	<-entered
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel not forwarded: %v", err)
	}
	attempt.Release()
}

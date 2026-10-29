package boot

import (
	"context"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

type selfTestFileNative struct {
	*chatMutationNative
	bound   int
	binding state.ScratchCleanupBinding
}

func (n *selfTestFileNative) MutateScratch(ctx context.Context, request port.MutationRequest, binding state.ScratchCleanupBinding) (*port.MutationReceipt, error) {
	n.bound++
	n.binding = binding
	if n.bound == 2 && (request.ScratchExpectedFile == nil || request.ScratchExpectedFile.Inode != "20") {
		return nil, mutationInvalid()
	}
	out, err := n.chatMutationNative.Mutate(ctx, request)
	if err == nil && out != nil {
		inode := "20"
		if n.bound == 2 {
			inode = "21"
		}
		out.ScratchFile = state.DirectoryIdentity{Device: "1", Inode: inode}
	}
	return out, err
}

// Real connector/mutation policy owners with injected journal and filesystem.
// This is not a native filesystem or running ChatGPT acceptance test.
func selfTestFileFixture(t *testing.T) (*computerConnector, *selfTestRunLease, *chatMutationJournal, *selfTestFileNative) {
	t.Helper()
	s, _, journal, rawNative, _ := connectorMutationFixture(t)
	native := &selfTestFileNative{chatMutationNative: rawNative}
	s.mutations.dependencies.native = native
	s.mutations.stageBaseline, s.mutations.stageOwner, s.mutations.stageLifetime = true, &computerStageOwner{}, context.Background()
	const id = "00000000-0000-4000-8000-000000000001"
	run, err := s.mutations.beginSelfTestRun(context.Background(), id, "work")
	if err != nil {
		t.Fatal(err)
	}
	leaf := state.ScratchPath(id)
	identity := state.Identity{Scope: state.ScopeOwnerSettings, OperationID: id, OwnerID: s.root.ownerID, ProfileID: s.root.peer.ProfileId, ComputerID: s.root.computerID}
	b := state.Binding{Identity: identity, WorkspaceID: "work", ComputerGeneration: 3, RelativePath: leaf, RequestDigest: strings.Repeat("a", 64), Scratch: state.ScratchBinding{RunID: id, Root: "/disposable", Leaf: leaf, RootIdentity: state.DirectoryIdentity{Device: "1", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}}
	prepared, err := state.NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	created, err := prepared.Complete(state.Receipt{Operation: state.ScratchKind, RelativePath: leaf, Directory: state.DirectoryIdentity{Device: "1", Inode: "10"}})
	if err != nil {
		t.Fatal(err)
	}
	journal.records[identity] = created.Clone()
	s.mutations.operations[id] = &settingsMutationOperation{workspace: "work", path: leaf, generation: 3, stageScratch: true, scratchCreated: true, settled: true, scratch: &mutationsvc.OwnerService{}, selfTestRun: run}
	return s, run, journal, native
}

func TestSelfTestFileUsesOriginalReceiptAndOneShotMutations(t *testing.T) {
	s, run, journal, native := selfTestFileFixture(t)
	write, err := run.mutateFixture(context.Background(), s, s.current, "self-write", "write-call", false)
	if err != nil || write == nil || write.Phase != "completed" || write.Publication != "durable" || write.Receipt == nil || write.Receipt.AfterSHA256 != selfTestFileHash(selfTestFileBefore) {
		t.Fatalf("write %#v %v", write, err)
	}
	if native.bound != 1 || native.binding.Directory.Inode != "10" {
		t.Fatal("original parent not bound")
	}
	if repeated, err := run.mutateFixture(context.Background(), s, s.current, "write-again", "write-call-2", false); err == nil || repeated != nil {
		t.Fatal("write repeated")
	}
	edit, err := run.mutateFixture(context.Background(), s, s.current, "self-edit", "edit-call", true)
	if err != nil || edit == nil || edit.Phase != "completed" || edit.Receipt == nil || edit.Receipt.AfterSHA256 != selfTestFileHash(selfTestFileAfter) || edit.Receipt.BeforeSHA256 == nil || *edit.Receipt.BeforeSHA256 != write.Receipt.AfterSHA256 {
		t.Fatalf("edit %#v %v", edit, err)
	}
	if repeated, err := run.mutateFixture(context.Background(), s, s.current, "edit-again", "edit-call-2", true); err == nil || repeated != nil {
		t.Fatal("edit repeated")
	}
	if native.bound != 2 || native.calls != 2 || journal.admits != 2 || journal.saves != 2 || run.fixtureFileIdentity.Inode != "21" {
		t.Fatal("unexpected effects")
	}
	observation, err := s.observeMutation(context.Background(), s.current, "self-edit", mutationct.ConnectorObservation{WorkspaceID: "work", RelativePath: state.ScratchPath(run.operation) + "/check.txt"})
	if err != nil || observation == nil || observation.OperationID != "self-edit" || observation.Receipt == nil || observation.Receipt.AfterSHA256 != edit.Receipt.AfterSHA256 {
		t.Fatalf("original observation %#v %v", observation, err)
	}
	if out, err := s.mutate(context.Background(), s.current, "ordinary-write", "ordinary-call", connectorWriteFixture()); err == nil || out != nil || native.calls != 2 {
		t.Fatal("ordinary write crossed self-test fence")
	}
}

func TestSelfTestFilePreservesUnconfirmedWriteAndRefusesEdit(t *testing.T) {
	s, run, journal, native := selfTestFileFixture(t)
	journal.saveFault = "after"
	write, err := run.mutateFixture(context.Background(), s, s.current, "self-write", "write-call", false)
	if err != nil || write == nil || write.Publication != "memory_only" || native.calls != 1 {
		t.Fatalf("write %#v %v", write, err)
	}
	if out, err := run.mutateFixture(context.Background(), s, s.current, "self-edit", "edit-call", true); err == nil || out != nil || native.calls != 1 {
		t.Fatal("unconfirmed write authorized edit")
	}
	if out, err := run.mutateFixture(context.Background(), s, s.current, "new-write", "new-call", false); err == nil || out != nil || native.calls != 1 {
		t.Fatal("unconfirmed write repeated")
	}
}

func TestSelfTestFileHoldsFenceUntilOriginalMutationReturns(t *testing.T) {
	s, run, journal, native := selfTestFileFixture(t)
	native.after = func() {
		if out, err := run.mutateFixture(context.Background(), s, s.current, "parallel-edit", "parallel-call", true); err == nil || out != nil {
			t.Fatal("parallel fixture operation admitted")
		}
		if out, err := s.mutate(context.Background(), s.current, "ordinary-write", "ordinary-call", connectorWriteFixture()); err == nil || out != nil {
			t.Fatal("ordinary operation crossed the fence")
		}
		if err := run.abandonUnstarted(); err == nil {
			t.Fatal("run released while mutation was active")
		}
	}
	write, err := run.mutateFixture(context.Background(), s, s.current, "self-write", "write-call", false)
	if err != nil || write == nil || write.Phase != "completed" || native.calls != 1 || journal.admits != 1 {
		t.Fatalf("write %#v %v", write, err)
	}
}

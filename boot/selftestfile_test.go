package boot

import (
	"context"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
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

func TestSelfTestFileRefusesWithoutContinuousCustody(t *testing.T) {
	s, run, journal, native := selfTestFileFixture(t)
	for _, edit := range []bool{false, true} {
		out, err := run.mutateFixture(context.Background(), s, s.current, "fixture-operation", "fixture-call", edit)
		if err == nil || out != nil || native.calls != 0 || native.bound != 0 || journal.admits != 0 {
			t.Fatal("unqualified file mutation had effects", out, err)
		}
	}
	if !s.mutations.scratchAdmissionPendingLocked() || run.cleanupStarted {
		t.Fatal("refusal released or consumed the original run")
	}
}

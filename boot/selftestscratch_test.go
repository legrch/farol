package boot

import (
	"context"
	"strconv"
	"testing"

	mutationsvc "github.com/legrch/farol/modules/computer/app/services/mutation"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestScratchObservationRejectsOrdinaryAndCrossedRecords(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000005"
	binding := state.ScratchBinding{RunID: id, Root: "/approved", Leaf: state.ScratchPath(id), RootIdentity: state.DirectoryIdentity{Device: "1", Inode: "2"}, ExpectedInventory: state.EmptyScratchInventory}
	if _, err := checkedScratchObservation(id, &mutationsvc.OwnerResponse{}, nil); err == nil {
		t.Fatal("ordinary mutation accepted as scratch")
	}
	if _, err := checkedScratchObservation("00000000-0000-4000-8000-000000000006", &mutationsvc.OwnerResponse{Scratch: binding}, nil); err == nil {
		t.Fatal("different scratch operation accepted")
	}
	if _, err := checkedScratchObservation(id, &mutationsvc.OwnerResponse{Scratch: binding}, nil); err != nil {
		t.Fatal("original scratch rejected", err)
	}
}

func TestColdScratchObservationRejectsOrdinaryMutationWithMatchingIdentity(t *testing.T) {
	const id = "00000000-0000-4000-8000-000000000005"
	s, _, journal, native, in := settingsEditFixture(t)
	in.RelativePath = state.ScratchPath(id)
	if out, err := s.edit(context.Background(), id, in); err != nil || out == nil || out.Phase != "completed" {
		t.Fatal("ordinary edit fixture failed", out, err)
	}
	reader, err := settingsMutationIngress(s.computer, s.dependencies)
	if err != nil {
		t.Fatal(err)
	}
	generation, err := strconv.ParseUint(in.Publication.Generation, 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := reader.observe(context.Background(), settingsRead(id, in)); err != nil || out == nil || out.Phase != "completed" {
		t.Fatal("original ordinary edit was not observable", out, err)
	}
	if out, err := reader.observeSelfTestScratch(context.Background(), id, in.WorkspaceId, generation); err == nil || out != nil {
		t.Fatal("cold reader accepted an ordinary edit as scratch", out, err)
	}
	if native.calls != 1 || journal.admits != 1 || journal.saves != 1 {
		t.Fatal("read-only observation changed the original operation")
	}
}

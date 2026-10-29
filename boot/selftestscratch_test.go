package boot

import (
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

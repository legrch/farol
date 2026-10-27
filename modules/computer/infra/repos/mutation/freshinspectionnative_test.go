//go:build darwin

package mutation

import (
	"context"
	"fmt"
	"testing"
)

// Real private storage/locks with synthetic canonical process facts. No OS
// process or actual cleanup witness is manufactured by this observation.
func TestNativeProcessRootsBorrowOriginalWriterAndPreserveRecords(t *testing.T) {
	for _, write := range []bool{false, true} {
		t.Run(fmt.Sprint(write), func(t *testing.T) {
			_, _, scope, intent := processFixture()
			intent.Seal.Write = write
			raw, err := encodeProcess(scope, intent)
			if err != nil {
				t.Fatal(err)
			}
			key, _ := recordKey(processIdentity(scope, intent.OperationID))
			selection := SettledSelection{OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}
			root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, []settledBytes{{key, raw}})
			before := settledNativeSnapshot(t, root.Path)
			r, err := New(context.Background(), root)
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			if unknown, err := r.InspectFreshProcesses(context.Background(), selection); err != nil || unknown != write {
				t.Fatal("historical reservation blocked startup or lost its unknown observation", err)
			}
			if other, err := New(context.Background(), root); other != nil || err == nil {
				if other != nil {
					_ = other.Close()
				}
				t.Fatal("inspection released the original writer lock")
			}
			if err := r.Close(); err != nil {
				t.Fatal(err)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

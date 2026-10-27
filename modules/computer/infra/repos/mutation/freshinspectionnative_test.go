//go:build darwin

package mutation

import (
	"context"
	"errors"
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
			if err := r.InspectFreshProcesses(context.Background(), selection); write && !errors.Is(err, ErrFreshProcessScopeUnavailable) || !write && err != nil {
				t.Fatal("legacy cwd was accepted as the full writable resource scope", err)
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

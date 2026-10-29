//go:build darwin

package mutation

import (
	"bytes"
	"os"
	"path/filepath"

	"context"
	"fmt"
	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
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
			if eligible, err := r.InspectStagingProcesses(context.Background(), selection); err != nil || eligible == write {
				t.Fatal("staging history inspection changed admission or lost original reservation", eligible, err)
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

// The same durable UNKNOWN is observed after closing and reopening the original
// writer. Neither inspection nor a repeated admission republishes the operation.
func TestNativeScratchUnknownSurvivesWriterReopen(t *testing.T) {
	prepared := scratchPrepared(t)
	b := prepared.Binding()
	selection := SettledSelection{OwnerID: b.Identity.OwnerID, ProfileID: b.Identity.ProfileID, ComputerID: b.Identity.ComputerID}
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, nil)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if admission, err := r.Admit(context.Background(), prepared); err != nil || admission.Status != port.MutationAdmitted {
		t.Fatal("first admission", err)
	}
	unknown, err := prepared.Refuse(domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace", Directory: domain.DirectoryIdentity{Device: "7", Inode: "23"}})
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Save(context.Background(), unknown); err != nil {
		t.Fatal(err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	key, err := recordKey(b.Identity)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root.Path, "mutations", key)
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	reopened, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if eligible, err := reopened.InspectStagingProcesses(context.Background(), selection); err != nil || eligible {
		t.Fatal("unknown scratch did not fence staging", err)
	}
	loaded, err := reopened.Load(context.Background(), b.Identity)
	if err != nil || loaded == nil || loaded.Phase() != domain.OutcomeUnknown || loaded.Failure().Directory != unknown.Failure().Directory {
		t.Fatal("unknown facts lost after reopen", err)
	}
	if admission, err := reopened.Admit(context.Background(), prepared); err != nil || admission.Status != port.MutationExisting || admission.Record.Phase() != domain.OutcomeUnknown {
		t.Fatal("original operation was readmitted", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("reopen changed original bytes", err)
	}
}

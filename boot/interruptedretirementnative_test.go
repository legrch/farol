//go:build darwin

package boot

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
)

func interruptedComputerSnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	values := map[string]string{}
	err := filepath.WalkDir(root, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, file)
		if err != nil {
			return err
		}
		values[relative] = fmt.Sprintf("%x", sha256.Sum256(raw))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return values
}

// Actual disposable stores, claims and preservation. Original process closure
// is not inferred here; the separate host test observes its NEW child directly.
func TestNativeInterruptedRetirementPreparation(t *testing.T) {
	for _, scenario := range []string{"preserve", "wrong-ACK", "wrong-profile", "changed-head", "archive-exists", "lost-new-ACK", "late-archive-change"} {
		t.Run(scenario, func(t *testing.T) {
			in := emptyRecoveryFixtureStateAt(t, true, true)
			old := NativeRoot{Path: filepath.Join(in.Profile.Root, "chat"), ProfileID: in.Profile.ProfileID, Device: in.Selection.Current.ChatRoot.Device, Inode: in.Selection.Current.ChatRoot.Inode, OwnerUID: in.Selection.Current.ChatRoot.OwnerUID}
			before, err := emptyRecoveryArchiveFiles(context.Background(), old)
			if err != nil {
				t.Fatal(err)
			}
			computer := filepath.Join(in.Profile.Root, "computer")
			computerBefore := interruptedComputerSnapshot(t, computer)
			archive := filepath.Join(in.Profile.Root, "chat-retired-"+in.Selection.OperationID)
			switch scenario {
			case "wrong-ACK":
				in.Interrupted.ExpectedACKDigest[0] ^= 1
			case "wrong-profile":
				in.Selection.Current.ProfileID = "foreign"
			case "changed-head":
				in.Selection.HeadDigest[0] ^= 1
			case "archive-exists":
				if err := os.Mkdir(archive, 0700); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			_, err = prepareEmptyRecovery(context.Background(), in, func(publication chatport.HandoffPublication) error {
				calls++
				if publication.HandoffID == in.Interrupted.OriginalHandoffID || publication.Binding.ChatRoot == in.Selection.Current.ChatRoot {
					t.Fatal("original retirement reused")
				}
				if scenario == "lost-new-ACK" {
					return errors.New("explicit new operation ACK loss fixture")
				}
				if scenario == "late-archive-change" {
					return os.WriteFile(filepath.Join(archive, "chat-lifecycle.json"), []byte("changed"), 0600)
				}
				return nil
			})
			if !reflect.DeepEqual(computerBefore, interruptedComputerSnapshot(t, computer)) {
				t.Fatal("Computer bytes changed")
			}
			if scenario == "preserve" {
				if err != nil || calls != 1 {
					t.Fatal(err, calls)
				}
				old.Path = archive
				after, err := emptyRecoveryArchiveFiles(context.Background(), old)
				if err != nil || !equalEmptyRecoveryFiles(before, after) {
					t.Fatal("old ACK/absence/bytes changed", err)
				}
				if _, err := prepareEmptyRecovery(context.Background(), in, func(chatport.HandoffPublication) error { t.Fatal("replayed new ACK"); return nil }); err == nil {
					t.Fatal("replay accepted")
				}
			} else if scenario == "lost-new-ACK" || scenario == "late-archive-change" {
				if !errors.Is(err, handoff.Unknown) || calls != 1 {
					t.Fatal("interruption not fenced", err, calls)
				}
			} else if err == nil || calls != 0 {
				t.Fatal("identity conflict admitted", err, calls)
			}
			if calls != 0 && refusePendingEmptyRecovery(in.Profile) == nil {
				t.Fatal("unfinished transition admitted runtime")
			}
		})
	}
}

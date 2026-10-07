//go:build darwin || linux

package results

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"golang.org/x/sys/unix"
)

var closedInspectionNative = flag.Bool("chat-closed-inspection-native", false, "run disposable closed Chat inspection on the Lead native lane")

func closedInspectionNativeFixture(t *testing.T) (Root, port.JournalScope) {
	t.Helper()
	base, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path, err := os.MkdirTemp(base, "farol-chat-results-closedinspection-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fixture_root=%s retained=true", path)
	child := filepath.Join(path, resultChild)
	if err := os.Mkdir(child, 0700); err != nil {
		t.Fatal(err)
	}
	identity := func(path string) port.JournalRoot {
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		return port.JournalRoot{Device: uint64(s.Dev), Inode: uint64(s.Ino), OwnerUID: s.Uid}
	}
	root := Root{Path: path, ProfileID: "profile", Identity: identity(path)}
	raw, err := json.Marshal(resultClaimRecord{1, root.ProfileID, root.Identity, identity(child)})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(child, resultClaim), raw, 0600); err != nil {
		t.Fatal(err)
	}
	return root, port.JournalScope{ProfileID: root.ProfileID, BackendGeneration: "backend"}
}

// Lead-only native fixtures. No constructors, provider, process, installed
// profile, recovery or real owner data; never run in the pure writer lane.
func TestClosedInspectionNativeResultsClaimEmptyIdentityAndReadOnly(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	root, scope := closedInspectionNativeFixture(t)
	path := filepath.Join(root.Path, resultChild, resultClaim)
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var before unix.Stat_t
	if err := unix.Lstat(path, &before); err != nil {
		t.Fatal(err)
	}
	err = WithClosedInspection(context.Background(), root, scope, func(v ClosedInspection) error {
		if v.Root != root.Identity || v.Scope != scope || v.ResultCount != 0 || v.ClaimDigest != sha256.Sum256(raw) {
			t.Fatal("incorrect result metadata")
		}
		if d, err := openResultDisk(context.Background(), root, "open"); err == nil {
			d.close()
			t.Fatal("callback lost result claim")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	var after unix.Stat_t
	if err := unix.Lstat(path, &after); err != nil || !resultStable(before, after) {
		t.Fatal("claim changed", err)
	}
	now, err := os.ReadFile(path)
	if err != nil || string(now) != string(raw) {
		t.Fatal("claim bytes changed", err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil || len(entries) != 1 || entries[0].Name() != resultClaim {
		t.Fatal("created/deleted result entries", err)
	}
	d, err := openResultDisk(context.Background(), root, "open")
	if err != nil {
		t.Fatal("claim leaked", err)
	}
	if err := d.close(); err != nil {
		t.Fatal(err)
	}
}

func TestClosedInspectionNativeResultsRejectsClaimInventoryChangesAndRelocation(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	for _, kind := range []string{"missing-child", "missing-claim", "noncanonical-claim", "profile", "unexpected", "unknown", "attempt-only", "nonempty", "callback-claim-change", "relocation"} {
		if !t.Run(kind, func(t *testing.T) {
			root, scope := closedInspectionNativeFixture(t)
			child := filepath.Join(root.Path, resultChild)
			claim := filepath.Join(child, resultClaim)
			switch kind {
			case "missing-child":
				if err := os.Rename(child, filepath.Join(root.Path, "retained-child")); err != nil {
					t.Fatal(err)
				}
			case "missing-claim":
				if err := os.Rename(claim, filepath.Join(root.Path, "retained-claim")); err != nil {
					t.Fatal(err)
				}
			case "noncanonical-claim":
				raw, err := os.ReadFile(claim)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(claim, append(raw, ' '), 0600); err != nil {
					t.Fatal(err)
				}
			case "profile":
				root.ProfileID, scope.ProfileID = "other", "other"
			case "unexpected", "unknown", "attempt-only", "nonempty":
				name := "unexpected"
				if kind == "unknown" {
					name = resultUnknown
				}
				if kind == "attempt-only" || kind == "nonempty" {
					name = resultKey(requestFixture()) + ".attempt"
				}
				if err := os.WriteFile(filepath.Join(child, name), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
				if kind == "nonempty" {
					if err := os.WriteFile(filepath.Join(child, resultKey(requestFixture())+".commit"), []byte("fixture"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			calls := 0
			err := WithClosedInspection(context.Background(), root, scope, func(ClosedInspection) error {
				calls++
				if kind == "callback-claim-change" {
					if err := os.WriteFile(claim, []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				} else if kind == "relocation" {
					if err := os.Rename(root.Path, root.Path+".fixed-archive"); err != nil {
						t.Fatal(err)
					}
				}
				return nil
			})
			if err == nil || kind != "callback-claim-change" && kind != "relocation" && calls != 0 {
				t.Fatal("invalid empty namespace qualified", calls, err)
			}
			if kind == "relocation" {
				child = filepath.Join(root.Path+".fixed-archive", resultChild)
			}
			if kind != "unknown" {
				if _, err := os.Lstat(filepath.Join(child, resultUnknown)); !os.IsNotExist(err) {
					t.Fatal("inspection poisoned storage", err)
				}
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

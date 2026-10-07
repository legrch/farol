//go:build darwin || linux

package lifecycle

import (
	"context"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"
)

var closedInspectionNative = flag.Bool("chat-closed-inspection-native", false, "run disposable closed Chat inspection on the Lead native lane")

// Authored for the Lead only; not run by this writer. Fixtures are retained,
// disposable roots, with no installed profile, application or provider access.
func TestClosedInspectionNativeLifecycleRetainsClaimAndPreservesBytes(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	root, raw := nativeInspectionFixture(t, inspectionEmptyRecord())
	before := nativeInspectionInventory(t, root.Path)
	callbackErr := errors.New("caller stopped")
	for _, stop := range []bool{false, true} {
		calls := 0
		err := WithClosedInspection(context.Background(), root, scope, inspectionLimits, func(v ClosedInspection) error {
			calls++
			if v.Root != root.identity() || v.Scope != scope || v.Revision != 0 {
				t.Fatal("wrong metadata")
			}
			if d, err := openInspectionDisk(context.Background(), root); err == nil {
				d.close()
				t.Fatal("callback lost claim lock")
			}
			if stop {
				return callbackErr
			}
			return nil
		})
		if calls != 1 || !stop && err != nil || stop && !errors.Is(err, callbackErr) {
			t.Fatal("callback outcome differs", calls, err)
		}
		assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
		d, err := openInspectionDisk(context.Background(), root)
		if err != nil {
			t.Fatal("claim leaked", err)
		}
		if err := d.close(); err != nil {
			t.Fatal(err)
		}
	}
	stored, err := os.ReadFile(filepath.Join(root.Path, snapshotName))
	if err != nil || string(stored) != string(raw) {
		t.Fatal("snapshot changed", err)
	}
}

func TestClosedInspectionNativeLifecycleRejectsCallbackChangesAndRelocation(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("requires explicit Lead native lane")
	}
	for _, kind := range []string{"same-byte-replacement", "claim-change", "relocation", "cancelled"} {
		if !t.Run(kind, func(t *testing.T) {
			root, raw := nativeInspectionFixture(t, inspectionEmptyRecord())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			err := WithClosedInspection(ctx, root, scope, inspectionLimits, func(ClosedInspection) error {
				path := filepath.Join(root.Path, snapshotName)
				switch kind {
				case "same-byte-replacement":
					if err := os.Rename(path, path+".retained"); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
				case "claim-change":
					if err := os.WriteFile(filepath.Join(root.Path, claimName), []byte("changed"), 0600); err != nil {
						t.Fatal(err)
					}
				case "relocation":
					if err := os.Rename(root.Path, root.Path+".fixed-archive"); err != nil {
						t.Fatal(err)
					}
				case "cancelled":
					cancel()
				}
				return nil
			})
			if err == nil {
				t.Fatal("changed/cancelled observation qualified")
			}
			path := root.Path
			if kind == "relocation" {
				path += ".fixed-archive"
			}
			if _, err := os.Lstat(filepath.Join(path, claimName)); err != nil {
				t.Fatal("claim removed", err)
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

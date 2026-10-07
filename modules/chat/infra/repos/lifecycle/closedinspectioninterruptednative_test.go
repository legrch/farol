//go:build darwin || linux

package lifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Authored only. The Lead's explicit native flag is required; all fixtures are
// disposable retained roots and never installed profiles or runtime owners.
func TestInterruptedRetirementNativeLifecycleClaimCopyAndReadOnly(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane")
	}
	root, _ := nativeInspectionFixture(t, interruptedRetirementPureRecord())
	before := nativeInspectionInventory(t, root.Path)
	if l, err := AcquireClosedInspection(context.Background(), root, scope, inspectionLimits); l != nil || !errors.Is(err, Refused) {
		if l != nil {
			l.Close()
		}
		t.Fatal("ordinary inspector admitted retired scope", err)
	}
	l, err := AcquireInterruptedRetirementInspection(context.Background(), root, scope, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireInterruptedRetirementInspection(context.Background(), root, scope, inspectionLimits); err == nil {
		other.Close()
		t.Fatal("claim was not retained")
	}
	v, err := l.Observation()
	if err != nil || v.Retirement == nil || v.Retirement.Scope != scope || v.Retirement.Root != root.identity() || v.Revision != 1 {
		t.Fatal("retirement observation differs", err)
	}
	v.Retirement.Scope.BackendGeneration = "changed"
	v.Retirement.Turns = append(v.Retirement.Turns, port.RetirementTurn{})
	again, err := l.Observation()
	if err != nil || again.Retirement.Scope != scope || len(again.Retirement.Turns) != 0 || l.Verify() != nil {
		t.Fatal("copy or final verification failed", err)
	}
	if l.Close() != nil || l.Close() != nil {
		t.Fatal("close failed")
	}
	assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
	if _, err := l.Observation(); err == nil {
		t.Fatal("closed lease exposed retirement")
	}
}

func TestInterruptedRetirementNativeLifecycleLateChangesSticky(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane")
	}
	for _, kind := range []string{"snapshot-replacement", "claim-replacement", "relocation", "cancelled"} {
		if !t.Run(kind, func(t *testing.T) {
			root, _ := nativeInspectionFixture(t, interruptedRetirementPureRecord())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			l, err := AcquireInterruptedRetirementInspection(ctx, root, scope, inspectionLimits)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			switch kind {
			case "snapshot-replacement", "claim-replacement":
				name := snapshotName
				if kind == "claim-replacement" {
					name = claimName
				}
				path := filepath.Join(root.Path, name)
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path, path+".retained"); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "relocation":
				if err := os.Rename(root.Path, root.Path+".retained"); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			first := l.Verify()
			if kind == "relocation" {
				if err := os.Rename(root.Path+".retained", root.Path); err != nil {
					t.Fatal(err)
				}
			}
			if first == nil || l.Verify() != first {
				t.Fatal("late failure not sticky", first)
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("failed lease exposed retirement")
			}
			if l.Close() != nil || l.Close() != nil {
				t.Fatal("close failed")
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

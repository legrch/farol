//go:build darwin || linux

package handoff

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// Authored for the Lead only; the existing native flag is opt-in. Fixtures are
// disposable retained roots, never an installed profile, app or provider call.
func TestInterruptedRetirementNativeHandoffClaimCopyAndReadOnly(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane")
	}
	roots, expected, id := acknowledgedInspectionNativeFixture(t, 2)
	scope := port.JournalScope{ProfileID: expected.ProfileID, BackendGeneration: expected.BackendGeneration}
	before := closedInspectionNativeInventory(t, roots.Chat.Path)
	if l, err := AcquireClosedInspection(context.Background(), roots, scope); l != nil || !errors.Is(err, Refused) {
		if l != nil {
			l.Close()
		}
		t.Fatal("ordinary inspector admitted ACK-only scope", err)
	}
	l, err := AcquireInterruptedRetirementInspection(context.Background(), roots, scope)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireInterruptedRetirementInspection(context.Background(), roots, scope); err == nil {
		other.Close()
		t.Fatal("claim was not retained")
	}
	v, err := l.Observation()
	if err != nil || v.Head == nil || v.HeadStage != port.HandoffAcknowledged || v.Publication.Binding != expected || v.Publication.HandoffID != id || v.Head.Record.Terminal != nil || v.Head.Record.Consumption != nil {
		t.Fatal("interrupted observation differs", err)
	}
	v.Head.Record.ACK.Publication.HandoffID = "changed"
	again, err := l.Observation()
	if err != nil || again.Head.Record.ACK.Publication.HandoffID != id || l.Verify() != nil {
		t.Fatal("copy or final verification failed", err)
	}
	if l.Close() != nil || l.Close() != nil {
		t.Fatal("close failed")
	}
	after := closedInspectionNativeInventory(t, roots.Chat.Path)
	if len(before) != len(after) {
		t.Fatal("inspection changed inventory")
	}
	for name, b := range before {
		a, ok := after[name]
		if !ok || !stable(b.meta, a.meta) || b.digest != a.digest {
			t.Fatal("inspection changed inode or bytes", name)
		}
	}
}

func TestInterruptedRetirementNativeHandoffLateChangesSticky(t *testing.T) {
	if !*closedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane")
	}
	for _, kind := range []string{"ACK-replacement", "relocation", "terminal-appended", "unknown-late", "cancelled"} {
		if !t.Run(kind, func(t *testing.T) {
			roots, expected, _ := acknowledgedInspectionNativeFixture(t, 2)
			scope := port.JournalScope{ProfileID: expected.ProfileID, BackendGeneration: expected.BackendGeneration}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			l, err := AcquireInterruptedRetirementInspection(ctx, roots, scope)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			switch kind {
			case "ACK-replacement":
				path := filepath.Join(roots.Chat.Path, stepName(2, "attempt"))
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
				if err := os.Rename(roots.Chat.Path, roots.Chat.Path+".retained"); err != nil {
					t.Fatal(err)
				}
			case "terminal-appended":
				for _, part := range []string{"attempt", "commit"} {
					name := stepName(3, part)
					if err := os.Rename(filepath.Join(roots.Parent.Path, "retained-fixture-"+name), filepath.Join(roots.Chat.Path, name)); err != nil {
						t.Fatal(err)
					}
				}
			case "unknown-late":
				if err := os.WriteFile(filepath.Join(roots.Chat.Path, unknownName), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			first := l.Verify()
			if kind == "relocation" {
				if err := os.Rename(roots.Chat.Path+".retained", roots.Chat.Path); err != nil {
					t.Fatal(err)
				}
			}
			if first == nil || l.Verify() != first {
				t.Fatal("late failure not sticky", first)
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("failed lease exposed ACK")
			}
			if l.Close() != nil || l.Close() != nil {
				t.Fatal("close failed")
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

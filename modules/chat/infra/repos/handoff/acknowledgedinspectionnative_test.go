//go:build darwin || linux

package handoff

import (
	"context"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

var acknowledgedInspectionNative = flag.Bool("chat-acknowledged-inspection-native", false, "run disposable acknowledged Chat inspection on the Lead native lane")

// Reuse the retained raw-file fixture, never a store/service constructor or
// runtime operation. Move later fixture steps outside Chat to leave exactly the
// initial ACK prefix. All fixture bytes remain retained, including on failure.
func acknowledgedInspectionNativeFixture(t *testing.T, steps int) (Roots, port.HandoffBinding, string) {
	t.Helper()
	roots, _ := closedInspectionNativeFixture(t)
	raw, err := os.ReadFile(filepath.Join(roots.Chat.Path, stepName(2, "attempt")))
	if err != nil {
		t.Fatal(err)
	}
	ack, err := decode(raw)
	if err != nil {
		t.Fatal(err)
	}
	for index := steps + 1; index <= 4; index++ {
		for _, kind := range []string{"attempt", "commit"} {
			name := stepName(index, kind)
			if err := os.Rename(filepath.Join(roots.Chat.Path, name), filepath.Join(roots.Parent.Path, "retained-fixture-"+name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	return roots, ack.Publication.Binding, ack.Publication.HandoffID
}

func TestAcknowledgedInspectionNativeExactPrefixClaimAndReadOnly(t *testing.T) {
	if !*acknowledgedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane grant")
	}
	roots, expected, id := acknowledgedInspectionNativeFixture(t, 2)
	before := closedInspectionNativeInventory(t, roots.Chat.Path)
	l, err := AcquireAcknowledgedInspection(context.Background(), roots, expected, id)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if other, err := AcquireAcknowledgedInspection(context.Background(), roots, expected, id); err == nil {
		other.Close()
		t.Fatal("existing claim not retained")
	}
	v := l.Observation()
	if v == nil || v.Record.Stage != port.HandoffAcknowledged || v.Record.Publication.Binding != expected || v.Record.Publication.HandoffID != id || !v.EmptyRetirementChain || v.Record.Terminal != nil || v.Record.Consumption != nil {
		t.Fatal("exact canonical ACK not observed")
	}
	v.Record.ACK.Publication.HandoffID = "caller-mutated"
	v.Record.Receipt.Write.Turns = append(v.Record.Receipt.Write.Turns, port.RetirementTurn{})
	if v := l.Observation(); v == nil || v.Record.ACK.Publication.HandoffID != id || len(v.Record.Receipt.Write.Turns) != 0 {
		t.Fatal("observation aliases retained head")
	}
	if err := l.Verify(); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil || l.Close() != nil || l.Observation() != nil {
		t.Fatal("lease close failed", err)
	}
	after := closedInspectionNativeInventory(t, roots.Chat.Path)
	if len(before) != len(after) {
		t.Fatal("inspection created/deleted entries")
	}
	for name, b := range before {
		a, ok := after[name]
		if !ok || !stable(b.meta, a.meta) || b.digest != a.digest {
			t.Fatal("inspection changed inode or bytes", name)
		}
	}
	next, err := AcquireAcknowledgedInspection(context.Background(), roots, expected, id)
	if err != nil {
		t.Fatal("claim leaked", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestAcknowledgedInspectionNativeRefusals(t *testing.T) {
	if !*acknowledgedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane grant")
	}
	for _, kind := range []string{"terminal", "consumed", "gap", "unknown", "hidden-staging", "staging", "missing-claim", "commit-digest", "id", "binding", "profile", "current-root"} {
		if !t.Run(kind, func(t *testing.T) {
			steps := 2
			if kind == "terminal" {
				steps = 3
			} else if kind == "consumed" {
				steps = 4
			}
			roots, expected, id := acknowledgedInspectionNativeFixture(t, steps)
			chat := roots.Chat.Path
			switch kind {
			case "gap", "missing-claim":
				name := stepName(1, "attempt")
				if kind == "missing-claim" {
					name = claimName
				}
				if err := os.Rename(filepath.Join(chat, name), filepath.Join(roots.Parent.Path, "retained-"+name)); err != nil {
					t.Fatal(err)
				}
			case "unknown", "hidden-staging", "staging", "commit-digest":
				name := unknownName
				switch kind {
				case "hidden-staging":
					name = ".chat-handoff-staging"
				case "staging":
					name = "chat-handoff-staging"
				case "commit-digest":
					name = stepName(2, "commit")
				}
				if err := os.WriteFile(filepath.Join(chat, name), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "id":
				id = "other"
			case "binding":
				expected.HostLifetimeID = "other"
			case "profile":
				roots.ProfileID, expected.ProfileID = "other", "other"
			case "current-root":
				roots.Chat.Identity.Inode++
				expected.ChatRoot = roots.Chat.Identity
			}
			before := closedInspectionNativeInventory(t, chat)
			l, err := AcquireAcknowledgedInspection(context.Background(), roots, expected, id)
			if err == nil || l != nil {
				if l != nil {
					l.Close()
				}
				t.Fatal("invalid native prefix qualified", err)
			}
			if kind == "unknown" {
				var failure *Failure
				if !errors.Is(err, Unknown) || !errors.As(err, &failure) || !failure.OutcomeUnknown {
					t.Fatal("UNKNOWN classification lost", err)
				}
			}
			after := closedInspectionNativeInventory(t, chat)
			if len(before) != len(after) {
				t.Fatal("refused inspection created/deleted entries")
			}
			for name, b := range before {
				a, ok := after[name]
				if !ok || !stable(b.meta, a.meta) || b.digest != a.digest {
					t.Fatal("refused inspection mutated storage", name)
				}
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

func TestAcknowledgedInspectionNativeLateChangesSticky(t *testing.T) {
	if !*acknowledgedInspectionNative {
		t.Skip("NOTRUN until explicit Lead native lane grant")
	}
	for _, kind := range []string{"callback-replacement", "claim-replacement", "root-latechanged", "extra-step", "unknown-late", "staging-late", "cancelled"} {
		if !t.Run(kind, func(t *testing.T) {
			roots, expected, id := acknowledgedInspectionNativeFixture(t, 2)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			l, err := AcquireAcknowledgedInspection(ctx, roots, expected, id)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			if l.Observation() == nil {
				t.Fatal("missing initial observation")
			}
			chat := roots.Chat.Path
			switch kind {
			case "callback-replacement", "claim-replacement":
				name := stepName(2, "attempt")
				if kind == "claim-replacement" {
					name = claimName
				}
				path := filepath.Join(chat, name)
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path, filepath.Join(roots.Parent.Path, "retained-"+name)); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			case "root-latechanged":
				if err := os.Rename(chat, chat+".retained"); err != nil {
					t.Fatal(err)
				}
			case "extra-step":
				for _, part := range []string{"attempt", "commit"} {
					name := stepName(3, part)
					if err := os.Rename(filepath.Join(roots.Parent.Path, "retained-fixture-"+name), filepath.Join(chat, name)); err != nil {
						t.Fatal(err)
					}
				}
			case "unknown-late", "staging-late":
				name := unknownName
				if kind == "staging-late" {
					name = ".chat-handoff-staging"
				}
				if err := os.WriteFile(filepath.Join(chat, name), []byte("fixture"), 0600); err != nil {
					t.Fatal(err)
				}
			case "cancelled":
				cancel()
			}
			failure := l.Verify()
			if kind == "root-latechanged" {
				if err := os.Rename(chat+".retained", chat); err != nil {
					t.Fatal(err)
				}
			}
			if failure == nil || l.Verify() != failure || l.Observation() != nil {
				t.Fatal("late change accepted or failure not sticky", failure)
			}
			if err := l.Close(); err != nil {
				t.Fatal("failed verification leaked descriptors", err)
			}
			if kind != "unknown-late" {
				if _, err := os.Lstat(filepath.Join(chat, unknownName)); !os.IsNotExist(err) {
					t.Fatal("inspection poisoned storage", err)
				}
			}
		}) {
			t.Fatal("stop and retain failed native fixture")
		}
	}
}

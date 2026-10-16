//go:build darwin || linux

package handoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
)

var preservationNative = flag.Bool("chat-preservation-native", false, "run retained disposable handoff preservation-claim checks")

func preservationNativeFixture(t *testing.T, count int) (Roots, port.JournalScope) {
	t.Helper()
	roots, _ := closedInspectionNativeFixture(t)
	for index := 1; index <= 4; index++ {
		for _, kind := range []string{"attempt", "commit"} {
			name := stepName(index, kind)
			if err := os.Rename(filepath.Join(roots.Chat.Path, name), filepath.Join(roots.Parent.Path, "retained-empty-"+name)); err != nil {
				t.Fatal(err)
			}
		}
	}
	r := historyRecord(nativeBinding(roots), "nonempty-origin", historyTurnSpec{"operation", "owner", false})
	d := &memoryDisk{}
	a := historyCycle(t, d, r, historyNextBinding(r.Publication.Binding, 2))
	for index, raw := range d.records[:count] {
		sum := sha256.Sum256(raw)
		for name, bytes := range map[string][]byte{stepName(index+1, "attempt"): raw, stepName(index+1, "commit"): []byte(hex.EncodeToString(sum[:]))} {
			if err := os.WriteFile(filepath.Join(roots.Chat.Path, name), bytes, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	scope := r.Receipt.Write.Scope
	if count == 4 {
		scope = a.Consumption.Next
	}
	return roots, scope
}

// Actual private filesystem/claim, with synthetic canonical retirement data.
// Persisted terminal/ACK values are never original host or child custody.
func TestPreservationNativeRetainsNonemptyAndInitialCanonicalHandoffClaims(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, count := range []int{0, 1, 2, 3, 4} {
		roots, scope := preservationNativeFixture(t, count)
		before := closedInspectionNativeInventory(t, roots.Chat.Path)
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		l, err := AcquirePreservationInspection(ctx, roots, scope)
		if err != nil {
			cancel()
			t.Fatal(count, err)
		}
		v, err := l.Observation()
		if err != nil || v.Scope != scope || v.ParentRoot != roots.Parent.Identity || v.ChatRoot != roots.Chat.Identity || len(v.Stages) != count {
			t.Fatal("incorrect metadata", count, err)
		}
		raw, err := json.Marshal(v)
		if err != nil || strings.Contains(string(raw), "Receipt") || strings.Contains(string(raw), "Turns") || strings.Contains(string(raw), "Quiescence") {
			t.Fatal("stored authority exposed", err)
		}
		if count > 0 {
			v.Stages[0].Digest[0] ^= 1
			if again, err := l.Observation(); err != nil || again.Stages[0] == v.Stages[0] {
				t.Fatal("copied metadata aliases lease", err)
			}
		}
		if d, err := openClosedInspectionDisk(ctx, roots); err == nil {
			d.close()
			t.Fatal("claim not retained")
		}
		if err := l.Verify(); err != nil {
			t.Fatal(err)
		}
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		if _, err := l.Observation(); err == nil {
			t.Fatal("closed lease returned observation")
		}
		if old, err := AcquireClosedInspection(ctx, roots, scope); old != nil || err == nil {
			if old != nil {
				old.Close()
			}
			t.Fatal("old empty-only policy weakened")
		}
		after := closedInspectionNativeInventory(t, roots.Chat.Path)
		if len(before) != len(after) {
			t.Fatal("inventory changed")
		}
		for name, before := range before {
			after, ok := after[name]
			if !ok || before.digest != after.digest || !stable(before.meta, after.meta) {
				t.Fatal("inspection mutated bytes/metadata", name)
			}
		}
		cancel()
	}
}

func TestPreservationNativeHandoffOriginalLeasePoisonsOnChange(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, kind := range []string{"same-byte-replacement", "claim-change", "staging", "relocation", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			roots, scope := preservationNativeFixture(t, 4)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, roots, scope)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			switch kind {
			case "same-byte-replacement":
				file := filepath.Join(roots.Chat.Path, stepName(1, "attempt"))
				raw, err := os.ReadFile(file)
				must(err)
				must(os.Rename(file, filepath.Join(roots.Parent.Path, "retained-first")))
				must(os.WriteFile(file, raw, 0600))
			case "claim-change":
				must(os.WriteFile(filepath.Join(roots.Chat.Path, claimName), []byte("changed"), 0600))
			case "staging":
				must(os.WriteFile(filepath.Join(roots.Chat.Path, ".chat-handoff-staging"), []byte("retained"), 0600))
			case "relocation":
				must(os.Rename(roots.Chat.Path, roots.Chat.Path+".retained"))
			case "cancel":
				cancel()
			}
			if l.Verify() == nil {
				t.Fatal("changed original handoff qualified")
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("failed handoff lease revived")
			}
			must(l.Close())
		})
	}
}

type preservationLagContext struct {
	context.Context
	until time.Time
	calls atomic.Int32
}

func (c *preservationLagContext) Deadline() (time.Time, bool) { c.calls.Add(1); return c.until, true }

func TestPreservationNativeHandoffNeverRenewsOriginalDeadline(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	roots, scope := preservationNativeFixture(t, 4)
	if l, err := AcquirePreservationInspection(context.Background(), roots, scope); l != nil || err == nil {
		t.Fatal("unbounded claim admitted")
	}
	ctx := &preservationLagContext{Context: context.Background(), until: time.Now().Add(250 * time.Millisecond)}
	l, err := AcquirePreservationInspection(ctx, roots, scope)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	time.Sleep(time.Until(ctx.until) + time.Millisecond)
	if ctx.Err() != nil || ctx.calls.Load() != 1 || l.Verify() == nil {
		t.Fatal("original deadline renewed or timer lag accepted")
	}
	if _, err := l.Observation(); err == nil {
		t.Fatal("expired claim returned observation")
	}
}

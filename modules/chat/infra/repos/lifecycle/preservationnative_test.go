//go:build darwin || linux

package lifecycle

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/chat/app/port"
)

var preservationNative = flag.Bool("chat-preservation-native", false, "run retained disposable canonical lifecycle preservation-claim checks")

// Actual descriptors, bytes, metadata and flock; synthetic canonical records.
// No application/provider/process/Computer or writable recovery is qualified.
func TestPreservationLeaseRetainsCanonicalNonemptyAndUnknownHistory(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, kind := range []string{"admitted", "unknown-send", "recorded-retirement"} {
		t.Run(kind, func(t *testing.T) {
			value := inspectionEmptyRecord()
			switch kind {
			case "admitted":
				value.Writes = []port.JournalWrite{admissionWrite(t)}
			case "unknown-send":
				value = inspectionUnknownRecord(t)
			case "recorded-retirement":
				value.Retirement = &port.RetirementWrite{Scope: scope, Root: fixtureRoot, Revision: 1, Turns: []port.RetirementTurn{}}
			}
			root, raw := nativeInspectionFixture(t, value)
			before := nativeInspectionInventory(t, root.Path)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, root, scope, inspectionLimits)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			got, err := l.Observation()
			want, pureErr := inspectRecord(raw, root, inspectionLimits)
			if err != nil || pureErr != nil || !reflect.DeepEqual(got, want) || got.SnapshotDigest != sha256.Sum256(raw) {
				t.Fatal("complete canonical metadata changed", err, pureErr)
			}
			got.Incarnations[0] = "caller-mutation"
			if got.Retirement != nil {
				got.Retirement.Revision = 999
			}
			again, err := l.Observation()
			if err != nil || !reflect.DeepEqual(again, want) {
				t.Fatal("provisional value aliases retained inspection")
			}
			encoded, err := json.Marshal(again)
			if err != nil || strings.Contains(string(encoded), "IntentDigest") || strings.Contains(string(encoded), "Payload") || strings.Contains(string(encoded), "Quiescence") {
				t.Fatal("inspection disclosed stored authority/body data")
			}
			if _, ok := any(l).(port.CleanRetirement); ok {
				t.Fatal("preservation lease became clean retirement")
			}
			if d, err := openInspectionDisk(ctx, root); err == nil {
				d.close()
				t.Fatal("original claim no longer held")
			}
			if err := l.Verify(); err != nil {
				t.Fatal(err)
			}
			if err := l.Close(); err != nil {
				t.Fatal(err)
			}
			if v, err := l.Observation(); v != nil || err == nil {
				t.Fatal("closed lease returned metadata")
			}
			assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
			// Existing empty-only and normal writer entrypoints stay unchanged.
			if old, err := AcquireClosedInspection(ctx, root, scope, inspectionLimits); old != nil || err == nil {
				if old != nil {
					old.Close()
				}
				t.Fatal("nonempty preservation relaxed empty inspection")
			}
			if writer, err := New(ctx, root, inspectionLimits); writer != nil || !errors.Is(err, Refused) {
				t.Fatal("metadata restored writer authority", err)
			}
			assertNativeInspectionInventory(t, before, nativeInspectionInventory(t, root.Path))
		})
	}
}

func TestPreservationLeasePoisonsReplacementRelocationAndCancellation(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	for _, kind := range []string{"same-byte-replacement", "claim-change", "relocation", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			root, raw := nativeInspectionFixture(t, inspectionUnknownRecord(t))
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			l, err := AcquirePreservationInspection(ctx, root, scope, inspectionLimits)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
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
				if err := os.Rename(root.Path, root.Path+".retained"); err != nil {
					t.Fatal(err)
				}
			case "cancel":
				cancel()
			}
			if l.Verify() == nil {
				t.Fatal("changed snapshot qualified")
			}
			if value, err := l.Observation(); value != nil || err == nil {
				t.Fatal("failed original lease revived")
			}
			if err := l.Close(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type preservationLagContext struct {
	context.Context
	until time.Time
	calls atomic.Int32
}

func (c *preservationLagContext) Deadline() (time.Time, bool) { c.calls.Add(1); return c.until, true }

func TestPreservationLeaseCapturesOriginalAbsoluteDeadlineOnce(t *testing.T) {
	if !*preservationNative {
		t.Skip("requires explicit native inspection lane")
	}
	root, _ := nativeInspectionFixture(t, inspectionUnknownRecord(t))
	if l, err := AcquirePreservationInspection(context.Background(), root, scope, inspectionLimits); l != nil || err == nil {
		t.Fatal("unbounded context admitted")
	}
	ctx := &preservationLagContext{Context: context.Background(), until: time.Now().Add(250 * time.Millisecond)}
	l, err := AcquirePreservationInspection(ctx, root, scope, inspectionLimits)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	time.Sleep(time.Until(ctx.until) + time.Millisecond)
	if ctx.Err() != nil || ctx.calls.Load() != 1 || l.Verify() == nil {
		t.Fatal("original absolute deadline was renewed or timer lag accepted")
	}
	if v, err := l.Observation(); v != nil || err == nil {
		t.Fatal("expired lease returned observation")
	}
}

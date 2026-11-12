package access

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	stop "github.com/legrch/farol/modules/computer/domain/journal"
)

func TestStopAdmissionReservesCompletionBeforePublishing(t *testing.T) {
	f := fixtureState(t)
	next := stopStoreRequest(f, 31)
	history := stop.StopLedger{Entries: []stop.StopEntry{}}
	for n := 1; n <= 26; n++ {
		r := stopStoreRequest(f, n)
		r.Root = "/a"
		history.Entries = append(history.Entries, stop.StopEntry{Request: r, Phase: stop.StopRefusedBeforeDispatch, Refusal: "cancelled_before_dispatch"})
	}
	withAdmission, _, err := history.Begin(next)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := encodeStopLedger(testBinding, withAdmission)
	if err != nil {
		t.Fatal(err)
	}
	// Leave 100 bytes beyond admission: Stop intent fits, its original closure does not.
	remaining := stopLedgerMaxBytes - len(raw) - 100
	for i := range history.Entries {
		extra := remaining
		if extra > 4094 {
			extra = 4094
		}
		root := "/"
		left := extra + 1
		for left > 255 {
			part := 255
			if left == 256 {
				part = 254
			}
			root += strings.Repeat("a", part) + "/"
			left -= part + 1
		}
		root += strings.Repeat("a", left)
		history.Entries[i].Request.Root = root
		remaining -= extra
		if remaining == 0 {
			break
		}
	}
	if remaining != 0 {
		t.Fatal("fixture could not fill ledger")
	}
	withAdmission, _, err = history.Begin(next)
	if err != nil {
		t.Fatal(err)
	}
	raw, err = encodeStopLedger(testBinding, withAdmission)
	if err != nil || len(raw) != stopLedgerMaxBytes-100 {
		t.Fatal("admission fixture", len(raw), err)
	}
	withIntent := withAdmission.Clone()
	last := &withIntent.Entries[len(withIntent.Entries)-1]
	last.Phase = stop.StopEffectIntent
	if _, err := encodeStopLedger(testBinding, withIntent); err != nil {
		t.Fatal("Stop intent should fit", err)
	}
	last.Phase = stop.StopAcknowledged
	last.Closure = &stop.StopClosure{EffectID: next.StopEffectID, BackendGeneration: next.BackendGeneration, RuntimeID: next.RuntimeID, LifecycleID: next.BootUUID, StopRevision: "1", PreparationRevision: "0", ClosureOperationID: next.BootUUID, ClosureDigest: strings.Repeat("f", 64)}
	if !withIntent.Valid() {
		t.Fatal("invalid closure fixture")
	}
	if _, err := encodeStopLedger(testBinding, withIntent); err == nil {
		t.Fatal("fixture must exhaust capacity at original Stop ACK")
	}
	historyRaw, err := encodeStopLedger(testBinding, history)
	if err != nil {
		t.Fatal(err)
	}
	// Seed canonical retained history through the protected disk publication.
	if err := f.store.disk.markStopWitness(); err != nil {
		t.Fatal(err)
	}
	if err := f.store.disk.beginStopLedger(historyRaw); err != nil {
		t.Fatal(err)
	}
	store := restored(t, f)
	before, err := os.ReadFile(filepath.Join(f.root, stopLedgerName))
	if err != nil {
		t.Fatal(err)
	}
	_, admitted, err := store.BeginStop(context.Background(), next)
	if admitted || !errors.Is(err, stop.ErrStopCapacity) {
		t.Errorf("admitted unfinishable Stop: admitted=%v err=%v", admitted, err)
	}
	after, err := os.ReadFile(filepath.Join(f.root, stopLedgerName))
	if err != nil || string(before) != string(after) || store.activeStopID != "" {
		t.Error("capacity refusal published or granted an effect")
	}
	state, err := store.StopStatus(context.Background())
	if err != nil || state.Restricted || len(state.Ledger.Entries) != len(history.Entries) {
		t.Error("capacity refusal fenced existing history", err)
	}
}

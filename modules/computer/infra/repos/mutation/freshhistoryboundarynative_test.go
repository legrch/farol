//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
)

// Disposable native storage only. Reservations model retained history, not
// real processes or proof that an uncertain effect has settled.
func freshHistoryBoundaryFixture(t *testing.T, count int) (SettledSelection, []settledBytes) {
	t.Helper()
	_, _, scope, intent := processFixture()
	selection := SettledSelection{OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}
	entries := make([]settledBytes, 0, count)
	for n := 0; n < count; n++ {
		intent.OperationID = fmt.Sprintf("retained-boundary-%d", n)
		intent.Seal.Write = n == 0
		raw, err := encodeProcess(scope, intent)
		if err != nil {
			t.Fatal(err)
		}
		key, err := recordKey(processIdentity(scope, intent.OperationID))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	return selection, entries
}

func TestFreshHistoryOverOldLimitAllowsNewIndependentReservation(t *testing.T) {
	_, _, scope, intent := processFixture()
	selection := SettledSelection{OwnerID: scope.OwnerID, ProfileID: scope.Host.ProfileID, ComputerID: scope.ComputerID}
	entries := make([]settledBytes, 0, 129)
	for n := 0; n < 129; n++ {
		intent.OperationID = fmt.Sprintf("retained-read-%d", n)
		intent.Seal.Write = false
		raw, err := encodeProcess(scope, intent)
		if err != nil {
			t.Fatal(err)
		}
		key, err := recordKey(processIdentity(scope, intent.OperationID))
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, settledBytes{key: key, raw: raw})
	}
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	unknown, err := r.InspectFreshProcesses(context.Background(), selection)
	if err != nil || unknown {
		t.Fatalf("read-only history: unknown=%v err=%v", unknown, err)
	}
	if eligible, err := r.InspectStagingProcesses(context.Background(), selection); err == nil || eligible {
		t.Fatalf("staging must retain its original bounded policy: eligible=%v err=%v", eligible, err)
	}
	reservation, err := r.ConnectorProcessReservation(scope)
	if err != nil {
		t.Fatal(err)
	}
	intent.OperationID = "independent-new-read"
	out, err := reservation.Reserve(context.Background(), intent)
	if err != nil || out == nil || out.Status != processsvc.Reserved {
		t.Fatalf("fresh reservation: %+v %v", out, err)
	}
	unknown, err = r.InspectFreshProcesses(context.Background(), selection)
	if err != nil || unknown {
		t.Fatalf("history after new reservation: unknown=%v err=%v", unknown, err)
	}
	for _, entry := range entries {
		raw, err := os.ReadFile(filepath.Join(root.Path, "mutations", entry.key))
		if err != nil || !bytes.Equal(raw, entry.raw) {
			t.Fatal("retained record changed", err)
		}
	}
}

func TestFreshHistoryOverOldLimitPreservesUnknownAndReopens(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 129)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	for n := 0; n < 2; n++ {
		r, err := New(context.Background(), root)
		if err != nil {
			t.Fatal(err)
		}
		unknown, inspectErr := r.InspectFreshProcesses(context.Background(), selection)
		closeErr := r.Close()
		if inspectErr != nil || closeErr != nil || !unknown {
			t.Fatalf("reopen %d: unknown=%v inspect=%v close=%v", n, unknown, inspectErr, closeErr)
		}
		settledNativePreserved(t, root.Path, before)
	}
	for _, entry := range entries {
		raw, err := os.ReadFile(filepath.Join(root.Path, "mutations", entry.key))
		if err != nil || !bytes.Equal(raw, entry.raw) {
			t.Fatal("retained record changed", err)
		}
	}
}

func TestFreshHistoryPastOldBoundsPreservesRecords(t *testing.T) {
	for _, count := range []int{127, 128, 129, 257, 512, 513} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			selection, entries := freshHistoryBoundaryFixture(t, count)
			root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
			before := settledNativeSnapshot(t, root.Path)
			r, err := New(context.Background(), root)
			if err != nil {
				t.Fatal(err)
			}
			unknown, inspectErr := r.InspectFreshProcesses(context.Background(), selection)
			if closeErr := r.Close(); closeErr != nil {
				t.Fatal(closeErr)
			}
			if inspectErr != nil || !unknown {
				t.Fatalf("history: unknown=%v err=%v", unknown, inspectErr)
			}
			settledNativePreserved(t, root.Path, before)
		})
	}
}

func TestFreshHistoryLatePageReplacementRefuses(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 257)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	d, err := openNativeMode(root, false)
	if err != nil {
		t.Fatal(err)
	}
	defer d.close()
	o := &nativeSettledObservation{d: d, recordCount: len(entries), ctx: context.Background(), maxBytes: freshInventoryBytes}
	defer func() {
		for _, file := range o.files {
			_ = file.file.Close()
		}
	}()
	observed, err := o.inventory()
	if err != nil {
		t.Fatal(err)
	}
	last := observed[len(observed)-1]
	path := filepath.Join(root.Path, "mutations", last.key)
	replacement := filepath.Join(root.Path, "replacement")
	if err := os.WriteFile(replacement, last.raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	afterChange := settledNativeSnapshot(t, root.Path)
	if err := o.recheck(observed); err == nil {
		t.Fatal("same-byte late-page replacement was accepted")
	}
	settledNativePreserved(t, root.Path, afterChange)
}

func TestFreshHistoryCrossPageParentAndOutput(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 1024)
	result := terminalValue(bytes.Repeat([]byte("a"), processOutputChunkBytes+1), []byte("error"))
	result.Intent.OperationID = "cross-page-terminal"
	raw, chunks, err := encodeProcessTerminal(result)
	if err != nil {
		t.Fatal(err)
	}
	parent, err := recordKey(processIdentity(result.Scope, result.Intent.OperationID))
	if err != nil {
		t.Fatal(err)
	}
	entries = append(entries, settledBytes{key: parent, raw: raw})
	for _, chunk := range chunks {
		entries = append(entries, settledBytes{key: chunk.key, raw: chunk.raw})
	}
	keys := make([]string, 0, len(entries))
	for _, entry := range entries {
		keys = append(keys, entry.key)
	}
	sort.Strings(keys)
	first, last := sort.SearchStrings(keys, parent), sort.SearchStrings(keys, parent)
	for _, chunk := range chunks {
		position := sort.SearchStrings(keys, chunk.key)
		if position < first {
			first = position
		}
		if position > last {
			last = position
		}
	}
	if last-first < 256 {
		t.Fatal("fixture did not span a full inventory page")
	}
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := r.InspectFreshProcesses(context.Background(), selection)
	if err != nil || !unknown {
		t.Fatalf("cross-page history: unknown=%v err=%v", unknown, err)
	}
	settledNativePreserved(t, root.Path, before)
	chunkPath := filepath.Join(root.Path, "mutations", chunks[0].key)
	if err := os.WriteFile(chunkPath, []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	changed := settledNativeSnapshot(t, root.Path)
	if _, err := r.InspectFreshProcesses(context.Background(), selection); err == nil {
		t.Fatal("corrupt chunk was accepted")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	settledNativePreserved(t, root.Path, changed)
}

func TestFreshInventoryByteBudgetPreservesRecords(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 1)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	_, err = r.inspectProcessHistory(context.Background(), selection, 0, 1, qualifyFreshProcessHistory)
	if closeErr := r.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if err == nil {
		t.Fatal("inventory exceeding its byte budget was accepted")
	}
	settledNativePreserved(t, root.Path, before)
}

func TestFreshInventoryByteBudgetCumulativeBoundary(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 2)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	budget := int64(len(entries[0].raw) + len(entries[1].raw))
	if _, err := r.inspectProcessHistory(context.Background(), selection, 0, budget-1, qualifyFreshProcessHistory); err == nil {
		t.Fatal("under-budget inspection was accepted")
	}
	unknown, err := r.inspectProcessHistory(context.Background(), selection, 0, budget, qualifyFreshProcessHistory)
	if err != nil || !unknown {
		t.Fatalf("exact byte budget: unknown=%v err=%v", unknown, err)
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	settledNativePreserved(t, root.Path, before)
}

func TestFreshHistoryLateCancellationKeepsUnknown(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 129)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	unknown, inspectErr := r.inspectProcessHistory(ctx, selection, 0, freshInventoryBytes, func(entries []settledBytes, selection SettledSelection) (bool, error) {
		unknown, err := qualifyFreshProcessHistory(entries, selection)
		if err != nil || !unknown {
			t.Fatalf("fixture did not qualify original unknown: unknown=%v err=%v", unknown, err)
		}
		cancel()
		return unknown, nil
	})
	if closeErr := r.Close(); closeErr != nil {
		t.Fatal(closeErr)
	}
	if inspectErr == nil || !unknown {
		t.Fatalf("late cancellation lost UNKNOWN: unknown=%v err=%v", unknown, inspectErr)
	}
	settledNativePreserved(t, root.Path, before)
}

func TestFreshHistoryCancellationDuringCloseReleasesFilesAndKeepsLock(t *testing.T) {
	selection, entries := freshHistoryBoundaryFixture(t, 2)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	r, err := New(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	files := make([]settledFile, 0, len(entries))
	for _, entry := range entries {
		file, err := os.Open(filepath.Join(root.Path, "mutations", entry.key))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, settledFile{file: file})
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closed := 0
	err = closeFreshFiles(ctx, files, func(file *os.File) error {
		closed++
		if closed == 1 {
			cancel()
		}
		return file.Close()
	})
	if err == nil || closed != len(files) {
		t.Fatalf("cancelled close: closed=%d err=%v", closed, err)
	}
	for _, file := range files {
		if _, err := file.file.Stat(); err == nil {
			t.Fatal("file remained open")
		}
	}
	if other, err := New(context.Background(), root); err == nil {
		if other != nil {
			_ = other.Close()
		}
		t.Fatal("writer lock was released during record close")
	}
}

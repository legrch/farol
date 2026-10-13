//go:build darwin

package mutation

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestPreservedProcessResultsNativeRetainOutputAndWriterExclusion(t *testing.T) {
	selection, expected, entries := preservedResultFixture(t, true)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	before := settledNativeSnapshot(t, root.Path)
	calls := 0
	observed, err := InspectPreserved(context.Background(), root, selection, expected, func(meta PreservedInspection) error {
		calls++
		if len(meta.Retained) != len(entries) || meta.ReservedProcesses != 1 {
			t.Fatal("incomplete observation")
		}
		if writer, err := New(context.Background(), root); writer != nil || err == nil {
			t.Fatal("second writer admitted")
		}
		return nil
	})
	if err != nil || observed == nil || calls != 1 {
		t.Fatal("native inspection refused", err)
	}
	settledNativePreserved(t, root.Path, before)
}

func TestPreservedProcessResultsNativeRejectChunkChangeAfterVisitor(t *testing.T) {
	selection, expected, entries := preservedResultFixture(t, false)
	root, _, _, _ := settledNativeFixtureForRecords(t, selection, nil, entries)
	calls := 0
	observed, err := InspectPreserved(context.Background(), root, selection, expected, func(PreservedInspection) error {
		calls++
		selected := entries[len(entries)-1]
		return os.WriteFile(filepath.Join(root.Path, "mutations", selected.key), append(selected.raw, byte(' ')), 0600)
	})
	if err == nil || observed != nil || calls != 1 {
		t.Fatal("changed output was accepted")
	}
}

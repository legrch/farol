//go:build linux

package installcopy

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestOwnedDescriptorsClosedAfterNestedFailure(t *testing.T) {
	f := setup(t)
	if err := os.MkdirAll(filepath.Join(f.source, "a", "b", "c"), 0700); err != nil {
		t.Fatal(err)
	}
	put(t, filepath.Join(f.source, "a", "b", "c", "d"), "data", 0600)
	count := func() int {
		items, err := os.ReadDir("/proc/self/fd")
		if err != nil {
			t.Fatal(err)
		}
		return len(items)
	}
	before := count()
	op := f.prepare(t, nil)
	failure(t, op.run(context.Background(), limits{maxEntries, maxDepth, maxBytes}, hooks{fsync: func(int) error { return unix.EIO }}), "io", true, true)
	if after := count(); after != before {
		t.Fatalf("descriptor leak: %d -> %d", before, after)
	}
}

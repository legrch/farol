//go:build darwin

package boot

// AUTHOR ONLY until the Lead releases the exclusive native lane. Do not run
// while live09 is held for real12h. A later Lead may use a separately frozen
// boot test binary, exact -test.run '^TestNativeTaskReadScratchRetention$',
// -task-read-scratch-native, -task-read-scratch-native-parent=<trusted canonical
// app.getPath(temp)>, -test.count=1 -test.v -test.timeout=20s. Compilation is a
// separate CPU phase; the outer native execution budget is <=30s. Each owner
// has a 5s context, bounded inventories and exactly one allocation attempt.
// Timeout/failed/unknown AND successful roots stay retained. No automatic cleanup,
// TempDir, process, provider, app/build/package, installed profile or auth state.
// Exit/drain assertions below are explicit fixtures: no real client is launched.

import (
	"context"
	"encoding/binary"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"
)

var taskReadScratchNative = flag.Bool("task-read-scratch-native", false, "Run Lead-owned fresh Darwin scratch retention fixtures")
var taskReadScratchNativeParent = flag.String("task-read-scratch-native-parent", "", "Explicit trusted canonical app.getPath(temp) parent; never HOME or cwd")

// CPU-only decoder checks, despite co-location with the Darwin fixture authoring.
// All buffers are synthetic. This test performs no native filesystem operation.
func TestTaskReadScratchCPUDarwinInventoryDecode(t *testing.T) {
	const (
		ino  = int(unsafe.Offsetof(unix.Dirent{}.Ino))
		rec  = int(unsafe.Offsetof(unix.Dirent{}.Reclen))
		nam  = int(unsafe.Offsetof(unix.Dirent{}.Namlen))
		name = int(unsafe.Offsetof(unix.Dirent{}.Name))
	)
	entry := func(n string) []byte {
		b := make([]byte, (name+len(n)+1+7)&^7)
		binary.NativeEndian.PutUint64(b[ino:ino+8], 7)
		binary.NativeEndian.PutUint16(b[rec:rec+2], uint16(len(b)))
		binary.NativeEndian.PutUint16(b[nam:nam+2], uint16(len(n)))
		copy(b[name:], n)
		return b
	}
	for _, buf := range [][]byte{nil, entry("."), entry(".."), append(entry("."), entry("..")...)} {
		if e := taskScratchDarwinDirents(buf); e != nil {
			t.Fatal(e)
		}
	}
	if e := taskScratchDarwinDirents(entry("unexpected")); !errors.Is(e, TaskReadScratchNonEmpty) {
		t.Fatal(e)
	}
	for _, kind := range []string{"truncated", "zero-record", "zero-inode", "oversized-record", "name-overflow", "missing-nul"} {
		t.Run(kind, func(t *testing.T) {
			b := entry(".")
			switch kind {
			case "truncated":
				b = b[:name]
			case "zero-record":
				binary.NativeEndian.PutUint16(b[rec:rec+2], 0)
			case "zero-inode":
				binary.NativeEndian.PutUint64(b[ino:ino+8], 0)
			case "oversized-record":
				binary.NativeEndian.PutUint16(b[rec:rec+2], uint16(len(b)+1))
			case "name-overflow":
				binary.NativeEndian.PutUint16(b[nam:nam+2], 256)
			case "missing-nul":
				b[name+1] = 'x'
			}
			if e := taskScratchDarwinDirents(b); !errors.Is(e, TaskReadScratchUnavailable) {
				t.Fatal(e)
			}
		})
	}
}

func TestNativeTaskReadScratchRetention(t *testing.T) {
	// This flag-only branch is the ONLY ordinary Go test execution authorized.
	if !*taskReadScratchNative {
		t.Skip("Requires exclusive Lead lane and explicit native scratch flags")
	}
	if !validProfilePath(*taskReadScratchNativeParent) {
		t.Fatal("missing trusted canonical native parent; no fallback")
	}
	for _, kind := range []string{"empty", "unexpected-content", "changed-mode", "cancelled-observation"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			q := NewTaskReadScratch(*taskReadScratchNativeParent)
			closed := false
			// All fixture consumers are synchronous. With no launched client or
			// handlers, both original joins are separately known fixture facts.
			joins := TaskReadScratchJoined{OriginalClientExit: true, ReadHandlersDrained: true}
			t.Cleanup(func() {
				if !closed {
					closed = true
					r, e := q.Close(context.Background(), joins)
					t.Logf("Retained failed/unknown artifact: %+v", r)
					if e != nil {
						t.Errorf("one-shot original descriptor close: %v", e)
					}
				}
			})
			root, err := q.Open(ctx)
			if err != nil {
				t.Fatal("one-shot qualification; artifact retained", err)
			}
			t.Logf("Fresh scratch retained regardless of outcome: %+v", root)
			var original unix.Stat_t
			if e := unix.Lstat(root.Path, &original); e != nil || profileStat(original).device != root.Device || original.Ino != root.Inode || original.Uid != root.OwnerUID || uint32(original.Mode)&07777 != 0700 {
				t.Fatal("native scratch identity/mode observation failed", e)
			}
			var expected TaskReadScratchCode
			switch kind {
			case "unexpected-content":
				// A single explicitly owned marker is preserved, including any
				// partial write or failed/unknown close. Never replace or retry.
				f, e := os.OpenFile(filepath.Join(root.Path, "retained-fixture-marker"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
				if e != nil {
					t.Fatal(e)
				}
				_, writeErr := f.WriteString("Disposable retention fixture; no provider state.\n")
				if e := errors.Join(writeErr, f.Close()); e != nil {
					t.Fatal("marker effect retained", e)
				}
				expected = TaskReadScratchNonEmpty
			case "changed-mode":
				if e := unix.Chmod(root.Path, 0500); e != nil {
					t.Fatal("changed-mode fixture retained", e)
				}
				expected = TaskReadScratchChanged
			case "cancelled-observation":
				cancel()
				expected = TaskReadScratchUnavailable
			}
			closed = true
			r, err := q.Close(ctx, joins)
			t.Logf("Final retained original artifact and descriptor result: %+v", r)
			if expected == "" {
				if err != nil {
					t.Fatal(err)
				}
			} else if !errors.Is(err, expected) {
				t.Fatalf("expected %s, got %v", expected, err)
			}
			if !r.Released || r.Child != root || r.Observation != expected {
				t.Fatal("original descriptor release not confirmed", r, err)
			}
			var retained unix.Stat_t
			if e := unix.Lstat(root.Path, &retained); e != nil || retained.Ino != original.Ino || retained.Dev != original.Dev {
				t.Fatal("original artifact not retained", e)
			}
			r2, e2 := q.Close(context.Background(), joins)
			if r2 != r || e2 != err {
				t.Fatal("one-shot close result changed")
			}
		})
	}
}

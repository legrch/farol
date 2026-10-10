//go:build darwin

package mutation_test

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	repository "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

// Actual disposable filesystem/lock checks only. Inspection creates no writer,
// successor, execution permission or recovery receipt and launches no process.
func TestNativeMutationInspectionExistingClosedStore(t *testing.T) {
	root, _, _ := nativeProcessFixture(t)
	r := openProcessRepository(t, root)
	if got, err := repository.InspectEmpty(context.Background(), root); err == nil || got != nil {
		t.Fatal("inspection accepted a live writer", got)
	}
	if err := repository.WithClosedEmptyInspection(context.Background(), root, func(repository.EmptyInspection) error {
		t.Fatal("live writer reached visitor")
		return nil
	}); err == nil {
		t.Fatal("closed inspection accepted a live writer")
	}
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	lock := filepath.Join(root.Path, ".mutation-writer.lock")
	before, err := os.Lstat(lock)
	if err != nil {
		t.Fatal(err)
	}
	out, err := repository.InspectEmpty(context.Background(), root)
	if err != nil || out == nil || out.Root != root || out.MutationsDevice != root.Device || out.MutationsInode == 0 || out.LockDevice != root.Device || out.LockInode == 0 {
		t.Fatal("closed existing store not inspected", out, err)
	}
	after, err := os.Lstat(lock)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || before.Mode() != after.Mode() || !before.ModTime().Equal(after.ModTime()) {
		t.Fatal("inspection changed writer lock", err)
	}
	entries, err := os.ReadDir(filepath.Join(root.Path, "mutations"))
	if err != nil || len(entries) != 0 {
		t.Fatal("inspection created mutation state", err)
	}
	next, err := repository.New(context.Background(), root)
	if err != nil {
		t.Fatal("inspection retained the writer lock", err)
	}
	if err := next.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestNativeMutationInspectionNeverCreatesOrRepairs(t *testing.T) {
	for _, scenario := range []string{"missing-lock", "wrong-mode", "lock-symlink", "lock-hardlink", "lock-fifo", "nonempty-lock", "record", "staging", "directory", "entry-fifo", "entry-symlink"} {
		t.Run(scenario, func(t *testing.T) {
			root, _, _ := nativeProcessFixture(t)
			lock := filepath.Join(root.Path, ".mutation-writer.lock")
			if scenario != "missing-lock" {
				r := openProcessRepository(t, root)
				if err := r.Close(); err != nil {
					t.Fatal(err)
				}
			}
			var err error
			switch scenario {
			case "wrong-mode":
				err = os.Chmod(lock, 0644)
			case "lock-symlink":
				moved := filepath.Join(root.Path, "original-lock")
				if err = os.Rename(lock, moved); err == nil {
					err = os.Symlink(moved, lock)
				}
			case "lock-hardlink":
				err = os.Link(lock, filepath.Join(root.Path, "lock-alias"))
			case "lock-fifo":
				if err = os.Rename(lock, filepath.Join(root.Path, "original-lock")); err == nil {
					err = unix.Mkfifo(lock, 0600)
				}
			case "nonempty-lock":
				err = os.WriteFile(lock, []byte("unknown"), 0600)
			case "record", "staging":
				name := "record.json"
				if scenario == "staging" {
					name = ".unknown.tmp"
				}
				err = os.WriteFile(filepath.Join(root.Path, "mutations", name), []byte("retained"), 0600)
			case "directory":
				err = os.Mkdir(filepath.Join(root.Path, "mutations", "unknown"), 0700)
			case "entry-fifo":
				err = unix.Mkfifo(filepath.Join(root.Path, "mutations", "unknown"), 0600)
			case "entry-symlink":
				err = os.Symlink(lock, filepath.Join(root.Path, "mutations", "unknown"))
			}
			if err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadDir(filepath.Join(root.Path, "mutations"))
			if err != nil {
				t.Fatal(err)
			}
			if out, err := repository.InspectEmpty(context.Background(), root); err == nil || out != nil {
				t.Fatal("unsafe or nonempty store inspected", out)
			}
			if err := repository.WithClosedEmptyInspection(context.Background(), root, func(repository.EmptyInspection) error {
				t.Fatal("unsafe or nonempty store reached visitor")
				return nil
			}); err == nil {
				t.Fatal("unsafe or nonempty store accepted by closed inspection")
			}
			after, err := os.ReadDir(filepath.Join(root.Path, "mutations"))
			if err != nil || len(before) != len(after) {
				t.Fatal("inspection changed inventory", err)
			}
			for i := range before {
				if before[i].Name() != after[i].Name() {
					t.Fatal("inspection replaced inventory")
				}
			}
			if scenario == "missing-lock" {
				if _, err := os.Lstat(lock); !os.IsNotExist(err) {
					t.Fatal("inspection created missing writer lock", err)
				}
			}
		})
	}
}

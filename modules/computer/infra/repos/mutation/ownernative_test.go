//go:build darwin

package mutation

import (
	"bytes"
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

var ownerInspectionNative = flag.Bool("owner-inspection-native", false, "run retained disposable owner inspection filesystem fixtures")

// Actual disposable storage, synthetic canonical records. No production reads,
// app publications, execution, ACK, original process closure or successor proof.
// Keep every fixture, including failures and uncertainty, for Lead inspection.
func ownerNativeFixture(t *testing.T, count int) (string, Root, OwnerSelection, []ExpectedOwnerRecord, []settledBytes) {
	t.Helper()
	if !*ownerInspectionNative {
		t.Skip("requires -owner-inspection-native")
	}
	selection, expected, entries := ownerInspectionFixture(t, count)
	base, err := os.MkdirTemp("/private/tmp", "farol-owner-inspection-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("retained disposable fixture:", base)
	ownerNativeMust(t, os.WriteFile(filepath.Join(base, "fixture.txt"), []byte(t.Name()+"\n"), 0600))
	path := filepath.Join(base, "root")
	ownerNativeMust(t, os.Mkdir(path, 0700))
	ownerNativeMust(t, os.Mkdir(filepath.Join(path, "mutations"), 0700))
	ownerNativeMust(t, os.WriteFile(filepath.Join(path, writerName), nil, 0600))
	for _, entry := range entries {
		ownerNativeMust(t, os.WriteFile(filepath.Join(path, "mutations", entry.key), entry.raw, 0600))
	}
	var stat unix.Stat_t
	ownerNativeMust(t, unix.Lstat(path, &stat))
	root := Root{Path: path, Device: uint64(stat.Dev), Inode: stat.Ino, OwnerUID: stat.Uid}
	return base, root, selection, expected, entries
}

func ownerNativeMust(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func ownerNativeLock(t *testing.T, root Root, held bool) {
	t.Helper()
	fd, err := unix.Open(filepath.Join(root.Path, writerName), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	ownerNativeMust(t, err)
	err = unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	closeErr := unix.Close(fd)
	ownerNativeMust(t, closeErr)
	if held {
		if err != unix.EWOULDBLOCK {
			t.Fatal("original exclusive lock was not retained", err)
		}
	} else if err != nil {
		t.Fatal("inspection leaked lock", err)
	}
}

type ownerNativeProbe struct {
	settledObservation
	t      *testing.T
	root   Root
	checks int
}

func (p *ownerNativeProbe) recheck(entries []settledBytes) error {
	p.checks++
	ownerNativeLock(p.t, p.root, true)
	err := p.settledObservation.recheck(entries)
	ownerNativeLock(p.t, p.root, true)
	return err
}

func TestOwnerInspectionNativeBoundsLockAndCopies(t *testing.T) {
	for _, count := range []int{1, 2, 5, 128} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			base, root, selection, expected, _ := ownerNativeFixture(t, count)
			before := settledNativeSnapshot(t, base)
			visits := 0
			out, err := InspectOwnerCompleted(ownerTestContext(t), root, selection, expected, func(meta OwnerInspection) error {
				visits++
				ownerNativeLock(t, root, true)
				if meta.Root != root || meta.MutationsDevice == 0 || meta.MutationsInode == 0 || meta.LockDevice == 0 || meta.LockInode == 0 || len(meta.Retained) != count {
					t.Fatal("invalid historical metadata")
				}
				nested, err := InspectOwnerCompleted(ownerTestContext(t), root, selection, expected, func(OwnerInspection) error { t.Fatal("nested visitor acquired lock"); return nil })
				if nested != nil || err == nil {
					t.Fatal("nested inspection accepted")
				}
				expected[0] = ExpectedOwnerRecord{}
				meta.Retained[0] = OwnerRetainedRecord{}
				return nil
			})
			if err != nil || out == nil || visits != 1 || out.Retained[0].Key == "" {
				t.Fatal(out, err, visits)
			}
			ownerNativeLock(t, root, false)
			settledNativePreserved(t, base, before)
		})
	}
}

func TestOwnerInspectionNativeLockThroughFinalChecks(t *testing.T) {
	base, root, selection, expected, _ := ownerNativeFixture(t, 2)
	before := settledNativeSnapshot(t, base)
	closed, err := selectOwner(selection, expected)
	ownerNativeMust(t, err)
	ctx := ownerTestContext(t)
	sentinel := errors.New("trusted callback error")
	var probe *ownerNativeProbe
	err = inspectBoundedNative(ctx, root, len(closed), func(o settledObservation) error {
		probe = &ownerNativeProbe{settledObservation: o, t: t, root: root}
		out, err := observeOwnerCompleted(ctx, closed, probe, func(OwnerInspection) error { ownerNativeLock(t, root, true); return sentinel })
		if out != nil {
			t.Fatal("partial callback result")
		}
		return err
	})
	if !errors.Is(err, sentinel) || probe == nil || probe.checks != 2 {
		t.Fatal("final lock check or callback error lost", err, probe)
	}
	ownerNativeLock(t, root, false)
	settledNativePreserved(t, base, before)
}

func TestOwnerInspectionNativeRefusalsPreserveEvidence(t *testing.T) {
	for _, name := range []string{"busy-lock", "missing-lock", "nonempty-lock", "record-mode", "record-symlink", "record-hardlink", "extra-record", "staging", "missing-record", "changed-bytes", "root-mismatch", "cancelled", "missing-deadline", "timer-lag-expired", "129-records"} {
		t.Run(name, func(t *testing.T) {
			base, root, selection, expected, entries := ownerNativeFixture(t, 2)
			path := filepath.Join(root.Path, "mutations", entries[0].key)
			lock := filepath.Join(root.Path, writerName)
			ctx, cancel := context.WithCancel(ownerTestContext(t))
			defer cancel()
			var current context.Context = ctx
			switch name {
			case "busy-lock":
				fd, err := unix.Open(lock, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
				ownerNativeMust(t, err)
				defer func() { ownerNativeMust(t, unix.Close(fd)) }()
				ownerNativeMust(t, unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB))
			case "missing-lock":
				ownerNativeMust(t, os.Rename(lock, filepath.Join(base, "retained-lock")))
			case "nonempty-lock":
				ownerNativeMust(t, os.WriteFile(lock, []byte("retained unknown fence"), 0600))
			case "record-mode":
				ownerNativeMust(t, os.Chmod(path, 0644))
			case "record-symlink":
				ownerNativeMust(t, os.Rename(path, filepath.Join(base, "retained-record")))
				ownerNativeMust(t, os.Symlink(filepath.Join(base, "retained-record"), path))
			case "record-hardlink":
				ownerNativeMust(t, os.Link(path, filepath.Join(base, "retained-alias")))
			case "extra-record":
				ownerNativeMust(t, os.WriteFile(filepath.Join(root.Path, "mutations", "extra.json"), []byte("retained"), 0600))
			case "staging":
				ownerNativeMust(t, os.WriteFile(filepath.Join(root.Path, "mutations", ".unknown.tmp"), []byte("retained"), 0600))
			case "missing-record":
				ownerNativeMust(t, os.Rename(path, filepath.Join(base, "retained-record")))
			case "changed-bytes":
				ownerNativeMust(t, os.WriteFile(path, bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1), 0600))
			case "root-mismatch":
				root.Inode++
			case "cancelled":
				cancel()
			case "missing-deadline":
				current = context.Background()
			case "timer-lag-expired":
				current = &ownerLagContext{Context: context.Background(), deadline: time.Now().Add(-time.Second)}
			case "129-records":
				for n := 0; n < 127; n++ {
					ownerNativeMust(t, os.WriteFile(filepath.Join(root.Path, "mutations", fmt.Sprintf("%064x.json", n)), []byte("retained"), 0600))
				}
			}
			before := settledNativeSnapshot(t, base)
			visits := 0
			out, err := InspectOwnerCompleted(current, root, selection, expected, func(OwnerInspection) error { visits++; return nil })
			if out != nil || err == nil || visits != 0 {
				t.Fatal("unsafe store reached visitor", out, err, visits)
			}
			settledNativePreserved(t, base, before)
		})
	}
}

func TestOwnerInspectionNativeFinalChangesAndLateVisitors(t *testing.T) {
	for _, name := range []string{"bytes", "same-bytes-new-inode", "extra", "relocated-root", "relocated-directory", "replaced-lock", "metadata", "cancel", "late-expiry", "visitor-error"} {
		t.Run(name, func(t *testing.T) {
			base, root, selection, expected, entries := ownerNativeFixture(t, 2)
			parent, cancel := context.WithCancel(context.Background())
			defer cancel()
			deadline := time.Now().Add(time.Hour)
			if name == "late-expiry" {
				deadline = time.Now().Add(500 * time.Millisecond)
			}
			lag := &ownerLagContext{Context: parent, deadline: deadline}
			sentinel := errors.New("trusted read-only visitor error")
			var before map[string]settledNativeOriginal
			visits := 0
			out, err := InspectOwnerCompleted(lag, root, selection, expected, func(OwnerInspection) error {
				visits++
				// The test intentionally violates the visitor contract to model
				// same-UID substitutions. The inspector must refuse and retain them.
				path := filepath.Join(root.Path, "mutations", entries[0].key)
				switch name {
				case "bytes":
					ownerNativeMust(t, os.WriteFile(path, bytes.Replace(entries[0].raw, []byte(`"bytes":12`), []byte(`"bytes":13`), 1), 0600))
				case "same-bytes-new-inode":
					ownerNativeMust(t, os.Rename(path, filepath.Join(base, "retained-record")))
					ownerNativeMust(t, os.WriteFile(path, entries[0].raw, 0600))
				case "extra":
					ownerNativeMust(t, os.WriteFile(filepath.Join(root.Path, "mutations", ".retained.tmp"), []byte("unknown"), 0600))
				case "relocated-root":
					ownerNativeMust(t, os.Rename(root.Path, filepath.Join(base, "retained-root")))
					ownerNativeMust(t, os.Mkdir(root.Path, 0700))
				case "relocated-directory":
					ownerNativeMust(t, os.Rename(filepath.Join(root.Path, "mutations"), filepath.Join(base, "retained-mutations")))
					ownerNativeMust(t, os.Mkdir(filepath.Join(root.Path, "mutations"), 0700))
				case "replaced-lock":
					ownerNativeMust(t, os.Rename(filepath.Join(root.Path, writerName), filepath.Join(base, "retained-lock")))
					ownerNativeMust(t, os.WriteFile(filepath.Join(root.Path, writerName), nil, 0600))
				case "metadata":
					ownerNativeMust(t, os.Chmod(path, 0400))
				case "cancel":
					cancel()
				case "late-expiry":
					time.Sleep(time.Until(deadline) + time.Millisecond)
				}
				before = settledNativeSnapshot(t, base)
				if name == "visitor-error" || name == "cancel" || name == "bytes" {
					return sentinel
				}
				return nil
			})
			if err == nil || out != nil || visits != 1 {
				t.Fatal("late/changed observation accepted", out, err, visits)
			}
			if errors.Is(err, sentinel) != (name == "visitor-error") {
				t.Fatal("recheck/cancel did not take precedence", err)
			}
			if lag.calls != 1 {
				t.Fatal("deadline renewed", lag.calls)
			}
			settledNativePreserved(t, base, before)
			if name == "cancel" || name == "late-expiry" || name == "visitor-error" {
				// Refusal did not poison/fence/repair the original records or lock.
				again, err := InspectOwnerCompleted(ownerTestContext(t), root, selection, expected, func(OwnerInspection) error { return nil })
				if err != nil || again == nil {
					t.Fatal("read-only refusal fenced existing store", err)
				}
				settledNativePreserved(t, base, before)
			}
		})
	}
}

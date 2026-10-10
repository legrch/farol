//go:build darwin

package mutation_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	repository "github.com/legrch/farol/modules/computer/infra/repos/mutation"
	"golang.org/x/sys/unix"
)

// These checks use real Darwin locks and disposable directories only. They do
// not qualify installed-profile maintenance, recovery, providers or execution.
func closedEmptyFixture(t *testing.T) (repository.Root, string) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(base, "root")
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(path, "mutations"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, ".mutation-writer.lock"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	var root unix.Stat_t
	if err := unix.Lstat(path, &root); err != nil {
		t.Fatal(err)
	}
	return repository.Root{Path: path, Device: uint64(root.Dev), Inode: root.Ino, OwnerUID: uint32(os.Geteuid())}, base
}

type closedInspectionVersion struct {
	device            int32
	inode             uint64
	mode              uint16
	uid, gid          uint32
	links             uint16
	size              int64
	modified, changed unix.Timespec
}

// Reads may change access times; compare the identity, permissions and content
// versions instead. Walk never follows aliases or opens FIFOs/unknown entries.
func closedInspectionSnapshot(t *testing.T, base string) map[string]closedInspectionVersion {
	t.Helper()
	versions := make(map[string]closedInspectionVersion)
	err := filepath.WalkDir(base, func(path string, _ os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			return err
		}
		versions[path] = closedInspectionVersion{s.Dev, s.Ino, s.Mode, s.Uid, s.Gid, s.Nlink, s.Size, s.Mtim, s.Ctim}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return versions
}

func closedInspectionLockProbe(root repository.Root, wantHeld bool) error {
	fd, err := unix.Open(filepath.Join(root.Path, ".mutation-writer.lock"), unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	lockErr := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB)
	closeErr := unix.Close(fd)
	if closeErr != nil {
		return closeErr
	}
	if wantHeld {
		if !errors.Is(lockErr, unix.EWOULDBLOCK) {
			return errors.New("visitor did not retain exclusive writer lock")
		}
		return nil
	}
	return lockErr
}

func requireClosedInspectionRefusal(t *testing.T, err error) {
	t.Helper()
	var refusal *repository.Failure
	if !errors.As(err, &refusal) || refusal.Code != "COMPUTER_MUTATION_STORE_UNAVAILABLE" {
		t.Fatal("expected closed-store recheck refusal", err)
	}
}

func TestNativeClosedEmptyInspectionRetainsLockAndLeavesStateUnchanged(t *testing.T) {
	root, base := closedEmptyFixture(t)
	before := closedInspectionSnapshot(t, base)
	calls := 0
	err := repository.WithClosedEmptyInspection(context.Background(), root, func(got repository.EmptyInspection) error {
		calls++
		if got.Root != root || got.MutationsDevice != root.Device || got.LockDevice != root.Device || got.MutationsInode == 0 || got.LockInode == 0 {
			return errors.New("visitor received incomplete physical identities")
		}
		var mutations, lock unix.Stat_t
		if err := unix.Lstat(filepath.Join(root.Path, "mutations"), &mutations); err != nil {
			return err
		}
		if err := unix.Lstat(filepath.Join(root.Path, ".mutation-writer.lock"), &lock); err != nil {
			return err
		}
		if got.MutationsInode != mutations.Ino || got.LockInode != lock.Ino {
			return errors.New("visitor received the wrong pinned identities")
		}
		if err := closedInspectionLockProbe(root, true); err != nil {
			return err
		}
		if out, err := repository.InspectEmpty(context.Background(), root); err == nil || out != nil {
			return errors.New("nested inspection bypassed retained writer lock")
		}
		nestedCalled := false
		if err := repository.WithClosedEmptyInspection(context.Background(), root, func(repository.EmptyInspection) error {
			nestedCalled = true
			return errors.New("nested visitor must not run")
		}); err == nil || nestedCalled {
			return errors.New("nested closed inspection bypassed retained writer lock")
		}
		return nil
	})
	if err != nil || calls != 1 {
		t.Fatal("closed visitor failed", calls, err)
	}
	if !reflect.DeepEqual(before, closedInspectionSnapshot(t, base)) {
		t.Fatal("inspection modified disposable state")
	}
	if err := closedInspectionLockProbe(root, false); err != nil {
		t.Fatal("inspection retained lock after return", err)
	}
}

func TestNativeClosedEmptyInspectionRejectsVisitorNamespaceChanges(t *testing.T) {
	for _, scenario := range []string{
		"record", "staging", "entry-directory", "entry-fifo", "entry-symlink", "transient-entry",
		"directory-replacement", "directory-symlink", "directory-mode",
		"lock-replacement", "lock-symlink", "lock-hardlink", "lock-fifo", "lock-directory", "lock-mode", "lock-content", "missing-lock",
		"root-replacement", "root-symlink", "root-mode", "root-entry",
	} {
		t.Run(scenario, func(t *testing.T) {
			root, base := closedEmptyFixture(t)
			mutations := filepath.Join(root.Path, "mutations")
			lock := filepath.Join(root.Path, ".mutation-writer.lock")
			var changed map[string]closedInspectionVersion
			err := repository.WithClosedEmptyInspection(context.Background(), root, func(repository.EmptyInspection) error {
				var changeErr error
				switch scenario {
				case "record", "staging", "transient-entry":
					name := "record.json"
					if scenario == "staging" {
						name = ".pending.tmp"
					}
					entry := filepath.Join(mutations, name)
					changeErr = os.WriteFile(entry, []byte("unknown retained bytes"), 0600)
					if changeErr == nil && scenario == "transient-entry" {
						changeErr = os.Remove(entry)
					}
				case "entry-directory":
					changeErr = os.Mkdir(filepath.Join(mutations, "unknown"), 0700)
				case "entry-fifo":
					changeErr = unix.Mkfifo(filepath.Join(mutations, "unknown"), 0600)
				case "entry-symlink":
					changeErr = os.Symlink(lock, filepath.Join(mutations, "unknown"))
				case "directory-replacement", "directory-symlink":
					moved := filepath.Join(root.Path, "original-mutations")
					changeErr = os.Rename(mutations, moved)
					if changeErr == nil {
						if scenario == "directory-symlink" {
							changeErr = os.Symlink(moved, mutations)
						} else {
							changeErr = os.Mkdir(mutations, 0700)
						}
					}
				case "directory-mode":
					changeErr = os.Chmod(mutations, 0755)
				case "lock-replacement", "lock-symlink", "lock-fifo", "lock-directory", "missing-lock":
					moved := filepath.Join(root.Path, "original-lock")
					changeErr = os.Rename(lock, moved)
					if changeErr == nil {
						switch scenario {
						case "lock-replacement":
							changeErr = os.WriteFile(lock, nil, 0600)
						case "lock-symlink":
							changeErr = os.Symlink(moved, lock)
						case "lock-fifo":
							changeErr = unix.Mkfifo(lock, 0600)
						case "lock-directory":
							changeErr = os.Mkdir(lock, 0700)
						}
					}
				case "lock-hardlink":
					changeErr = os.Link(lock, filepath.Join(base, "lock-alias"))
				case "lock-mode":
					changeErr = os.Chmod(lock, 0644)
				case "lock-content":
					changeErr = os.WriteFile(lock, []byte("unknown"), 0600)
				case "root-replacement", "root-symlink":
					moved := filepath.Join(base, "original-root")
					changeErr = os.Rename(root.Path, moved)
					if changeErr == nil {
						if scenario == "root-symlink" {
							changeErr = os.Symlink(moved, root.Path)
						} else {
							changeErr = os.Mkdir(root.Path, 0700)
						}
					}
				case "root-mode":
					changeErr = os.Chmod(root.Path, 0755)
				case "root-entry":
					changeErr = os.WriteFile(filepath.Join(root.Path, "unknown"), nil, 0600)
				}
				if changeErr != nil {
					t.Fatal(changeErr)
				}
				changed = closedInspectionSnapshot(t, base)
				return nil
			})
			requireClosedInspectionRefusal(t, err)
			if !reflect.DeepEqual(changed, closedInspectionSnapshot(t, base)) {
				t.Fatal("failed inspection modified the changed namespace")
			}
		})
	}
}

func TestNativeClosedEmptyInspectionVisitorErrorStillRechecks(t *testing.T) {
	visitorErr := errors.New("trusted visitor failed")
	for _, mutate := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged", true: "changed"}[mutate], func(t *testing.T) {
			root, base := closedEmptyFixture(t)
			var before map[string]closedInspectionVersion
			err := repository.WithClosedEmptyInspection(context.Background(), root, func(repository.EmptyInspection) error {
				if mutate {
					if err := os.WriteFile(filepath.Join(root.Path, "mutations", "late.json"), []byte("retained"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				before = closedInspectionSnapshot(t, base)
				return visitorErr
			})
			if mutate {
				requireClosedInspectionRefusal(t, err)
			} else if err != visitorErr {
				t.Fatal("unchanged inspection lost visitor error", err)
			}
			if !reflect.DeepEqual(before, closedInspectionSnapshot(t, base)) {
				t.Fatal("visitor error caused inspection to modify state")
			}
			if err := closedInspectionLockProbe(root, false); err != nil {
				t.Fatal("visitor error leaked writer lock", err)
			}
		})
	}
}

func TestNativeClosedEmptyInspectionCancellationWaitsForLateVisitor(t *testing.T) {
	for _, mutate := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged", true: "late-entry"}[mutate], func(t *testing.T) {
			root, base := closedEmptyFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			entered, release := make(chan struct{}), make(chan struct{})
			defer func() {
				select {
				case <-release:
				default:
					close(release)
				}
			}()
			result := make(chan error, 1)
			go func() {
				result <- repository.WithClosedEmptyInspection(ctx, root, func(repository.EmptyInspection) error {
					close(entered)
					<-release
					return errors.New("late trusted visitor error")
				})
			}()
			select {
			case <-entered:
			case err := <-result:
				t.Fatal("inspection failed before visitor", err)
			case <-time.After(5 * time.Second):
				t.Fatal("visitor was not entered")
			}
			cancel()
			if err := closedInspectionLockProbe(root, true); err != nil {
				t.Fatal("cancellation released lock before visitor returned", err)
			}
			select {
			case err := <-result:
				t.Fatal("inspection returned while visitor was still running", err)
			default:
			}
			if mutate {
				if err := os.WriteFile(filepath.Join(root.Path, "mutations", "late.json"), []byte("retained"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := closedInspectionSnapshot(t, base)
			close(release)
			select {
			case err := <-result:
				requireClosedInspectionRefusal(t, err)
			case <-time.After(5 * time.Second):
				t.Fatal("late visitor did not finish inspection")
			}
			if !reflect.DeepEqual(before, closedInspectionSnapshot(t, base)) {
				t.Fatal("cancelled inspection modified state")
			}
			if err := closedInspectionLockProbe(root, false); err != nil {
				t.Fatal("cancelled inspection leaked writer lock", err)
			}
		})
	}
}

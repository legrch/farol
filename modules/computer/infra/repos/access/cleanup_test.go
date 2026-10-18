package access

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"golang.org/x/sys/unix"
)

// This injects a symbolic sync receipt error on disposable state. It does not
// reproduce a physical OS sync/close refusal or an installed incident.
func TestConstructorRetainsRestoreSyncCause(t *testing.T) {
	f := fixtureState(t)
	if err := f.store.Close(); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("symbolic restore sync receipt")
	factory := func(root string) (*disk, error) {
		d, err := openDisk(root)
		if err == nil {
			d.syncSnapshot = func(int) error { return cause }
		}
		return d, err
	}
	owner, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
	if owner != nil {
		owner.Close()
		t.Fatal("failed restore returned an owner")
	}
	if !OutcomeUnknown(err) {
		t.Fatal("restore lost existing publication uncertainty")
	}
	if !errors.Is(err, cause) {
		t.Fatal("restore discarded the original sync cause")
	}
}

// All lost-close fixtures below first close exactly the supplied disposable
// owner and then inject a receipt error. They do not simulate physical OS Close
// refusal, resource exhaustion, or the field incident. There is no FD sweep,
// process limit change, alternate native engine, or production profile access.
type lostCloseReceipt struct{ owner string }

func (*lostCloseReceipt) Error() string { return "private symbolic native close diagnostic" }

type closeProbe struct {
	t           *testing.T
	fds         []int
	files       map[*os.File]int
	fileCalls   int
	fileFaultAt int
	fileCause   error
	fdCauses    []error
	afterFD     func(int)
}

func newCloseProbe(t *testing.T) *closeProbe {
	return &closeProbe{t: t, files: make(map[*os.File]int)}
}
func (p *closeProbe) hooks() nativeCleanup {
	return nativeCleanup{
		closeFD: func(fd int) error {
			p.fds = append(p.fds, fd)
			if err := unix.Close(fd); err != nil {
				p.t.Fatal("closing the exact disposable descriptor failed")
			}
			if p.afterFD != nil {
				p.afterFD(fd)
			}
			if len(p.fds) <= len(p.fdCauses) {
				return p.fdCauses[len(p.fds)-1]
			}
			return nil
		},
		closeFile: func(file *os.File) error {
			p.fileCalls++
			p.files[file]++
			if p.files[file] != 1 {
				p.t.Fatal("retried an already consumed file owner")
			}
			if err := file.Close(); err != nil {
				p.t.Fatal("closing the exact disposable file failed")
			}
			if p.fileCalls == p.fileFaultAt {
				return p.fileCause
			}
			return nil
		},
	}
}
func privateAccessRoot(t *testing.T) string {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal("canonical disposable temp root unavailable")
	}
	root := filepath.Join(base, "access")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal("disposable access root unavailable")
	}
	return root
}
func safeStoreError(t *testing.T, err error) {
	t.Helper()
	if err == nil || err.Error() != unavailable().Error() {
		t.Fatal("expected only classified store error text")
	}
	failCode(t, err, "COMPUTER_AUTHORITY_STORE_UNAVAILABLE")
}
func assertConsumed(t *testing.T, d *disk, p *closeProbe, count int) {
	t.Helper()
	if d.dir != -1 || d.lock != -1 || len(p.fds) != count {
		t.Fatal("did not consume each owned descriptor exactly once")
	}
	first := d.close()
	if again := d.close(); again != first || len(p.fds) != count {
		t.Fatal("close retried an owner or changed its receipt")
	}
}

func TestConstructorCleanupReceiptRequiresExplicitEvidence(t *testing.T) {
	for _, err := range []error{nil, unavailable(), errors.New("unrelated refusal"), &CommitFailure{Unknown: true}} {
		if ConstructorCleanup(err) != ConstructorCleanupUnreported {
			t.Fatal("absence of a cleanup receipt became confirmation")
		}
	}
	root := privateAccessRoot(t)
	for _, constructor := range []func(string, Binding, port.Clock) (*Store, error){Create, Open} {
		for _, invalid := range []struct {
			binding Binding
			clock   port.Clock
		}{{Binding{}, newClock()}, {testBinding, nil}} {
			owner, err := constructor(root, invalid.binding, invalid.clock)
			if owner != nil || ConstructorCleanup(err) != ConstructorCleanupNotAcquired || CleanupUnknown(err) {
				t.Fatal("validation refusal did not explicitly report no acquisition")
			}
			safeStoreError(t, err)
		}
	}
	missing := filepath.Join(root, "missing")
	owner, err := Open(missing, testBinding, newClock())
	var pathErr *os.PathError
	if owner != nil || ConstructorCleanup(err) != ConstructorCleanupNotAcquired || !errors.Is(err, os.ErrNotExist) || !errors.As(err, &pathErr) {
		t.Fatal("pre-acquisition refusal lost its status or native cause")
	}
	safeStoreError(t, err)
	owner, err = Open(root, testBinding, newClock())
	if owner != nil || ConstructorCleanup(fmt.Errorf("wrapped: %w", err)) != ConstructorCleanupConfirmed || CleanupUnknown(err) || !errors.Is(err, unix.ENOENT) {
		t.Fatal("known-clean missing-state refusal was not explicit")
	}
	safeStoreError(t, err)
	// The missing state still cannot be restored, even after confirmed cleanup.
	owner, err = Open(root, testBinding, newClock())
	if owner != nil || err == nil {
		t.Fatal("cleanup classification fabricated a restorable state")
	}
}

func TestOpenDiskConstructorFailureClosesOnlyAcquiredDescriptions(t *testing.T) {
	for _, kind := range []string{"directory-mode", "lock-symlink", "lock-mode", "competing-owner"} {
		for _, lost := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/lost=%t", kind, lost), func(t *testing.T) {
				f := fixtureState(t)
				if kind != "competing-owner" {
					if err := f.store.Close(); err != nil {
						t.Fatal("control owner did not close")
					}
				}
				lock := filepath.Join(f.root, lockName)
				switch kind {
				case "directory-mode":
					if err := os.Chmod(f.root, 0750); err != nil {
						t.Fatal("mode setup failed")
					}
				case "lock-symlink":
					if err := os.Remove(lock); err != nil {
						t.Fatal("lock fixture removal failed")
					}
					if err := os.Symlink(filepath.Join(f.home, "foreign"), lock); err != nil {
						t.Fatal("lock fixture symlink failed")
					}
				case "lock-mode":
					if err := os.Chmod(lock, 0644); err != nil {
						t.Fatal("lock mode setup failed")
					}
				}
				borrowed, err := os.CreateTemp(f.home, "borrowed-")
				if err != nil {
					t.Fatal("borrowed control unavailable")
				}
				defer borrowed.Close()
				p := newCloseProbe(t)
				lockCause, dirCause := &lostCloseReceipt{"lock"}, &lostCloseReceipt{"directory"}
				if lost {
					p.fdCauses = []error{lockCause, dirCause}
				}
				d, err := openDiskWithCleanup(f.root, p.hooks())
				if d != nil {
					d.close()
					t.Fatal("unsafe constructor returned an owner")
				}
				want, count := ConstructorCleanupConfirmed, 2
				if kind == "directory-mode" || kind == "lock-symlink" {
					count = 1
				}
				if lost {
					want = ConstructorCleanupUnknown
				}
				if ConstructorCleanup(err) != want || CleanupUnknown(err) != lost || OutcomeUnknown(err) || len(p.fds) != count {
					t.Fatal("constructor cleanup receipt disagrees with acquired ownership")
				}
				safeStoreError(t, err)
				if lost && (!errors.Is(err, lockCause) || (count == 2 && !errors.Is(err, dirCause))) {
					t.Fatal("constructor discarded a cleanup cause")
				}
				if kind == "lock-symlink" && !errors.Is(err, unix.ELOOP) {
					t.Fatal("lock open cause lost")
				}
				if kind == "competing-owner" {
					if !errors.Is(err, unix.EWOULDBLOCK) {
						t.Fatal("lock contention cause lost")
					}
					if status(t, f.store).Revision != 0 {
						t.Fatal("competing cleanup disturbed original owner")
					}
					other, err := Open(f.root, testBinding, f.clock)
					if other != nil {
						other.Close()
						t.Fatal("foreign lock was released")
					}
					if err == nil {
						t.Fatal("foreign lock no longer protects the store")
					}
				}
				if _, err := borrowed.Write([]byte("still owned by caller")); err != nil {
					t.Fatal("cleanup touched a borrowed handle")
				}
			})
		}
	}
}

func TestConstructorRetainsPrimaryAndEveryCleanupCause(t *testing.T) {
	for _, lost := range []bool{false, true} {
		t.Run(fmt.Sprintf("lost=%t", lost), func(t *testing.T) {
			f := fixtureState(t)
			if err := f.store.Close(); err != nil {
				t.Fatal("control close failed")
			}
			p := newCloseProbe(t)
			lockCause, dirCause := &lostCloseReceipt{"lock"}, &lostCloseReceipt{"directory"}
			if lost {
				p.fdCauses = []error{lockCause, dirCause}
			}
			primary := &os.PathError{Op: "sync", Path: "private symbolic native diagnostic", Err: unix.EIO}
			var opened *disk
			factory := func(root string) (*disk, error) {
				d, err := openDiskWithCleanup(root, p.hooks())
				if err == nil {
					opened = d
					d.syncSnapshot = func(int) error { return primary }
				}
				return d, err
			}
			owner, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
			if owner != nil {
				owner.Close()
				t.Fatal("failed restore returned authority")
			}
			want := ConstructorCleanupConfirmed
			if lost {
				want = ConstructorCleanupUnknown
			}
			var native *os.PathError
			if ConstructorCleanup(err) != want || CleanupUnknown(err) != lost || !OutcomeUnknown(err) || !errors.Is(err, primary) || !errors.Is(err, unix.EIO) || !errors.As(err, &native) || native != primary {
				t.Fatal("restore lost its primary cause, uncertainty, or explicit cleanup status")
			}
			if lost {
				var receipt *lostCloseReceipt
				if !errors.Is(err, lockCause) || !errors.Is(err, dirCause) || !errors.As(err, &receipt) {
					t.Fatal("restore discarded one of its cleanup causes")
				}
			}
			safeStoreError(t, err)
			assertConsumed(t, opened, p, 2)
			if p.fileCalls != 2 {
				t.Fatal("restore did not close its read and barrier owners once")
			}
		})
	}
}

func TestConstructorRejectsEveryLostFileCloseReceipt(t *testing.T) {
	for _, create := range []bool{false, true} {
		last := 3
		if create {
			last = 4
		}
		for fault := 0; fault <= last; fault++ {
			t.Run(fmt.Sprintf("create=%t/close=%d", create, fault), func(t *testing.T) {
				root := privateAccessRoot(t)
				if !create {
					control, err := Create(root, testBinding, newClock())
					if err != nil {
						t.Fatal("valid create control failed")
					}
					if err := control.Close(); err != nil {
						t.Fatal("control close failed")
					}
				}
				p := newCloseProbe(t)
				cause := &lostCloseReceipt{"snapshot"}
				p.fileFaultAt, p.fileCause = fault, cause
				var opened *disk
				factory := func(root string) (*disk, error) {
					d, err := openDiskWithCleanup(root, p.hooks())
					opened = d
					return d, err
				}
				owner, err := openWithDisk(root, testBinding, newClock(), create, factory)
				if fault == 0 {
					if err != nil || owner == nil || p.fileCalls != last || ConstructorCleanup(err) != ConstructorCleanupUnreported {
						t.Fatal("valid constructor control failed")
					}
					if observed := status(t, owner); observed != (Status{}) {
						t.Fatal("control fabricated default authority")
					}
					if err := owner.Close(); err != nil {
						t.Fatal("valid owner close failed")
					}
				} else {
					if owner != nil {
						owner.Close()
						t.Fatal("lost file close receipt returned a usable owner")
					}
					if ConstructorCleanup(err) != ConstructorCleanupUnknown || !CleanupUnknown(err) || !errors.Is(err, cause) {
						t.Fatal("file close failure was not retained as unknown cleanup")
					}
					safeStoreError(t, err)
					unknownPublication := (!create && fault == 2) || (create && (fault == 1 || fault == 3))
					if OutcomeUnknown(err) != unknownPublication {
						t.Fatal("cleanup uncertainty changed publication semantics")
					}
					wantCalls := fault
					if fault == last-1 {
						wantCalls = last
					}
					if p.fileCalls != wantCalls {
						t.Fatal("late barrier owner was not closed after nested read failure")
					}
				}
				assertConsumed(t, opened, p, 2)
				raw, readErr := os.ReadFile(filepath.Join(root, stateName))
				state, decodeErr := decodeState(testBinding, raw)
				if readErr != nil || decodeErr != nil || state.Revision != 0 || state.Generation != 0 || state.Approval != nil || len(state.Participants) != 0 {
					t.Fatal("constructor failure changed canonical state or created approval")
				}
			})
		}
	}
}

func TestReadCloseFailureCannotReturnBytesOrDiscloseSnapshot(t *testing.T) {
	for _, direct := range []bool{false, true} {
		t.Run(fmt.Sprintf("direct=%t", direct), func(t *testing.T) {
			f := fixtureState(t)
			p := newCloseProbe(t)
			cause := &lostCloseReceipt{"read"}
			p.fileFaultAt, p.fileCause = 1, cause
			f.store.disk.cleanup = p.hooks()
			var err error
			if direct {
				var raw []byte
				raw, err = f.store.disk.read()
				if raw != nil {
					t.Fatal("uncertain read returned bytes")
				}
			} else {
				var value Status
				value, err = f.store.Status(context.Background())
				if value != (Status{}) || !f.store.poisoned {
					t.Fatal("uncertain read returned a live status")
				}
			}
			if !CleanupUnknown(err) || OutcomeUnknown(err) || !errors.Is(err, cause) {
				t.Fatal("lost read close receipt was hidden")
			}
			safeStoreError(t, err)
			visits := 0
			if err := f.store.WithSnapshot(context.Background(), "main", func(port.AccessSnapshot) error { visits++; return nil }); err == nil || visits != 0 || p.fileCalls != 1 {
				t.Fatal("owner reused/disclosed state after uncertain read cleanup")
			}
			first := f.store.Close()
			if !CleanupUnknown(first) || !errors.Is(first, cause) || f.store.Close() != first {
				t.Fatal("later Close erased read cleanup uncertainty")
			}
			safeStoreError(t, first)
			assertConsumed(t, f.store.disk, p, 2)
		})
	}
}

func TestCloseLostReceiptIsStickyAndDoesNotRecloseReusedFD(t *testing.T) {
	f := fixtureState(t)
	p := newCloseProbe(t)
	lock, dir := f.store.disk.lock, f.store.disk.dir
	lockCause, dirCause := &lostCloseReceipt{"lock"}, &lostCloseReceipt{"directory"}
	p.fdCauses = []error{lockCause, dirCause}
	var borrowed *os.File
	p.afterFD = func(int) {
		if borrowed == nil {
			var err error
			borrowed, err = os.CreateTemp(f.home, "borrowed-after-close-")
			if err != nil {
				t.Fatal("borrowed handle setup failed")
			}
		}
	}
	f.store.disk.cleanup = p.hooks()
	first := f.store.Close()
	if !CleanupUnknown(first) || OutcomeUnknown(first) || !errors.Is(first, lockCause) || !errors.Is(first, dirCause) {
		t.Fatal("Close discarded an original owned-handle receipt")
	}
	safeStoreError(t, first)
	if len(p.fds) != 2 || p.fds[0] != lock || p.fds[1] != dir {
		t.Fatal("Close touched a different handle or skipped a remaining owner")
	}
	for range 3 {
		if f.store.Close() != first {
			t.Fatal("repeated Close falsely claimed success")
		}
	}
	assertConsumed(t, f.store.disk, p, 2)
	if _, err := borrowed.Write([]byte("foreign owner remains live")); err != nil {
		t.Fatal("repeated Close touched the new owner")
	}
	if err := borrowed.Close(); err != nil {
		t.Fatal("borrowed owner cleanup failed")
	}
}

func TestDecodeRefusalPreservesPrimaryBeforeConstructorCleanup(t *testing.T) {
	for _, raw := range []string{"{invalid", `{"schema":"invalid"}`} {
		f := fixtureState(t)
		if err := f.store.Close(); err != nil {
			t.Fatal("control close failed")
		}
		if err := os.WriteFile(filepath.Join(f.root, stateName), []byte(raw), 0600); err != nil {
			t.Fatal("corruption fixture failed")
		}
		p := newCloseProbe(t)
		cause := &lostCloseReceipt{"directory"}
		p.fdCauses = []error{nil, cause}
		factory := func(root string) (*disk, error) { return openDiskWithCleanup(root, p.hooks()) }
		owner, err := openWithDisk(f.root, testBinding, f.clock, false, factory)
		if owner != nil {
			owner.Close()
			t.Fatal("invalid schema returned authority")
		}
		var syntax *json.SyntaxError
		var typed *json.UnmarshalTypeError
		if (!errors.As(err, &syntax) && !errors.As(err, &typed)) || !errors.Is(err, cause) || ConstructorCleanup(err) != ConstructorCleanupUnknown {
			t.Fatal("decode failure or cleanup cause disappeared")
		}
		safeStoreError(t, err)
	}
}

func TestPublicationRetainsCausesWithoutConflatingCleanup(t *testing.T) {
	for _, attempted := range []bool{false, true} {
		f := fixtureState(t)
		before, err := os.ReadFile(filepath.Join(f.root, stateName))
		if err != nil {
			t.Fatal("control read failed")
		}
		next := f.store.current
		next.Revision++
		cause := &os.PathError{Op: "guard", Path: "private symbolic native diagnostic", Err: unix.EIO}
		err = f.store.commitWithPublication(context.Background(), next, func(publish func() error) error {
			if attempted {
				if err := publish(); err != nil {
					return err
				}
			}
			return cause
		})
		if !errors.Is(err, cause) || OutcomeUnknown(err) != attempted || CleanupUnknown(err) || f.store.poisoned != attempted {
			t.Fatal("guard cause or original publication classification was lost")
		}
		safeStoreError(t, err)
		after, readErr := os.ReadFile(filepath.Join(f.root, stateName))
		if readErr != nil || bytes.Equal(before, after) == attempted {
			t.Fatal("publication/refusal changed visible bytes incorrectly")
		}
	}
}

func TestPublicationFileCloseFailuresKeepOriginalBytesAndUnknownFence(t *testing.T) {
	for _, fault := range []int{2, 3, 4} {
		t.Run(fmt.Sprint(fault), func(t *testing.T) {
			f := fixtureState(t)
			approve(t, f)
			before, err := os.ReadFile(filepath.Join(f.root, stateName))
			if err != nil {
				t.Fatal("control read failed")
			}
			p := newCloseProbe(t)
			cause := &lostCloseReceipt{"publication file"}
			p.fileFaultAt, p.fileCause = fault, cause
			f.store.disk.cleanup = p.hooks()
			err = f.store.RevokeApproval(context.Background(), 1)
			if !CleanupUnknown(err) || !errors.Is(err, cause) || OutcomeUnknown(err) != (fault == 4) || !f.store.poisoned {
				t.Fatal("publication file-close failure was silently accepted or misclassified")
			}
			safeStoreError(t, err)
			after, readErr := os.ReadFile(filepath.Join(f.root, stateName))
			if readErr != nil || bytes.Equal(before, after) != (fault < 4) {
				t.Fatal("pre/post publication failure violated byte guarantees")
			}
			if closed := f.store.Close(); !errors.Is(closed, cause) || closed != f.store.Close() {
				t.Fatal("Close lost publication cleanup uncertainty")
			}
			assertConsumed(t, f.store.disk, p, 2)
			entries, err := os.ReadDir(f.root)
			if err != nil || len(entries) != 2 {
				t.Fatal("publication leaked disposable temporary state")
			}
		})
	}
}

func TestClosedInspectionRetainsCancellationCallbackAndLateCleanup(t *testing.T) {
	for _, kind := range []string{"late-close", "callback", "cancelled", "callback-and-cancelled", "first-read-close", "last-read-close"} {
		t.Run(kind, func(t *testing.T) {
			f := fixtureState(t)
			if err := f.store.Close(); err != nil {
				t.Fatal("control close failed")
			}
			raw, err := os.ReadFile(filepath.Join(f.root, stateName))
			if err != nil {
				t.Fatal("control read failed")
			}
			p := newCloseProbe(t)
			lockCause, dirCause := &lostCloseReceipt{"lock"}, &lostCloseReceipt{"directory"}
			p.fdCauses = []error{lockCause, dirCause}
			fileCause := &lostCloseReceipt{"inspection read"}
			if kind == "first-read-close" {
				p.fileFaultAt, p.fileCause = 1, fileCause
			}
			if kind == "last-read-close" {
				p.fileFaultAt, p.fileCause = 3, fileCause
			}
			callback := &os.PathError{Op: "visit", Path: "private symbolic native diagnostic", Err: unix.EIO}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			visits := 0
			err = withClosedInspection(ctx, f.root, testBinding, digest(raw), func(ClosedInspection) error {
				visits++
				if strings.Contains(kind, "cancelled") {
					cancel()
				}
				if strings.Contains(kind, "callback") {
					return callback
				}
				return nil
			}, p.hooks())
			if !CleanupUnknown(err) || OutcomeUnknown(err) || ConstructorCleanup(err) != ConstructorCleanupUnreported || len(p.fds) != 2 || !errors.Is(err, lockCause) || !errors.Is(err, dirCause) {
				t.Fatal("inspection cleanup hid or fabricated a scoped constructor receipt")
			}
			safeStoreError(t, err)
			if strings.Contains(kind, "callback") && !errors.Is(err, callback) {
				t.Fatal("cleanup erased callback refusal")
			}
			if strings.Contains(kind, "cancelled") && !errors.Is(err, context.Canceled) {
				t.Fatal("cleanup erased cancellation")
			}
			if p.fileFaultAt > 0 && !errors.Is(err, fileCause) {
				t.Fatal("inspection file close cause lost")
			}
			wantVisits := 1
			if kind == "first-read-close" {
				wantVisits = 0
			}
			if visits != wantVisits {
				t.Fatal("inspection visited after failed read or skipped the valid control")
			}
			after, readErr := os.ReadFile(filepath.Join(f.root, stateName))
			if readErr != nil || !bytes.Equal(raw, after) {
				t.Fatal("failed inspection changed retained bytes")
			}
		})
	}
}

func TestLateTemporaryCleanupFailureCannotMasqueradeAsKnownRefusal(t *testing.T) {
	f := fixtureState(t)
	next := f.store.current
	next.Revision++
	cause := errors.New("symbolic current-consent refusal")
	err := f.store.commitWithPublication(context.Background(), next, func(func() error) error {
		entries, err := os.ReadDir(f.root)
		if err != nil {
			t.Fatal("disposable temporary inventory unavailable")
		}
		found := 0
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".computer-access-") && strings.HasSuffix(entry.Name(), ".tmp") {
				found++
				// Replace only this call's disposable temporary entry with a test
				// directory. The adapter's ordinary unlink must now fail safely;
				// the temp fixture owns its eventual directory cleanup.
				path := filepath.Join(f.root, entry.Name())
				if err := os.Remove(path); err != nil {
					t.Fatal("temporary fixture removal failed")
				}
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal("temporary fixture directory failed")
				}
			}
		}
		if found != 1 {
			t.Fatal("expected one exact call-owned temporary entry")
		}
		return cause
	})
	if !f.store.poisoned || !errors.Is(err, cause) || (!errors.Is(err, unix.EPERM) && !errors.Is(err, unix.EISDIR)) || OutcomeUnknown(err) || CleanupUnknown(err) {
		t.Fatal("late entry cleanup failure hid its cause or left a usable owner")
	}
	safeStoreError(t, err)
}

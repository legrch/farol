package rejection

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/journal"
	"github.com/legrch/farol/modules/release/infra/repos/records"
	"golang.org/x/sys/unix"
)

// Files, native metadata and syscalls are real disposable filesystem evidence.
// Owner/lease/slot/quiescence and accepted-build/object provenance are SYMBOLIC;
// these fixtures do not qualify helper execution, installed OTA or power loss.
type ownerFixture struct {
	gate            sync.Mutex
	op              release.Operation
	binding         port.JournalDirectory
	unknown         bool
	calls, retained int
	verify          func(context.Context) error
}

func (o *ownerFixture) JournalGate() port.StateGate              { return &o.gate }
func (o *ownerFixture) JournalUnknown(op release.Operation) bool { return o.unknown || op != o.op }
func (o *ownerFixture) RetainJournalUnknown(op release.Operation) {
	if op == o.op {
		o.unknown = true
		o.retained++
	}
}
func (o *ownerFixture) ReverifyJournal(ctx context.Context, op release.Operation, binding port.JournalDirectory) error {
	o.calls++
	if op != o.op || binding != o.binding || o.unknown {
		return errors.New("symbolic owner binding refused")
	}
	if o.verify != nil {
		return o.verify(ctx)
	}
	return nil
}

type fixture struct {
	path     string
	file     *os.File
	owner    *ownerFixture
	expected port.HelperIdentity
	ctx      context.Context
	until    time.Time
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func nativeState(t *testing.T, path string) fingerprint {
	t.Helper()
	var st unix.Stat_t
	must(t, unix.Lstat(path, &st))
	return metadata(st)
}
func setup(t *testing.T) *fixture {
	t.Helper()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	must(t, err)
	must(t, os.Chmod(parent, 0o700))
	op := release.Operation{ID: strings.Repeat("a", 32), Source: release.Build{Digest: strings.Repeat("b", 64), Version: "alpha-1", BuildID: strings.Repeat("c", 64)}, Target: release.Build{Digest: strings.Repeat("d", 64), Version: "alpha-2", BuildID: strings.Repeat("e", 64)}}
	path := filepath.Join(parent, op.ID)
	must(t, os.Mkdir(path, 0o700))
	// Deliberately invalid target bytes: this repository must never attest them.
	must(t, os.Mkdir(filepath.Join(path, failedName), 0o755))
	must(t, os.WriteFile(filepath.Join(path, failedName, "invalid-target"), []byte("not an accepted bundle"), 0o600))
	file, err := os.OpenFile(path, directoryFlags(), 0)
	must(t, err)
	t.Cleanup(func() { must(t, file.Close()) })
	d, p := nativeState(t, path).identity(), nativeState(t, parent).identity()
	o := &ownerFixture{op: op, binding: port.JournalDirectory{Device: d.Device, Inode: d.Inode, ParentDevice: p.Device, ParentInode: p.Inode}}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	return &fixture{path: path, file: file, owner: o, expected: nativeState(t, filepath.Join(path, failedName)).identity(), ctx: ctx, until: time.Now().Add(15 * time.Second)}
}
func (f *fixture) open(t *testing.T) *Repository {
	t.Helper()
	if !nativeSupported() {
		t.Skip("positive production persistence requires Darwin native no-replace capability")
	}
	r, err := New(f.ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
	must(t, err)
	t.Cleanup(func() { must(t, r.Close()) })
	return r
}
func classified(t *testing.T, err error, code string, internal, unknown bool) *port.HelperRecoveryFailure {
	t.Helper()
	f, ok := err.(*port.HelperRecoveryFailure)
	if !ok || f == nil || f.Phase != "refused" || code != "" && f.Code != code || f.Internal != internal || f.Uncertain != unknown || !bounded(f.Code) {
		t.Fatalf("classification: %#v want %s internal=%v unknown=%v", err, code, internal, unknown)
	}
	if err.Error() != "helper_recovery_failure" {
		t.Fatal("unbounded error text")
	}
	return f
}
func entries(t *testing.T, path string) []string {
	t.Helper()
	es, err := os.ReadDir(path)
	must(t, err)
	var out []string
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}
func TestConstructorAndRecordPhysicalPersistence(t *testing.T) {
	f := setup(t)
	before := nativeState(t, f.path)
	beforeParent := nativeState(t, filepath.Dir(f.path))
	names := entries(t, f.path)
	r := f.open(t)
	if nativeState(t, f.path) != before || nativeState(t, filepath.Dir(f.path)) != beforeParent || !reflect.DeepEqual(entries(t, f.path), names) {
		t.Fatal("constructor mutated namespace")
	}
	flags, err := unix.FcntlInt(f.file.Fd(), unix.F_GETFL, 0)
	must(t, err)
	failedBefore := nativeState(t, filepath.Join(f.path, failedName))
	must(t, r.Record(context.Background(), f.expected))
	afterFlags, err := unix.FcntlInt(f.file.Fd(), unix.F_GETFL, 0)
	must(t, err)
	if flags != afterFlags {
		t.Fatal("borrowed description reconfigured")
	}
	path := filepath.Join(f.path, filename)
	data, err := os.ReadFile(path)
	must(t, err)
	value, err := records.DecodeRejectedTarget(data, record(f.owner.op, f.expected).Operation)
	must(t, err)
	want := record(f.owner.op, f.expected)
	if *value != want || len(data) > 8192 || !nativeState(t, path).file() || nativeState(t, filepath.Join(f.path, failedName)) != failedBefore {
		t.Fatal("physical binding or metadata changed")
	}
	if len(entries(t, f.path)) != 2 || f.owner.unknown {
		t.Fatal("unexpected temp or unknown")
	}
	copy := *r
	classified(t, copy.Record(context.Background(), f.expected), "attempt_used", false, false)
	must(t, r.Close())
	if _, err := f.file.Stat(); err != nil {
		t.Fatal("borrowed descriptor closed")
	}
	// A separate adapter must refuse this existing record even if bytes match.
	again := f.open(t)
	classified(t, again.Record(context.Background(), f.expected), "existing", false, false)
	data2, err := os.ReadFile(path)
	must(t, err)
	if !bytes.Equal(data, data2) {
		t.Fatal("existing record replaced")
	}
}
func TestUnsupportedProductionConstructor(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux fail-closed constructor only")
	}
	f := setup(t)
	r, err := New(f.ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
	if r != nil {
		t.Fatal("unsupported native constructor admitted")
	}
	classified(t, err, "unsupported", false, false)
}
func TestConstructorBindingAndSafety(t *testing.T) {
	if !nativeSupported() {
		t.Skip("requires supported production constructor")
	}
	for _, kind := range []string{"device", "inode", "parent-device", "parent-inode", "decimal", "op", "mode", "parent-mode", "symlink", "closed"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			b := f.owner.binding
			op := f.owner.op
			file := f.file
			switch kind {
			case "device":
				b.Device = "0"
			case "inode":
				b.Inode = "0"
			case "parent-device":
				b.ParentDevice = "0"
			case "parent-inode":
				b.ParentInode = "0"
			case "decimal":
				b.Device = "01"
			case "op":
				op.ID = strings.Repeat("f", 32)
			case "mode":
				must(t, os.Chmod(f.path, 0o755))
			case "parent-mode":
				must(t, os.Chmod(filepath.Dir(f.path), 0o755))
			case "symlink":
				must(t, os.Rename(f.path, f.path+"-old"))
				must(t, os.Symlink(f.path+"-old", f.path))
			case "closed":
				file, _ = os.Open(f.path)
				must(t, file.Close())
			}
			r, err := New(f.ctx, file, b, op, f.owner, f.until)
			if r != nil || err == nil {
				t.Fatal("unsafe constructor admitted")
			}
			var failure *port.HelperRecoveryFailure
			if !errors.As(err, &failure) || !bounded(failure.Code) {
				t.Fatal("unclassified constructor error")
			}
			if len(entries(t, filepath.Join(filepath.Dir(f.path), f.owner.op.ID+map[bool]string{true: "-old"}[kind == "symlink"]))) != 1 {
				t.Fatal("constructor wrote")
			}
		})
	}
}
func TestAttemptConsumedBeforeCancellationAndInput(t *testing.T) {
	for _, kind := range []string{"nil", "canceled", "identity", "overflow", "leading-zero"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			copy := *r
			ctx := context.Background()
			id := f.expected
			switch kind {
			case "nil":
				ctx = nil
			case "canceled":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			case "identity":
				id.Inode = "0"
			case "overflow":
				id.Device = "18446744073709551616"
			case "leading-zero":
				id.Inode = "0" + id.Inode
			}
			classified(t, r.Record(ctx, id), "", false, false)
			classified(t, copy.Record(context.Background(), f.expected), "attempt_used", false, false)
			if len(entries(t, f.path)) != 1 || f.owner.unknown {
				t.Fatal("pre-effect failure mutated")
			}
		})
	}
}
func TestPreexistingRecordNeverAdoptedOrRead(t *testing.T) {
	for _, kind := range []string{"matching", "malformed", "oversized", "symlink", "hardlink", "fifo", "directory", "unsafe-mode"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			path := filepath.Join(f.path, filename)
			data, err := records.EncodeRejectedTarget(record(f.owner.op, f.expected))
			must(t, err)
			switch kind {
			case "malformed":
				data = []byte("private malformed data")
			case "oversized":
				data = bytes.Repeat([]byte("x"), 8193)
			}
			switch kind {
			case "symlink":
				must(t, os.Symlink(failedName, path))
			case "directory":
				must(t, os.Mkdir(path, 0o700))
			case "fifo":
				must(t, unix.Mkfifo(path, 0o600))
			default:
				must(t, os.WriteFile(path, data, 0o600))
			}
			if kind == "hardlink" {
				must(t, os.Link(path, path+".alias"))
			}
			if kind == "unsafe-mode" {
				must(t, os.Chmod(path, 0o666))
			}
			before := nativeState(t, path)
			names := entries(t, f.path)
			classified(t, r.Record(context.Background(), f.expected), "existing", false, false)
			if nativeState(t, path) != before || !reflect.DeepEqual(entries(t, f.path), names) || f.owner.unknown {
				t.Fatal("existing evidence changed")
			}
			if before.mode&unix.S_IFMT == unix.S_IFREG {
				after, err := os.ReadFile(path)
				must(t, err)
				if !bytes.Equal(after, data) {
					t.Fatal("bytes replaced")
				}
			}
		})
	}
}
func TestFailedDirectoryAndParentReplacement(t *testing.T) {
	for _, kind := range []string{"symlink", "file", "fifo", "mode", "setuid", "replace", "parent-replace", "operation-replace", "parent-mode", "failed-content"} {
		for _, point := range []string{"create-before", "publish-before"} {
			t.Run(kind+"-"+point, func(t *testing.T) {
				f := setup(t)
				r := f.open(t)
				r.state.step = func(at string) error {
					if at != point {
						return nil
					}
					path := filepath.Join(f.path, failedName)
					switch kind {
					case "symlink", "file", "fifo", "replace":
						must(t, os.Rename(path, path+"-old"))
						switch kind {
						case "symlink":
							must(t, os.Symlink(failedName+"-old", path))
						case "file":
							must(t, os.WriteFile(path, []byte("x"), 0o600))
						case "fifo":
							must(t, unix.Mkfifo(path, 0o600))
						case "replace":
							must(t, os.Mkdir(path, 0o755))
						}
					case "mode":
						must(t, os.Chmod(path, 0o777))
					case "setuid":
						must(t, os.Chmod(path, 0o755|os.ModeSetuid))
					case "failed-content":
						must(t, os.WriteFile(filepath.Join(path, "another"), []byte("x"), 0o600))
					case "parent-mode":
						must(t, os.Chmod(filepath.Dir(f.path), 0o755))
					case "operation-replace":
						must(t, os.Rename(f.path, f.path+"-old"))
						must(t, os.Mkdir(f.path, 0o700))
					case "parent-replace":
						parent := filepath.Dir(f.path)
						must(t, os.Rename(parent, parent+"-old"))
						must(t, os.Mkdir(parent, 0o700))
						must(t, os.Rename(filepath.Join(parent+"-old", f.owner.op.ID), f.path))
						t.Cleanup(func() { must(t, os.RemoveAll(parent+"-old")) })
					}
					return nil
				}
				err := r.Record(context.Background(), f.expected)
				classified(t, err, "", false, point == "publish-before")
				if f.owner.unknown != (point == "publish-before") {
					t.Fatal("owner retention mismatch")
				}
				if _, err := os.Lstat(filepath.Join(f.path, filename)); !errors.Is(err, os.ErrNotExist) {
					t.Fatal("unsafe effect published")
				}
			})
		}
	}
}
func TestMeasuredOwnerPredicatesAndForeignUIDLimit(t *testing.T) {
	f := setup(t)
	s := nativeState(t, filepath.Join(f.path, failedName))
	if !s.directory(false) {
		t.Fatal("actual same UID directory refused")
	}
	s.uid = uint32(os.Geteuid()) + 1
	if s.directory(false) {
		t.Fatal("foreign UID predicate admitted")
	}
	t.Run("actual-foreign-UID", func(t *testing.T) {
		t.Skip("foreign-owner fixture NOT RUN: no chown, sudo or privilege changes authorized")
	})
}
func TestNativeNoReplaceCollisionAndQuarantine(t *testing.T) {
	f := setup(t)
	r := f.open(t)
	other := []byte("other writer evidence")
	r.state.publish = func(fd int, temp string) error {
		must(t, os.WriteFile(filepath.Join(f.path, filename), other, 0o600))
		return publish(fd, temp)
	}
	err := r.Record(context.Background(), f.expected)
	classified(t, err, "native", true, true)
	if !errors.Is(err, unix.EEXIST) || !f.owner.unknown {
		t.Fatal("collision cause lost")
	}
	data, err := os.ReadFile(filepath.Join(f.path, filename))
	must(t, err)
	if !bytes.Equal(data, other) || len(entries(t, f.path)) != 3 {
		t.Fatal("collision replaced or deleted evidence")
	}
}
func TestNativeFailuresRetainExactCausesAndNeverReplay(t *testing.T) {
	for _, point := range []string{"create-after", "write-before", "write-after", "file-sync-before", "file-sync-after", "file-close-after", "publish-before", "rename-after", "parent-sync-before", "parent-sync-after", "readback-before", "read-open", "read-bytes", "ack-before"} {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			copy := *r
			sentinel := fmt.Errorf("injected %s: %w", point, unix.EIO)
			r.state.step = func(at string) error {
				if at == point {
					return sentinel
				}
				return nil
			}
			err := r.Record(context.Background(), f.expected)
			classified(t, err, "native", true, true)
			if !errors.Is(err, sentinel) || !errors.Is(err, unix.EIO) || !f.owner.unknown {
				t.Fatal("original cause or retention lost")
			}
			names := entries(t, f.path)
			if len(names) != 2 {
				t.Fatal("uncertain evidence not quarantined")
			}
			classified(t, copy.Record(context.Background(), f.expected), "attempt_used", false, true)
			calls := f.owner.calls
			must(t, r.Close())
			again, err := New(f.ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
			if again != nil {
				t.Fatal("new adapter cleared uncertainty")
			}
			classified(t, err, "unknown", false, true)
			if f.owner.calls != calls || !reflect.DeepEqual(entries(t, f.path), names) {
				t.Fatal("new adapter replayed or cleaned up")
			}
		})
	}
}
func TestActualNativeAndPartialWriteFailures(t *testing.T) {
	for _, kind := range []string{"partial-enospc", "short-write", "file-sync", "parent-sync", "owned-close", "lost-create"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			cause := error(unix.EIO)
			switch kind {
			case "partial-enospc":
				cause = unix.ENOSPC
				r.state.write = func(file *os.File, data []byte) (int, error) {
					n, err := file.Write(data[:3])
					must(t, err)
					return n, unix.ENOSPC
				}
			case "short-write":
				cause = io.ErrShortWrite
				r.state.write = func(*os.File, []byte) (int, error) { return 0, nil }
			case "file-sync", "parent-sync":
				r.state.sync = func(file *os.File) error {
					if (file == f.file) == (kind == "parent-sync") {
						return unix.Fsync(-1)
					}
					return file.Sync()
				}
				cause = unix.EBADF
			case "owned-close":
				r.state.close = func(file *os.File) error {
					err := file.Close()
					if file.Name() == "rejection-temp" {
						must(t, err)
						return unix.EIO
					}
					return err
				}
			case "lost-create":
				r.state.create = func(fd int, name string, flags int, mode uint32) (int, error) {
					opened, err := unix.Openat(fd, name, flags, mode)
					must(t, err)
					return opened, unix.EIO
				}
			}
			err := r.Record(context.Background(), f.expected)
			classified(t, err, "", true, true)
			if !errors.Is(err, cause) || !f.owner.unknown || len(entries(t, f.path)) != 2 {
				t.Fatal("native cause/evidence lost")
			}
		})
	}
}

type lagContext struct {
	context.Context
	until time.Time
	calls atomic.Int32
}

func (c *lagContext) Deadline() (time.Time, bool) { c.calls.Add(1); return c.until, true }
func TestOriginalAndCallerDeadlinesCannotRenew(t *testing.T) {
	for _, kind := range []string{"original-expired", "original-earlier", "explicit-earlier", "caller-earlier", "original-cancel"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			if !nativeSupported() {
				t.Skip("Darwin constructor required")
			}
			original := &lagContext{Context: context.Background(), until: time.Now().Add(120 * time.Millisecond)}
			ctx := context.Context(original)
			if kind == "original-expired" {
				original.until = time.Now().Add(-time.Second)
			}
			if kind == "explicit-earlier" {
				f.until = time.Now().Add(70 * time.Millisecond)
				original.until = f.until.Add(time.Hour)
			}
			var cancel context.CancelFunc
			if kind == "original-cancel" {
				ctx, cancel = context.WithCancel(context.Background())
				defer cancel()
			}
			r, err := New(ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
			if kind == "original-expired" {
				if r != nil {
					t.Fatal("expired constructor")
				}
				classified(t, err, "canceled", false, false)
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatal("deadline lost")
				}
				return
			}
			must(t, err)
			t.Cleanup(func() { must(t, r.Close()) })
			caller := context.Background()
			bound := original.until
			if kind == "explicit-earlier" {
				bound = f.until
			}
			var lag *lagContext
			if kind == "caller-earlier" {
				lag = &lagContext{Context: context.Background(), until: time.Now().Add(40 * time.Millisecond)}
				caller = lag
				bound = lag.until
			}
			if kind == "original-cancel" {
				cancel()
			} else {
				time.Sleep(time.Until(bound) + time.Millisecond)
			}
			err = r.Record(caller, f.expected)
			classified(t, err, "canceled", false, false)
			want := context.DeadlineExceeded
			if kind == "original-cancel" {
				want = context.Canceled
			}
			if !errors.Is(err, want) || len(entries(t, f.path)) != 1 || f.owner.unknown {
				t.Fatal("expired budget renewed")
			}
			if kind != "original-cancel" && original.calls.Load() != 1 {
				t.Fatal("original deadline was reread")
			}
			if lag != nil && lag.calls.Load() != 1 {
				t.Fatal("caller deadline was reread")
			}
			classified(t, r.Record(context.Background(), f.expected), "attempt_used", false, false)
		})
	}
}
func TestActualReturnCleanupAndJournalGateRetention(t *testing.T) {
	for _, point := range []string{"write", "cleanup", "ack"} {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			j, err := journal.New(context.Background(), f.path, f.owner.op, f.owner)
			must(t, err)
			t.Cleanup(func() { must(t, j.Close()) })
			view, err := j.Read(context.Background())
			must(t, err)
			entered, drain := make(chan struct{}), make(chan struct{})
			sentinel := errors.New("original opaque native failure")
			block := func() { close(entered); <-drain }
			if point == "write" {
				r.state.write = func(*os.File, []byte) (int, error) { block(); return 0, sentinel }
			}
			if point == "cleanup" {
				r.state.close = func(file *os.File) error {
					if file.Name() == "rejection-temp" {
						block()
						return errors.Join(file.Close(), sentinel)
					}
					return file.Close()
				}
			}
			if point == "ack" {
				r.state.step = func(at string) error {
					if at == "ack-before" {
						block()
						return sentinel
					}
					return nil
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			finished := make(chan error, 1)
			go func() { finished <- r.Record(ctx, f.expected) }()
			select {
			case <-entered:
			case err := <-finished:
				t.Fatalf("did not enter native seam: %v", err)
			}
			cancel()
			if f.owner.gate.TryLock() {
				f.owner.gate.Unlock()
				close(drain)
				t.Fatal("gate released during native return")
			}
			closing := make(chan error, 1)
			go func() { closing <- r.Close() }()
			writing := make(chan error, 1)
			go func() {
				_, err := j.CompareAndSwap(context.Background(), view.Revision, release.Journal{Operation: f.owner.op, Phase: "prepared"})
				writing <- err
			}()
			select {
			case <-finished:
				close(drain)
				t.Fatal("returned before drain")
			case <-closing:
				close(drain)
				t.Fatal("Close bypassed return")
			case <-writing:
				close(drain)
				t.Fatal("journal bypassed gate")
			default:
			}
			close(drain)
			err = <-finished
			classified(t, err, "", true, true)
			if !errors.Is(err, sentinel) || !errors.Is(err, context.Canceled) {
				t.Fatal("failure plus cancellation provenance lost")
			}
			must(t, <-closing)
			if !errors.Is(<-writing, port.JournalUnknown) {
				t.Fatal("journal cleared shared unknown")
			}
			calls := f.owner.calls
			physical, err := j.Read(context.Background())
			must(t, err)
			if physical.Value != nil {
				t.Fatal("rejection wrote journal")
			}
			if !f.owner.unknown || f.owner.calls != calls {
				t.Fatal("readback cleared unknown")
			}
		})
	}
}
func TestOwnerFailureClassificationAndCancellationProvenance(t *testing.T) {
	for _, kind := range []string{"direct", "direct-owner-code", "opaque-refusal", "opaque-cancel", "join-cancel", "uncertain-join", "malformed"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			refused := failure("directory", false, false, nil)
			var cause error
			switch kind {
			case "direct":
				cause = refused
			case "direct-owner-code":
				cause = &port.HelperRecoveryFailure{Code: "route_changed", Phase: "refused"}
			case "opaque-cancel":
				cause = fmt.Errorf("opaque cancellation: %w", context.Canceled)
			case "opaque-refusal":
				cause = fmt.Errorf("opaque: %w", refused)
			case "join-cancel":
				cause = errors.Join(refused, unix.EIO, context.Canceled)
			case "uncertain-join":
				cause = errors.Join(failure("unknown", false, true, nil), context.Canceled)
			case "malformed":
				cause = &port.HelperRecoveryFailure{Code: "private\nvalue", Phase: "refused"}
			}
			f.owner.verify = func(context.Context) error { cancel(); return cause }
			err := r.Record(ctx, f.expected)
			classified(t, err, "admission", kind != "direct" && kind != "direct-owner-code", true)
			if !errors.Is(err, cause) || !errors.Is(err, context.Canceled) || !f.owner.unknown || len(entries(t, f.path)) != 1 {
				t.Fatal("owner provenance/retention lost")
			}
		})
	}
}
func TestReadbackRejectsReplacedUnsafeAndDuplicateBytes(t *testing.T) {
	for _, kind := range []string{"replacement", "symlink", "hardlink", "mode", "setuid", "duplicate", "unicode", "oversized", "mutation-during-read"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			path := filepath.Join(f.path, filename)
			r.state.step = func(at string) error {
				point := "readback-before"
				if kind == "mutation-during-read" {
					point = "read-bytes"
				}
				if at != point {
					return nil
				}
				switch kind {
				case "replacement":
					must(t, os.Rename(path, path+"-old"))
					must(t, os.WriteFile(path, []byte("different"), 0o600))
				case "symlink":
					must(t, os.Rename(path, path+"-old"))
					must(t, os.Symlink(filename+"-old", path))
				case "hardlink":
					must(t, os.Link(path, path+".alias"))
				case "mode":
					must(t, os.Chmod(path, 0o644))
				case "setuid":
					must(t, os.Chmod(path, 0o600|os.ModeSetuid))
				case "duplicate":
					data, err := os.ReadFile(path)
					must(t, err)
					data = bytes.Replace(data, []byte(`"device":`), []byte(`"device":"0","device":`), 1)
					must(t, os.WriteFile(path, data, 0o600))
				case "unicode":
					must(t, os.WriteFile(path, []byte(`{"version":"\ud800"}`), 0o600))
				case "oversized":
					must(t, os.WriteFile(path, bytes.Repeat([]byte("x"), 8193), 0o600))
				case "mutation-during-read":
					must(t, os.WriteFile(path, []byte("changed"), 0o600))
				}
				return nil
			}
			err := r.Record(context.Background(), f.expected)
			classified(t, err, "native", true, true)
			if !f.owner.unknown {
				t.Fatal("unsafe readback cleared uncertainty")
			}
		})
	}
}

func TestConcurrentCopiesShareOneAttempt(t *testing.T) {
	f := setup(t)
	r := f.open(t)
	copy := *r
	const count = 16
	results := make(chan error, count)
	for i := 0; i < count; i++ {
		go func(i int) {
			target := r
			if i%2 == 1 {
				target = &copy
			}
			results <- target.Record(context.Background(), f.expected)
		}(i)
	}
	successes := 0
	for i := 0; i < count; i++ {
		err := <-results
		if err == nil {
			successes++
		} else {
			classified(t, err, "attempt_used", false, false)
		}
	}
	if successes != 1 || len(entries(t, f.path)) != 2 || f.owner.unknown {
		t.Fatal("copies did not serialize one attempt")
	}
}
func TestJournalUnknownBlocksExistingAndNewRejectionConsumers(t *testing.T) {
	f := setup(t)
	r := f.open(t)
	j, err := journal.New(context.Background(), f.path, f.owner.op, f.owner)
	must(t, err)
	t.Cleanup(func() { must(t, j.Close()) })
	before, err := j.Read(context.Background())
	must(t, err)
	calls := 0
	f.owner.verify = func(context.Context) error {
		calls++
		if calls == 2 {
			return unix.EIO
		}
		return nil
	}
	_, err = j.CompareAndSwap(context.Background(), before.Revision, release.Journal{Operation: f.owner.op, Phase: "prepared"})
	if !errors.Is(err, port.JournalUnknown) || !f.owner.unknown {
		t.Fatal("journal uncertainty fixture did not retain")
	}
	count := f.owner.calls
	classified(t, r.Record(context.Background(), f.expected), "unknown", false, true)
	again, err := New(f.ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
	if again != nil {
		t.Fatal("new rejection consumer cleared journal unknown")
	}
	classified(t, err, "unknown", false, true)
	if f.owner.calls != count {
		t.Fatal("rejection invoked unknown owner")
	}
}
func TestCleanupFailureBeforeCreateStillRetainsOwner(t *testing.T) {
	f := setup(t)
	r := f.open(t)
	cause := errors.New("owned directory close result lost")
	r.state.step = func(at string) error {
		if at == "create-before" {
			return failure("directory", false, false, nil)
		}
		return nil
	}
	r.state.close = func(file *os.File) error {
		err := file.Close()
		if file.Name() == "rejection-failed" {
			return errors.Join(err, cause)
		}
		return err
	}
	err := r.Record(context.Background(), f.expected)
	classified(t, err, "directory", true, true)
	if !errors.Is(err, cause) || !f.owner.unknown || len(entries(t, f.path)) != 1 {
		t.Fatal("owned-close uncertainty lost")
	}
}
func TestCancellationAtNativeBoundaries(t *testing.T) {
	for _, point := range []string{"absence", "failed-open", "create-before", "create-after", "write-after", "publish-before", "rename-after", "parent-sync-after", "read-bytes", "ack-before"} {
		t.Run(point, func(t *testing.T) {
			f := setup(t)
			r := f.open(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			r.state.step = func(at string) error {
				if at == point {
					cancel()
				}
				return nil
			}
			err := r.Record(ctx, f.expected)
			possible := point != "absence" && point != "failed-open" && point != "create-before"
			classified(t, err, "canceled", false, possible)
			if !errors.Is(err, context.Canceled) || f.owner.unknown != possible {
				t.Fatal("cancellation boundary mismatch")
			}
			count := len(entries(t, f.path))
			if count != map[bool]int{false: 1, true: 2}[possible] {
				t.Fatal("canceled evidence not retained")
			}
		})
	}
}
func TestOriginalCancellationAndDeadlineDuringActualReturn(t *testing.T) {
	for _, kind := range []string{"original-cancel", "original-deadline", "caller-deadline"} {
		t.Run(kind, func(t *testing.T) {
			f := setup(t)
			original, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.ctx = original
			var lag *lagContext
			if kind == "original-deadline" {
				lag = &lagContext{Context: context.Background(), until: time.Now().Add(100 * time.Millisecond)}
				f.ctx = lag
			}
			r := f.open(t)
			ctx := context.Background()
			if kind == "caller-deadline" {
				lag = &lagContext{Context: context.Background(), until: time.Now().Add(100 * time.Millisecond)}
				ctx = lag
			}
			cause := errors.Join(failure("directory", false, false, nil), unix.EIO)
			entered, drain := make(chan struct{}), make(chan struct{})
			r.state.write = func(*os.File, []byte) (int, error) { close(entered); <-drain; return 0, cause }
			finished := make(chan error, 1)
			go func() { finished <- r.Record(ctx, f.expected) }()
			select {
			case <-entered:
			case err := <-finished:
				t.Fatalf("native seam not reached: %v", err)
			}
			want := context.Canceled
			if kind == "original-cancel" {
				cancel()
			} else {
				time.Sleep(time.Until(lag.until) + time.Millisecond)
				want = context.DeadlineExceeded
			}
			if f.owner.gate.TryLock() {
				f.owner.gate.Unlock()
				close(drain)
				t.Fatal("gate released before late return")
			}
			close(drain)
			err := <-finished
			classified(t, err, "native", true, true)
			if !errors.Is(err, cause) || !errors.Is(err, want) || !f.owner.unknown {
				t.Fatal("late opaque failure downgraded")
			}
			if lag != nil && lag.calls.Load() != 1 {
				t.Fatal("lagging deadline reread")
			}
		})
	}
}

// An unwind is no acknowledgement even when complete bytes are visible. The
// original gate and owner must survive both panic and Goexit after persistence.
func TestIncompleteRecordScopeRetainsOriginalOwner(t *testing.T) {
	for _, kind := range []string{"panic", "goexit"} {
		for _, point := range []string{"create-before", "create-after", "ack-before"} {
			t.Run(kind+"-"+point, func(t *testing.T) {
				f := setup(t)
				r := f.open(t)
				marker := new(int)
				r.state.step = func(at string) error {
					if at == point {
						if kind == "panic" {
							panic(marker)
						}
						runtime.Goexit()
					}
					return nil
				}
				done := make(chan struct{})
				observed := make(chan any, 1)
				go func() {
					defer close(done)
					defer func() {
						if v := recover(); v != nil {
							observed <- v
						}
					}()
					_ = r.Record(context.Background(), f.expected)
				}()
				<-done
				if kind == "panic" {
					select {
					case v := <-observed:
						if v != marker {
							t.Fatal("original panic replaced")
						}
					default:
						t.Fatal("panic swallowed")
					}
				}
				possible := point != "create-before"
				if f.owner.unknown != possible {
					t.Fatal("incomplete persistence scope did not retain original owner")
				}
				if !f.owner.gate.TryLock() {
					t.Fatal("gate not released after actual unwind")
				}
				f.owner.gate.Unlock()
				classified(t, r.Record(context.Background(), f.expected), "attempt_used", false, possible)
				if possible {
					again, err := New(f.ctx, f.file, f.owner.binding, f.owner.op, f.owner, f.until)
					if again != nil {
						t.Fatal("new adapter cleared incomplete persistence")
					}
					classified(t, err, "unknown", false, true)
				}
			})
		}
	}
}

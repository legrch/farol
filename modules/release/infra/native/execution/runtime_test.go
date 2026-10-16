package execution

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
	"golang.org/x/sys/unix"
)

// Native filesystem primitives are real, disposable Darwin/Linux operations.
// The route/admission/journal seams are symbolic and prove no installed helper,
// package, live lease/slot, startup acceptance, or production cutover.
type testJournal struct {
	view   port.JournalView
	read   func(context.Context) (*port.JournalView, error)
	writes int
	closed bool
}

func (j *testJournal) Read(ctx context.Context) (*port.JournalView, error) { return j.ReadHelper(ctx) }
func (j *testJournal) ReadHelper(ctx context.Context) (*port.JournalView, error) {
	if j.read != nil {
		return j.read(ctx)
	}
	v, value := j.view, *j.view.Value
	v.Value = &value
	return &v, nil
}
func (j *testJournal) CompareAndSwap(_ context.Context, revision string, value release.Journal) (*port.JournalView, error) {
	if revision != j.view.Revision {
		return nil, port.JournalConflict
	}
	j.writes++
	j.view = port.JournalView{Value: &value, Revision: strings.Repeat("b", 64)}
	return &j.view, nil
}
func (j *testJournal) Close() error { j.closed = true; return nil }

type fixture struct {
	config          Config
	journal         *testJournal
	apps, operation string
	unknown         error
	mu              sync.Mutex
	routes          func(context.Context) error
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{apps: filepath.Join(t.TempDir(), "Applications"), operation: filepath.Join(t.TempDir(), "operation"), routes: func(c context.Context) error { return c.Err() }}
	open := func(path string) (*os.File, helperroutes.Identity) {
		must(t, os.Mkdir(path, 0700))
		p, err := os.Open(path)
		must(t, err)
		t.Cleanup(func() {
			if err := p.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
				t.Error(err)
			}
		})
		var s unix.Stat_t
		raw, err := p.SyscallConn()
		must(t, err)
		must(t, raw.Control(func(fd uintptr) { err = unix.Fstat(int(fd), &s) }))
		must(t, err)
		i := snapshot(entryState{present: true, stat: s}).Identity
		return p, helperroutes.Identity{Device: i.Device, Inode: i.Inode}
	}
	app, ai := open(f.apps)
	op, oi := open(f.operation)
	r := port.HelperRequest{OperationID: strings.Repeat("e", 32), Source: port.HelperBuild{Digest: strings.Repeat("a", 64), Version: "1.2.3-preview.4", BuildID: strings.Repeat("a", 64)}, Target: port.HelperBuild{Digest: strings.Repeat("c", 64), Version: "1.2.4-preview.4", BuildID: strings.Repeat("d", 64)}}
	v := release.Journal{Operation: operation(r), Phase: "prepared"}
	f.journal = &testJournal{view: port.JournalView{Value: &v, Revision: strings.Repeat("a", 64)}}
	f.config = Config{Request: r, Journal: f.journal, Files: helperroutes.Files{Applications: app, ApplicationsIdentity: ai, Operation: op, OperationIdentity: oi}, Until: time.Now().Add(time.Minute), Reverify: func(c context.Context, got port.HelperRequest) error {
		if got.OperationID != r.OperationID {
			return errors.New("request mismatch")
		}
		return c.Err()
	}, Unknown: func() error { f.mu.Lock(); defer f.mu.Unlock(); return f.unknown }, RetainUnknown: func(e error) { f.mu.Lock(); defer f.mu.Unlock(); f.unknown = errors.Join(f.unknown, e) }}
	return f
}
func (f *fixture) with(ctx context.Context, fn func(port.HelperRecoveryRuntime) error) error {
	return with(ctx, f.config, f.routes, fn)
}
func classified(t *testing.T, err error, code string, unknown bool) {
	t.Helper()
	var f *port.HelperRecoveryFailure
	if !errors.As(err, &f) || f.Code != code || f.Uncertain != unknown {
		t.Fatalf("classification want %s unknown=%v got %#v", code, unknown, err)
	}
}

func TestProductionRequiresActualLiveBorrow(t *testing.T) {
	f := newFixture(t)
	called := false
	err := With(context.Background(), f.config, func(port.HelperRecoveryRuntime) error { called = true; return nil })
	if err == nil || called {
		t.Fatal("raw descriptors substituted for actual route scope")
	}
	if f.journal.closed || f.journal.writes != 0 {
		t.Fatal("borrow refusal changed journal")
	}
}
func TestReadWriteJournalCopiesAndScope(t *testing.T) {
	f := newFixture(t)
	var kept port.HelperRecoveryRuntime
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		kept = r
		phase, err := r.ReadPhase(context.Background())
		must(t, err)
		if phase != "prepared" {
			t.Fatal(phase)
		}
		// Mutating adapter-owned projection cannot replace runtime's CAS witness.
		f.journal.view.Value.Phase = "verified"
		return r.WritePhase(context.Background(), "predecessor_saved")
	}))
	if f.journal.writes != 1 || f.journal.closed {
		t.Fatal("journal ownership/persistence changed")
	}
	classified(t, kept.Fence(context.Background()), "runtime_closed", false)
	for _, p := range []*os.File{f.config.Files.Applications, f.config.Files.Operation} {
		_, err := p.Stat()
		must(t, err)
	}
}
func TestCopiesAndPanicDoNotExtendScope(t *testing.T) {
	f := newFixture(t)
	var kept port.HelperRecoveryRuntime
	func() {
		defer func() {
			if recover() == nil {
				t.Error("panic disappeared")
			}
		}()
		_ = f.with(context.Background(), func(r port.HelperRecoveryRuntime) error { kept = r; panic("test callback") })
	}()
	classified(t, kept.Fence(context.Background()), "runtime_closed", false)
}

func TestRequestPointersCannotChangeOwnerBinding(t *testing.T) {
	f := newFixture(t)
	location := "legacy"
	identity := port.HelperIdentity{Device: "1", Inode: "2"}
	f.config.Request.InstallLocation = &location
	f.config.Request.LeaseIdentity = &identity
	f.config.Reverify = func(_ context.Context, r port.HelperRequest) error {
		if *r.InstallLocation != "legacy" || *r.LeaseIdentity != (port.HelperIdentity{Device: "1", Inode: "2"}) {
			return errors.New("request alias changed binding")
		}
		*r.InstallLocation = "shared"
		r.LeaseIdentity.Inode = "99"
		return nil
	}
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		location = "shared"
		identity.Inode = "88"
		return r.Fence(context.Background())
	}))
}

func TestWithJoinsAnAlreadyRunningMethodBeforeScopeEnds(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, drain, callbackReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	f.journal.read = func(context.Context) (*port.JournalView, error) { close(entered); <-drain; return &f.journal.view, nil }
	method, done := make(chan error, 1), make(chan error, 1)
	go func() {
		done <- f.with(ctx, func(r port.HelperRecoveryRuntime) error {
			go func() { _, err := r.ReadPhase(context.Background()); method <- err }()
			<-entered
			close(callbackReturned)
			return nil
		})
	}()
	<-callbackReturned
	cancel()
	select {
	case <-done:
		t.Fatal("scope ended before already running native method returned")
	default:
	}
	close(drain)
	if !errors.Is(<-method, context.Canceled) || !errors.Is(<-done, context.Canceled) {
		t.Fatal("scope/method cancellation lost")
	}
	if f.journal.closed {
		t.Fatal("borrowed journal was closed")
	}
}

type laggingContext struct {
	context.Context
	until time.Time
}

func (c laggingContext) Deadline() (time.Time, bool) { return c.until, true }
func TestOriginalDeadlineNoLateReadAndActualReturn(t *testing.T) {
	for _, kind := range []string{"deadline", "cancel", "opaque-deadline"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			entered, drain := make(chan struct{}), make(chan struct{})
			var active atomic.Bool
			until := time.Now().Add(100 * time.Millisecond)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if kind != "cancel" {
				ctx = laggingContext{Context: context.Background(), until: until}
			}
			opaque := errors.New("private native query cause")
			f.journal.read = func(context.Context) (*port.JournalView, error) {
				active.Store(true)
				close(entered)
				<-drain
				active.Store(false)
				if kind == "opaque-deadline" {
					return nil, opaque
				}
				return &f.journal.view, nil
			}
			done := make(chan error, 1)
			go func() {
				done <- f.with(ctx, func(r port.HelperRecoveryRuntime) error {
					phase, err := r.ReadPhase(context.Background())
					if phase != "" {
						return errors.New("late phase success")
					}
					return err
				})
			}()
			<-entered
			if kind == "cancel" {
				cancel()
			} else {
				time.Sleep(time.Until(until) + time.Millisecond)
			}
			select {
			case <-done:
				t.Fatal("returned before actual query completion")
			default:
			}
			if !active.Load() {
				t.Fatal("fixture did not retain query")
			}
			close(drain)
			err := <-done
			if err == nil {
				t.Fatal("late read succeeded")
			}
			want := context.DeadlineExceeded
			if kind == "cancel" {
				want = context.Canceled
			}
			if !errors.Is(err, want) {
				t.Fatal("lost cancellation", err)
			}
			if kind == "opaque-deadline" {
				if !errors.Is(err, opaque) {
					t.Fatal("lost opaque query failure")
				}
				var failure *port.HelperRecoveryFailure
				if !errors.As(err, &failure) || !failure.Internal {
					t.Fatal("opaque failure downgraded")
				}
			}
			if f.journal.closed {
				t.Fatal("borrowed repository closed during cancellation")
			}
		})
	}
}
func TestNativeEntriesAndOneAttemptRename(t *testing.T) {
	f := newFixture(t)
	must(t, os.Mkdir(filepath.Join(f.operation, "staged.app"), 0700))
	must(t, os.WriteFile(filepath.Join(f.operation, "rejected-target.json"), []byte("preserved"), 0600))
	err := f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		entries, err := r.Entries(context.Background())
		must(t, err)
		if entries.App.Present || !entries.Staged.Directory || !entries.Staged.OwnedByEffectiveUser || !entries.RejectedTarget.Present || entries.RejectedTarget.Directory {
			t.Fatal("incorrect fixed entry observation")
		}
		must(t, r.Rename(context.Background(), port.Staged, port.App, entries.Staged.Identity))
		again, err := r.Entries(context.Background())
		must(t, err)
		if again.Staged.Present || again.App.Identity != entries.Staged.Identity {
			t.Fatal("rename readback differs")
		}
		classified(t, r.Rename(context.Background(), port.Staged, port.App, entries.Staged.Identity), "recovery_attempt_unknown", true)
		return nil
	})
	classified(t, err, "recovery_attempt_unknown", true)
}
func TestUnknownEffectSurvivesNewRuntime(t *testing.T) {
	f := newFixture(t)
	must(t, os.Mkdir(filepath.Join(f.operation, "staged.app"), 0700))
	_ = f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		e, err := r.Entries(context.Background())
		must(t, err)
		must(t, r.Rename(context.Background(), port.Staged, port.App, e.Staged.Identity))
		return r.Rename(context.Background(), port.Staged, port.App, e.Staged.Identity)
	})
	called := false
	err := f.with(context.Background(), func(port.HelperRecoveryRuntime) error { called = true; return nil })
	if err == nil || called || f.unknown == nil {
		t.Fatal("fresh runtime cleared original unknown")
	}
}
func treeFixture(t *testing.T, f *fixture) {
	t.Helper()
	base := filepath.Join(f.apps, "Farol.app")
	must(t, os.MkdirAll(filepath.Join(base, "Contents/Resources/app"), 0700))
	for _, p := range []struct{ from, to string }{{"oracle.xml", "Contents/Info.plist"}, {"oracle.json", "Contents/Resources/app/build-identity.json"}} {
		data, err := os.ReadFile(filepath.Join("..", "appidentity", "testdata", p.from))
		must(t, err)
		must(t, os.WriteFile(filepath.Join(base, p.to), data, 0600))
	}
}
func TestNativeTreePositiveNegativeAndErrors(t *testing.T) {
	f := newFixture(t)
	treeFixture(t, f)
	build := f.config.Request.Source
	build.Digest = "aa5be957bca1b602513cc520d48ebabb39a79adfffe07ee47434fbc33f4a62bd"
	must(t, f.with(context.Background(), func(r port.HelperRecoveryRuntime) error {
		match, err := r.MatchesTree(context.Background(), port.App, build)
		must(t, err)
		if !match {
			t.Fatal("original pinned tree did not match")
		}
		must(t, r.VerifyTree(context.Background(), port.App, build))
		for _, kind := range []string{"digest", "identity", "absent"} {
			bad := build
			entry := port.App
			switch kind {
			case "digest":
				bad.Digest = strings.Repeat("f", 64)
			case "identity":
				bad.Version = "2.0.0"
			case "absent":
				entry = port.Staged
			}
			match, err := r.MatchesTree(context.Background(), entry, bad)
			must(t, err)
			if match {
				t.Fatal("negative observation matched", kind)
			}
		}
		bad := build
		bad.Digest = "unparsed"
		if match, err := r.MatchesTree(context.Background(), port.App, bad); err == nil || match {
			t.Fatal("invalid verifier input downgraded to negative match")
		}
		if match, err := r.MatchesTree(context.Background(), port.RejectedTarget, build); err == nil || match {
			t.Fatal("record entry treated as tree")
		}
		return nil
	}))
}

package helperroutes

import (
	"context"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// Its deadline is fixed but timer delivery deliberately never occurs. This
// models a physically elapsed absolute bound before Err/Done are observable.
type laggingContext struct {
	context.Context
	until time.Time
	done  <-chan struct{}
}

func lagging(until time.Time) context.Context {
	return laggingContext{Context: context.Background(), until: until, done: make(chan struct{})}
}
func (c laggingContext) Deadline() (time.Time, bool) { return c.until, true }
func (c laggingContext) Done() <-chan struct{}       { return c.done }
func (c laggingContext) Err() error                  { return nil }

func TestElapsedLaggingDeadlineRefusesBeforeAnyIO(t *testing.T) {
	f := newFixture(t)
	called := false
	f.fs.rootStat = func(*unix.Stat_t) error { called = true; return unix.EIO }
	ctx := lagging(time.Now().Add(-time.Second))
	_, err := openExisting(ctx, "/home", operationID, "legacy", time.Now().Add(time.Minute), f.fs)
	classified(t, err, CodeContext, false)
	if called || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("elapsed opening deadline reached IO or lost cause")
	}

	f = newFixture(t)
	r := f.open(t)
	r.owner.fs.rootStat = func(*unix.Stat_t) error { called = true; return unix.EIO }
	for _, err := range []error{
		r.Verify(ctx),
		r.WithFiles(ctx, func(Files) error { t.Fatal("elapsed subsequent context entered callback"); return nil }),
	} {
		classified(t, err, CodeContext, false)
		if called || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("elapsed subsequent context reached IO or lost cause")
		}
	}
}

func TestLaggingDeadlineStillBoundsGateWait(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	entered, release, first := make(chan struct{}), make(chan struct{}), make(chan error, 1)
	go func() {
		first <- r.WithFiles(context.Background(), func(Files) error { close(entered); <-release; return nil })
	}()
	<-entered
	defer func() { close(release); must(t, <-first) }()
	result := make(chan error, 1)
	go func() { result <- r.Verify(lagging(time.Now().Add(20 * time.Millisecond))) }()
	select {
	case err := <-result:
		classified(t, err, CodeContext, false)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("gate lost deadline")
		}
	case <-time.After(time.Second):
		t.Fatal("gate depended on lagging Done delivery")
	}
}

func TestLaggingDeadlineAfterCallbackAndNativeReturnPreservesCauses(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	deadline := time.Now().Add(200 * time.Millisecond)
	ctx := lagging(deadline)
	cause := errors.New("exact callback failure")
	original := r.owner.fs.rootStat
	err := r.WithFiles(ctx, func(Files) error {
		// Make the first postcallback native return occur after the fixed bound;
		// Err/Done remain unsignalled even then. This also proves the native and
		// callback causes survive the independent absolute deadline check.
		r.owner.fs.rootStat = func(s *unix.Stat_t) error {
			<-time.After(time.Until(deadline))
			_ = original(s)
			return unix.EIO
		}
		return cause
	})
	classified(t, err, CodeCallback, true)
	if !errors.Is(err, cause) || !errors.Is(err, unix.EIO) || !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("postreturn callback/native/deadline cause lost")
	}
}

func TestScopedReverifyAndEscapedScope(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	var escaped Files
	must(t, r.WithFiles(context.Background(), func(files Files) error {
		escaped = files
		must(t, files.Reverify(context.Background()))
		return nil
	}))
	called := false
	r.owner.fs.rootStat = func(*unix.Stat_t) error { called = true; return unix.EIO }
	classified(t, escaped.Reverify(context.Background()), CodeBorrow, false)
	if called {
		t.Fatal("escaped scope reached IO")
	}
	classified(t, (Files{}).Reverify(context.Background()), CodeDependency, true)
}

func TestScopedReverifyDetectsReplacedNamedPath(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	err := r.WithFiles(context.Background(), func(files Files) error {
		must(t, os.Rename(f.operation, f.operation+"-old"))
		must(t, os.Mkdir(f.operation, 0700))
		err := files.Reverify(context.Background())
		classified(t, err, CodeChanged, false)
		return err
	})
	classified(t, err, CodeCallback, false)
}

func TestScopedReverifyCannotRenewAnyCapturedBound(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	must(t, r.WithFiles(context.Background(), func(files Files) error {
		original := files.scope.until
		if !original.Equal(r.owner.until) {
			t.Fatal("scope lost owner bound")
		}
		must(t, files.Reverify(context.Background()))
		if !files.scope.until.Equal(original) {
			t.Fatal("reverify renewed owner bound")
		}
		called := false
		originalStat := r.owner.fs.rootStat
		r.owner.fs.rootStat = func(s *unix.Stat_t) error { called = true; return originalStat(s) }
		classified(t, files.Reverify(lagging(time.Now().Add(-time.Second))), CodeContext, false)
		if called {
			t.Fatal("reverify ignored earlier supplied bound")
		}
		return nil
	}))

	deadline := time.Now().Add(200 * time.Millisecond)
	err := r.WithFiles(lagging(deadline), func(files Files) error {
		if !files.scope.until.Equal(deadline) {
			t.Fatal("scope lost earlier borrow bound")
		}
		<-time.After(time.Until(deadline))
		called := false
		originalStat := r.owner.fs.rootStat
		r.owner.fs.rootStat = func(s *unix.Stat_t) error { called = true; return originalStat(s) }
		err := files.Reverify(context.Background())
		classified(t, err, CodeContext, false)
		if called || !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal("fresh context renewed borrow bound")
		}
		return err
	})
	classified(t, err, CodeCallback, false)
}

func TestScopedReverifyKeepsOriginalCancellation(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	err := r.WithFiles(ctx, func(files Files) error {
		cancel()
		err := files.Reverify(context.Background())
		classified(t, err, CodeContext, false)
		if !errors.Is(err, context.Canceled) {
			t.Fatal("fresh scope context erased cancellation")
		}
		return err
	})
	classified(t, err, CodeCallback, false)
}

func TestScopeEndWaitsForActualScopedNativeReturn(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	entered, release, callbackReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var once sync.Once
	original := r.owner.fs.rootStat
	result, scoped := make(chan error, 1), make(chan error, 1)
	go func() {
		result <- r.WithFiles(context.Background(), func(files Files) error {
			r.owner.fs.rootStat = func(s *unix.Stat_t) error { once.Do(func() { close(entered); <-release }); return original(s) }
			// This deliberately violates the synchronous-only contract to verify
			// that ending scope still cannot release live native file custody.
			go func() { scoped <- files.Reverify(context.Background()) }()
			<-entered
			classified(t, files.Reverify(context.Background()), CodeBorrow, false)
			close(callbackReturned)
			return nil
		})
	}()
	<-callbackReturned
	select {
	case err := <-result:
		t.Fatalf("scope abandoned native return: %v", err)
	default:
	}
	close(release)
	must(t, <-scoped)
	must(t, <-result)
}

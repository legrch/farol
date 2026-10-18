package journal

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

type observationOwner struct {
	gate    sync.Mutex
	op      release.Operation
	binding port.JournalDirectory
	unknown bool
	checks  int
	verify  func() error
}

func (a *observationOwner) JournalGate() port.StateGate              { return &a.gate }
func (a *observationOwner) JournalUnknown(op release.Operation) bool { return a.unknown || op != a.op }
func (a *observationOwner) RetainJournalUnknown(release.Operation)   { a.unknown = true }
func (a *observationOwner) ReverifyHelperJournalObservation(ctx context.Context, op release.Operation, b port.JournalDirectory) error {
	a.checks++
	if a.unknown || op != a.op || b != a.binding {
		return port.JournalUnproven
	}
	if a.verify != nil {
		return a.verify()
	}
	return ctx.Err()
}

func TestObservationJournalDeterministicNoWriterOrRenewal(t *testing.T) {
	a := &observationOwner{}
	if _, writer := any(a).(port.JournalAdmission); writer {
		t.Fatal("observation impersonates writer admission")
	}
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	called := false
	err := WithObservation(ctx, "/unused", &os.File{}, port.JournalDirectory{}, release.Operation{}, a, func(*Observation) error { called = true; return nil })
	if err == nil || called || a.checks != 0 {
		t.Fatal("expired observation entered native work", err)
	}
	reader := &Observation{repo: &Repo{gate: &a.gate, closed: true}, original: context.Background(), until: time.Now().Add(time.Minute)}
	if _, writer := any(reader).(port.HelperJournalRepository); writer {
		t.Fatal("reader exported CAS")
	}
	if _, writer := any(reader).(port.JournalRepository); writer {
		t.Fatal("reader exported writer")
	}
	ctx, cancel = context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	copy := *reader
	for _, retained := range []*Observation{reader, &copy} {
		if view, err := retained.ReadHelper(ctx); view != nil || !errors.Is(err, port.JournalClosed) {
			t.Fatal("closed reader revived", err)
		}
	}
}

func TestObservationNilAndZeroRefuse(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	for _, reader := range []*Observation{nil, {}} {
		view, err := reader.ReadHelper(ctx)
		if view != nil || !errors.Is(err, port.JournalInvalid) {
			t.Fatal("unbound observation admitted", view, err)
		}
	}
}

// Explicit Root native lane only. Real existing-only filesystem construction
// with a symbolic observation owner; no stopped-writer or process grant exists.
func TestObservationJournalNativeExistingOnly(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled physical journal observation")
	}
	root, err := os.MkdirTemp("", "farol-helper-observation-")
	if err != nil {
		t.Fatal(err)
	}
	t.Log("RETAINED observation fixture:", root)
	f := newFixtureAt(t, root)
	file, err := os.Open(f.path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	a := &observationOwner{op: f.operation}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	// Derive expected identity through the original writer fixture only for
	// comparison. The observation owner still exposes no writer admission.
	r := f.open(t)
	a.binding = r.identity()
	if err := r.Close(); err != nil {
		t.Fatal(err)
	}
	var retained *Observation
	var copied Observation
	err = WithObservation(ctx, f.path, file, a.binding, f.operation, a, func(reader *Observation) error {
		retained = reader
		copied = *reader
		view, err := reader.ReadHelper(ctx)
		if err != nil || view == nil || view.Value != nil || view.Revision == "" {
			t.Fatal(view, err)
		}
		if _, err := os.Lstat(filepath.Join(f.path, filename)); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("preflight wrote journal")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, reader := range []*Observation{retained, &copied} {
		if view, err := reader.ReadHelper(ctx); view != nil || !errors.Is(err, port.JournalClosed) {
			t.Fatal("retained reader revived", err)
		}
	}
	if _, err := file.Stat(); err != nil {
		t.Fatal("borrowed route closed", err)
	}
}

// Real disposable repository construction with a symbolic admission refusal.
// The original cause remains inspectable; no private diagnostic may be printed.
func TestObservationGuardRefusalKeepsPrivateCause(t *testing.T) {
	f := newFixture(t)
	original := f.open(t)
	binding := original.identity()
	if err := original.Close(); err != nil {
		t.Fatal(err)
	}
	borrowed, err := os.Open(f.path)
	if err != nil {
		t.Fatal(err)
	}
	defer borrowed.Close()
	privateCause := errors.New("private admission diagnostic")
	owner := &observationOwner{op: f.operation, binding: binding, verify: func() error { return privateCause }}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	entered := false
	err = WithObservation(ctx, f.path, borrowed, binding, f.operation, owner, func(*Observation) error { entered = true; return nil })
	if entered || !owner.unknown || !errors.Is(err, privateCause) || !errors.Is(err, port.JournalUnproven) {
		t.Fatal("refusal lost cause, uncertainty or admission boundary")
	}
	if strings.Contains(err.Error(), "private admission") || strings.Contains(err.Error(), f.path) {
		t.Fatal("private admission diagnostic exposed")
	}
	if _, err := borrowed.Stat(); err != nil {
		t.Fatal("borrowed route closed", err)
	}
}

func TestObservationTypedNilPrivateFailureIsSafe(t *testing.T) {
	var cause *failure
	if cause.Error() != port.JournalUnavailable.Error() || len(cause.Unwrap()) != 0 {
		t.Fatal("nil private failure changed safe text or invented causes")
	}
	var original *failure
	if !errors.As(cause, &original) || original != nil {
		t.Fatal("typed-nil private cause lost its type")
	}
	var missing *os.PathError
	if errors.As(cause, &missing) || errors.Is(cause, errors.New("unrelated sentinel")) {
		t.Fatal("nil private failure invented a cause")
	}
}

// Root-scheduled disposable filesystem with symbolic admission only. These
// cases prove no live helper, stopped writer, process, lease or installed grant.
func TestObservationCallbackFailuresKeepPrivateCauses(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled physical callback failure regression")
	}
	for _, kind := range []string{"plain", "joined", "opaque", "typed-nil", "typed-nil-joined"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			original := f.open(t)
			binding := original.identity()
			if err := original.Close(); err != nil {
				t.Fatal(err)
			}
			borrowed, err := os.Open(f.path)
			if err != nil {
				t.Fatal(err)
			}
			defer borrowed.Close()
			info, err := borrowed.Stat()
			if err != nil {
				t.Fatal(err)
			}
			before, valid := metadata(info)
			if !valid {
				t.Fatal("borrowed metadata unavailable")
			}

			privateCause := errors.New("private callback diagnostic")
			nativeCause := errors.New("private callback native diagnostic")
			pathCause := &os.PathError{Op: "observe", Path: f.path, Err: nativeCause}
			refusal := &port.HelperRecoveryFailure{Code: "refused", Phase: "prepared", Cause: privateCause}
			var nilCause *failure
			callbackCause := error(privateCause)
			want := []error{privateCause}
			structured := kind == "joined" || kind == "opaque" || kind == "typed-nil-joined"
			if structured {
				callbackCause = errors.Join(privateCause, pathCause, refusal)
				want = append(want, nativeCause, pathCause, refusal)
			}
			switch kind {
			case "opaque":
				callbackCause = fmt.Errorf("private callback wrapper: %w", callbackCause)
			case "typed-nil":
				callbackCause = nilCause
				want = []error{nilCause}
			case "typed-nil-joined":
				callbackCause = errors.Join(nilCause, callbackCause)
				want = append(want, nilCause)
			}

			owner := &observationOwner{op: f.operation, binding: binding}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var retained *Observation
			var copied Observation
			err = WithObservation(ctx, f.path, borrowed, binding, f.operation, owner, func(reader *Observation) error {
				retained = reader
				copied = *reader
				view, err := reader.ReadHelper(ctx)
				if err != nil || view == nil || view.Value != nil || view.Revision == "" {
					t.Fatal("callback did not observe original journal absence")
				}
				return callbackCause
			})
			if retained == nil || err == nil || err.Error() != port.JournalUnavailable.Error() {
				t.Fatal("callback failure did not retain fixed public text")
			}
			if !owner.JournalUnknown(f.operation) || !errors.Is(err, port.JournalUnavailable) || !errors.Is(err, callbackCause) {
				t.Fatal("callback failure lost original cause or retained uncertainty")
			}
			for _, cause := range want {
				if !errors.Is(err, cause) {
					t.Fatal("callback failure lost original sentinel membership")
				}
			}
			if structured {
				var path *os.PathError
				var nested *port.HelperRecoveryFailure
				if !errors.As(err, &path) || path != pathCause || !errors.As(err, &nested) || nested != refusal {
					t.Fatal("callback failure lost structured private causes")
				}
			}
			var missing *os.LinkError
			if errors.Is(err, errors.New("unrelated callback sentinel")) || errors.As(err, &missing) {
				t.Fatal("callback failure invented an unrelated cause")
			}
			checks := owner.checks
			for _, reader := range []*Observation{retained, &copied} {
				if view, err := reader.ReadHelper(ctx); view != nil || !errors.Is(err, port.JournalClosed) {
					t.Fatal("failed callback retained a live reader")
				}
				if _, writer := any(reader).(port.JournalRepository); writer {
					t.Fatal("observation exposed a writer")
				}
			}
			if !owner.JournalUnknown(f.operation) || owner.checks != checks {
				t.Fatal("closed observation renewed admission or cleared uncertainty")
			}
			if f.admission.unknown || f.admission.retained != 0 || f.admission.verified != 1 {
				t.Fatal("observation changed original writer admission")
			}
			info, err = borrowed.Stat()
			if err != nil {
				t.Fatal("observation closed borrowed ownership")
			}
			after, valid := metadata(info)
			if !valid || after != before {
				t.Fatal("observation changed borrowed identity or metadata")
			}
			if _, err := os.Lstat(filepath.Join(f.path, filename)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("callback failure changed journal absence")
			}
			entries, err := os.ReadDir(f.path)
			if err != nil || len(entries) != 0 {
				t.Fatal("callback failure left a write or repair")
			}
		})
	}
}

// Timer delivery may lag the captured deadline; a fresh method context must
// never extend this enclosing borrow or re-enter admission after it expires.
type laggingObservationContext struct {
	context.Context
	until time.Time
}

func (c laggingObservationContext) Deadline() (time.Time, bool) { return c.until, true }

func TestObservationJournalNativeCannotRenewScope(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled physical journal scope-bound regression")
	}
	for _, kind := range []string{"cancelled", "expired-without-timer-notification"} {
		t.Run(kind, func(t *testing.T) {
			root, err := os.MkdirTemp("", "farol-helper-observation-bound-")
			if err != nil {
				t.Fatal(err)
			}
			t.Log("RETAINED observation-bound fixture:", root)
			f := newFixtureAt(t, root)
			original := f.open(t)
			binding := original.identity()
			if err := original.Close(); err != nil {
				t.Fatal(err)
			}
			borrowed, err := os.Open(f.path)
			if err != nil {
				t.Fatal(err)
			}
			defer borrowed.Close()
			owner := &observationOwner{op: f.operation, binding: binding}
			scoped, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			var scope context.Context = scoped
			until := time.Now().Add(250 * time.Millisecond)
			if kind != "cancelled" {
				scope = laggingObservationContext{Context: context.Background(), until: until}
			}
			entered := false
			var readErr error
			result := WithObservation(scope, f.path, borrowed, binding, f.operation, owner, func(reader *Observation) error {
				entered = true
				if kind == "cancelled" {
					cancel()
				} else {
					time.Sleep(time.Until(until) + 2*time.Millisecond)
				}
				before := owner.checks
				fresh, stop := context.WithTimeout(context.Background(), time.Minute)
				defer stop()
				view, err := reader.ReadHelper(fresh)
				readErr = err
				if view != nil || !errors.Is(err, port.JournalCancelled) {
					t.Error("fresh method context renewed the expired enclosing observation")
				}
				if owner.checks != before {
					t.Error("expired enclosing scope re-entered physical admission")
				}
				return err
			})
			if !entered || readErr == nil || result == nil {
				t.Fatal("original scope or per-method refusal not observed")
			}
			if kind == "cancelled" && !errors.Is(readErr, context.Canceled) {
				t.Error("original cancellation cause lost")
			}
			if kind != "cancelled" && !errors.Is(readErr, context.DeadlineExceeded) {
				t.Error("captured absolute deadline cause lost")
			}
			if _, err := borrowed.Stat(); err != nil {
				t.Fatal("borrowed route closed")
			}
			if _, err := os.Lstat(filepath.Join(f.path, filename)); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("scope-bound regression created a journal")
			}
		})
	}
}

// Same original gate, with an attempt signal to order two real repository
// scopes. This is disposable filesystem/admission coverage, not process proof.
type observationSignalGate struct {
	mu        sync.Mutex
	notify    atomic.Bool
	attempted chan struct{}
	once      sync.Once
}

func (g *observationSignalGate) Lock() {
	if g.notify.Load() {
		g.once.Do(func() { close(g.attempted) })
	}
	g.mu.Lock()
}
func (g *observationSignalGate) Unlock() { g.mu.Unlock() }

type blockedObservationRetention struct {
	observationOwner
	shared  observationSignalGate
	entered chan struct{}
	resume  chan struct{}
	first   sync.Once
	outside bool
}

func (a *blockedObservationRetention) JournalGate() port.StateGate { return &a.shared }
func (a *blockedObservationRetention) RetainJournalUnknown(op release.Operation) {
	a.first.Do(func() {
		if a.shared.mu.TryLock() {
			a.outside = true
			a.shared.mu.Unlock()
		}
		close(a.entered)
		<-a.resume
	})
	a.observationOwner.RetainJournalUnknown(op)
}

func TestObservationJournalNativeRetentionSharesGate(t *testing.T) {
	if os.Getenv("FAROL_HELPER_NATIVE") != "1" {
		t.Skip("Root-scheduled physical observation retention concurrency")
	}
	for _, kind := range []string{"callback-failure", "callback-panic"} {
		t.Run(kind, func(t *testing.T) {
			root, err := os.MkdirTemp("", "farol-helper-observation-retention-")
			if err != nil {
				t.Fatal(err)
			}
			t.Log("RETAINED observation-retention fixture:", root)
			f := newFixtureAt(t, root)
			original := f.open(t)
			binding := original.identity()
			if err := original.Close(); err != nil {
				t.Fatal(err)
			}
			first, err := os.Open(f.path)
			if err != nil {
				t.Fatal(err)
			}
			defer first.Close()
			second, err := os.Open(f.path)
			if err != nil {
				t.Fatal(err)
			}
			defer second.Close()
			owner := &blockedObservationRetention{observationOwner: observationOwner{op: f.operation, binding: binding}, entered: make(chan struct{}), resume: make(chan struct{})}
			owner.shared.attempted = make(chan struct{})
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			private := errors.New("private observation failure")
			type completion struct {
				err       error
				recovered any
			}
			failed := make(chan completion, 1)
			go func() {
				var result completion
				defer func() { result.recovered = recover(); failed <- result }()
				result.err = WithObservation(ctx, f.path, first, binding, f.operation, owner, func(*Observation) error {
					if kind == "callback-panic" {
						panic(private)
					}
					return private
				})
			}()
			<-owner.entered
			outside := owner.outside
			owner.shared.notify.Store(true)
			opened := make(chan struct{})
			sibling := make(chan error, 1)
			go func() {
				sibling <- WithObservation(ctx, f.path, second, binding, f.operation, owner, func(*Observation) error { close(opened); return nil })
			}()
			<-owner.shared.attempted
			admitted := false
			select {
			case <-opened:
				admitted = true
			case <-time.After(20 * time.Millisecond):
			}
			close(owner.resume)
			result := <-failed
			other := <-sibling
			if outside || admitted || !errors.Is(other, port.JournalUnknown) {
				t.Error("scope failure publication escaped its gate or allowed sibling admission")
			}
			if kind == "callback-panic" {
				if result.recovered != private {
					t.Error("scope did not preserve original panic")
				}
			} else if result.recovered != nil || !errors.Is(result.err, private) {
				t.Error("scope lost its original failure")
			}
			if _, err := first.Stat(); err != nil {
				t.Error("first borrowed route closed")
			}
			if _, err := second.Stat(); err != nil {
				t.Error("second borrowed route closed")
			}
		})
	}
}

package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
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
	reader := &Observation{repo: &Repo{gate: &a.gate, closed: true}}
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

package journal

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/repos/records"
)

type admissionFixture struct {
	operation          release.Operation
	directory          port.JournalDirectory
	unknown            bool
	verified, retained int
	verify             func(context.Context) error
	gate               *sync.Mutex
}

func (a *admissionFixture) JournalGate() port.StateGate {
	if a.gate == nil {
		return nil
	}
	return a.gate
}

func (a *admissionFixture) ReverifyJournal(ctx context.Context, op release.Operation, dir port.JournalDirectory) error {
	a.verified++
	if op != a.operation || dir != a.directory || a.unknown {
		return errors.New("unproven fixture authority")
	}
	if a.verify != nil {
		return a.verify(ctx)
	}
	return nil
}
func (a *admissionFixture) JournalUnknown(op release.Operation) bool {
	return a.unknown || op != a.operation
}
func (a *admissionFixture) RetainJournalUnknown(op release.Operation) {
	if op == a.operation {
		a.unknown = true
		a.retained++
	}
}

type fixture struct {
	path      string
	operation release.Operation
	admission *admissionFixture
	gate      *sync.Mutex
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return newFixtureAt(t, t.TempDir())
}

func newFixtureAt(t *testing.T, directory string) *fixture {
	t.Helper()
	// Real disposable filesystem; admission is symbolic. No live profile,
	// accepted package or process/helper quiescence is proved by this fixture.
	parent, err := filepath.EvalSymlinks(directory)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0o700); err != nil {
		t.Fatal(err)
	}
	op := release.Operation{ID: strings.Repeat("e", 32), Source: release.Build{Digest: strings.Repeat("a", 64), Version: "0.1.8-owner.beta.1", BuildID: strings.Repeat("b", 64)}, Target: release.Build{Digest: strings.Repeat("c", 64), Version: "0.1.9-owner.beta.1", BuildID: strings.Repeat("d", 64)}}
	path := filepath.Join(parent, op.ID)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	state, ok := metadata(info)
	if !ok {
		t.Fatal("native metadata missing")
	}
	parentInfo, err := os.Lstat(parent)
	if err != nil {
		t.Fatal(err)
	}
	anchor, ok := metadata(parentInfo)
	if !ok {
		t.Fatal("missing ancestor metadata")
	}
	a := &admissionFixture{gate: &sync.Mutex{}, operation: op, directory: port.JournalDirectory{Device: strconv.FormatUint(state.Device, 10), Inode: strconv.FormatUint(state.Inode, 10), ParentDevice: strconv.FormatUint(anchor.Device, 10), ParentInode: strconv.FormatUint(anchor.Inode, 10)}}
	return &fixture{path, op, a, a.gate}
}
func (f *fixture) open(t *testing.T) *Repo {
	t.Helper()
	r, err := New(context.Background(), f.path, f.operation, f.admission)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(); err != nil {
			t.Error(err)
		}
	})
	return r
}
func (f *fixture) value(phase string) release.Journal {
	return release.Journal{Operation: f.operation, Phase: phase}
}
func (f *fixture) encoded(t *testing.T, phase string) []byte {
	t.Helper()
	data, err := records.EncodeJournal(record(f.value(phase)))
	if err != nil {
		t.Fatal(err)
	}
	return data
}
func (f *fixture) put(t *testing.T, phase string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.path, filename), f.encoded(t, phase), 0o600); err != nil {
		t.Fatal(err)
	}
}
func mustRead(t *testing.T, r *Repo) *port.JournalView {
	t.Helper()
	view, err := r.Read(context.Background())
	if err != nil || view == nil {
		t.Fatalf("read: %v", err)
	}
	return view
}
func requireError(t *testing.T, err, want error) {
	t.Helper()
	if !errors.Is(err, want) {
		t.Fatalf("error %v, want %v", err, want)
	}
}
func noTemporary(t *testing.T, f *fixture) {
	t.Helper()
	entries, err := os.ReadDir(f.path)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".journal-") {
			t.Fatal("unexpected temporary effect")
		}
	}
}

func TestCurrentAlphaAllPhasesPersist(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	current := mustRead(t, r)
	if current.Value != nil || len(current.Revision) != 64 {
		t.Fatal("absence not represented")
	}
	phases := []string{"prepared", "predecessor_saved", "new_installed", "verified", "rollback_started", "rolled_back", "launch_requested", "completed", "cancelled", "cancel_launch_requested", "cancel_completed", "rollback_launch_requested", "rollback_completed"}
	for _, phase := range phases {
		next, err := r.CompareAndSwap(context.Background(), current.Revision, f.value(phase))
		if err != nil || next == nil || next.Value == nil || *next.Value != f.value(phase) {
			t.Fatalf("%s: %+v %v", phase, next, err)
		}
		physical := mustRead(t, r)
		if physical.Revision != next.Revision || *physical.Value != *next.Value {
			t.Fatal("physical read differs")
		}
		info, err := os.Stat(filepath.Join(f.path, filename))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Fatal("nonprivate journal")
		}
		stale, err := r.CompareAndSwap(context.Background(), current.Revision, f.value(phase))
		if stale != nil {
			t.Fatal("stale CAS succeeded")
		}
		requireError(t, err, port.JournalConflict)
		current = next
		noTemporary(t, f)
	}
	current.Value.Phase = "fabricated"
	if mustRead(t, r).Value.Phase == "fabricated" {
		t.Fatal("mutable view aliases storage")
	}
	if err := os.Mkdir(filepath.Join(f.path, "previous.app"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Read(context.Background()); err != nil {
		t.Fatalf("child link count changed root identity: %v", err)
	}
}

func TestConstructorBindingAndAuthority(t *testing.T) {
	for _, kind := range []string{"nil-admission", "nil-gate", "relative", "wrong-name", "alias", "mode", "missing", "invalid-operation", "cancelled", "unknown", "guard-refused"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			privateCause := errors.New("private fixture error")
			dir, op := f.path, f.operation
			var admission port.JournalAdmission = f.admission
			ctx := context.Background()
			switch kind {
			case "nil-admission":
				admission = nil
			case "nil-gate":
				f.admission.gate = nil
			case "relative":
				dir = op.ID
			case "wrong-name":
				dir = filepath.Dir(f.path)
			case "alias":
				alias := filepath.Join(filepath.Dir(f.path), "alias")
				if err := os.Symlink(filepath.Dir(f.path), alias); err != nil {
					t.Fatal(err)
				}
				dir = filepath.Join(alias, op.ID)
			case "mode":
				if err := os.Chmod(f.path, 0o750); err != nil {
					t.Fatal(err)
				}
			case "missing":
				dir = filepath.Join(f.path, op.ID)
			case "invalid-operation":
				op.Target.Digest = "invalid"
			case "cancelled":
				c, cancel := context.WithCancel(ctx)
				cancel()
				ctx = c
			case "unknown":
				f.admission.unknown = true
			case "guard-refused":
				f.admission.verify = func(context.Context) error { return privateCause }
			}
			r, err := New(ctx, dir, op, admission)
			if r != nil || err == nil {
				if r != nil {
					r.Close()
				}
				t.Fatalf("constructor admitted %s", kind)
			}
			if strings.Contains(err.Error(), "private fixture") || strings.Contains(err.Error(), f.path) {
				t.Fatal("private error exposed")
			}
			noTemporary(t, f)
			if kind == "guard-refused" {
				if !f.admission.unknown || f.admission.retained != 1 {
					t.Fatal("refused guard not retained")
				}
				if !errors.Is(err, privateCause) || !errors.Is(err, port.JournalUnproven) {
					t.Fatal("classified admission failure lost its original cause")
				}
			}
		})
	}
}

func TestUnknownSurvivesAliasesReadAndClose(t *testing.T) {
	for _, point := range []string{"create-after", "ack-before"} {
		t.Run(point, func(t *testing.T) {
			f := newFixture(t)
			first, second := f.open(t), f.open(t)
			before := mustRead(t, first)
			first.step = func(at string) error {
				if at == point {
					return errors.New("lost fixture ACK")
				}
				return nil
			}
			view, err := first.CompareAndSwap(context.Background(), before.Revision, f.value("launch_requested"))
			if view != nil {
				t.Fatal("unknown returned success")
			}
			requireError(t, err, port.JournalUnknown)
			calls := f.admission.verified
			physical := mustRead(t, second)
			if point == "ack-before" {
				if physical.Value == nil || physical.Value.Phase != "launch_requested" {
					t.Fatal("lost ACK removed persisted intent")
				}
				assessment := release.Assess(release.Observation{Operation: f.operation, Journal: physical.Value})
				if assessment.Kind != release.Unresolved {
					t.Fatal("readback invented acceptance")
				}
			} else if physical.Value != nil {
				t.Fatal("temporary creation fabricated journal")
			}
			view, err = second.CompareAndSwap(context.Background(), physical.Revision, f.value("prepared"))
			if view != nil {
				t.Fatal("alias rearmed")
			}
			requireError(t, err, port.JournalUnknown)
			if err := first.Close(); err != nil {
				t.Fatal(err)
			}
			if !f.admission.unknown || f.admission.verified != calls {
				t.Fatal("Close/readback cleared unknown or replayed guard")
			}
			again, err := New(context.Background(), f.path, f.operation, f.admission)
			if again != nil {
				again.Close()
				t.Fatal("new adapter cleared unknown")
			}
			requireError(t, err, port.JournalUnknown)
			if f.admission.verified != calls {
				t.Fatal("unknown acquisition repeated guard")
			}
		})
	}
}

func TestSharedBorrowedGateSerializesCAS(t *testing.T) {
	f := newFixture(t)
	first, second := f.open(t), f.open(t)
	before := mustRead(t, first)
	const attempts = 40
	errs := make(chan error, attempts)
	var wait sync.WaitGroup
	for i := 0; i < attempts; i++ {
		wait.Add(1)
		go func(i int) {
			defer wait.Done()
			r := first
			if i%2 == 1 {
				r = second
			}
			_, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("prepared"))
			errs <- err
		}(i)
	}
	wait.Wait()
	close(errs)
	successes := 0
	for err := range errs {
		if err == nil {
			successes++
		} else if err != port.JournalConflict {
			t.Fatal(err)
		}
	}
	if successes != 1 || f.admission.unknown {
		t.Fatalf("CAS winners %d unknown %v", successes, f.admission.unknown)
	}
	noTemporary(t, f)
}

func TestCloseDrainsIssuedPersistence(t *testing.T) {
	f := newFixture(t)
	r := f.open(t)
	before := mustRead(t, r)
	entered, drain := make(chan struct{}), make(chan struct{})
	r.step = func(at string) error {
		if at == "ack-before" {
			close(entered)
			<-drain
		}
		return nil
	}
	written := make(chan error, 1)
	go func() {
		_, err := r.CompareAndSwap(context.Background(), before.Revision, f.value("prepared"))
		written <- err
	}()
	<-entered
	closing := make(chan error, 1)
	go func() { closing <- r.Close() }()
	select {
	case <-closing:
		t.Fatal("Close bypassed persistence")
	default:
	}
	close(drain)
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	if err := <-closing; err != nil {
		t.Fatal(err)
	}
	value, err := r.Read(context.Background())
	if value != nil {
		t.Fatal("closed read admitted")
	}
	requireError(t, err, port.JournalClosed)
	if f.admission.unknown {
		t.Fatal("Close invented uncertainty")
	}
}

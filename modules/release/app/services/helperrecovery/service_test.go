package helperrecovery

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type parserFunc func(context.Context, []byte) (port.HelperRequest, error)

func (f parserFunc) Parse(ctx context.Context, b []byte) (port.HelperRequest, error) {
	return f(ctx, b)
}

func requestFixture() port.HelperRequest {
	location := "shared"
	return port.HelperRequest{Schema: "farol.installed-update/1", Action: "recover", Home: "/fixture/home", OperationID: strings.Repeat("a", 32),
		Source: port.HelperBuild{Digest: strings.Repeat("b", 64), Version: "0.3.0", BuildID: strings.Repeat("c", 64)},
		Target: port.HelperBuild{Digest: strings.Repeat("d", 64), Version: "0.4.0", BuildID: strings.Repeat("e", 64)},
		Drain:  port.HelperDrain{Status: "reconciled", AcceptedSource: strings.Repeat("c", 64), AcceptedTarget: strings.Repeat("e", 64)},
		PID:    2345, ProcessStart: "Thu Oct 15 12:34:56 2026", WaitSeconds: 30, Relaunch: true, InstallLocation: &location,
	}
}

var entryNames = [...]string{"app", "staged", "previous", "failed", "rejected"}

type fixtureEntry struct {
	meta  port.HelperRecoveryEntrySnapshot
	build port.HelperBuild
}

type runtimeFixture struct {
	t       *testing.T
	request port.HelperRequest
	phase   string
	entries [5]fixtureEntry
	trace   []string
	hook    func(string) error
	ctx     context.Context
}

func newRuntime(t *testing.T, r port.HelperRequest, phase, pattern string) *runtimeFixture {
	f := &runtimeFixture{t: t, request: r, phase: phase}
	for i, kind := range pattern {
		if kind == '-' {
			continue
		}
		f.entries[i].meta = port.HelperRecoveryEntrySnapshot{Present: true, Directory: true, OwnedByEffectiveUser: true, Identity: port.HelperIdentity{Device: "1", Inode: fmt.Sprint(i + 1)}}
		switch kind {
		case 's':
			f.entries[i].build = r.Source
		case 't':
			f.entries[i].build = r.Target
		case 'x':
			f.entries[i].build = port.HelperBuild{Digest: "other", Version: "other", BuildID: "other"}
		default:
			t.Fatal("invalid fixture pattern")
		}
	}
	return f
}

func (f *runtimeFixture) call(ctx context.Context, name string) error {
	if f.ctx != nil && f.ctx != ctx {
		f.t.Fatal("substituted original context/deadline")
	}
	f.trace = append(f.trace, name)
	if f.hook != nil {
		return f.hook(name)
	}
	return nil
}
func (f *runtimeFixture) ReadPhase(ctx context.Context) (string, error) {
	err := f.call(ctx, "phase")
	return f.phase, err
}
func (f *runtimeFixture) Entries(ctx context.Context) (port.HelperRecoveryEntries, error) {
	err := f.call(ctx, "entries")
	return port.HelperRecoveryEntries{App: f.entries[0].meta, Staged: f.entries[1].meta, Previous: f.entries[2].meta, Failed: f.entries[3].meta, RejectedTarget: f.entries[4].meta}, err
}
func (f *runtimeFixture) buildName(b port.HelperBuild) string {
	if b == f.request.Source {
		return "s"
	}
	if b == f.request.Target {
		return "t"
	}
	f.t.Fatal("unexpected build")
	return ""
}
func (f *runtimeFixture) MatchesTree(ctx context.Context, e port.HelperRecoveryEntry, b port.HelperBuild) (bool, error) {
	err := f.call(ctx, "matches:"+entryNames[e]+":"+f.buildName(b))
	return f.entries[e].meta.Present && f.entries[e].build == b, err
}
func (f *runtimeFixture) VerifyTree(ctx context.Context, e port.HelperRecoveryEntry, b port.HelperBuild) error {
	if err := f.call(ctx, "verify:"+entryNames[e]+":"+f.buildName(b)); err != nil {
		return err
	}
	if !f.entries[e].meta.Present || f.entries[e].build != b {
		return nativeRefusal("fixture_tree")
	}
	return nil
}
func (f *runtimeFixture) Fence(ctx context.Context) error { return f.call(ctx, "fence") }
func (f *runtimeFixture) Rename(ctx context.Context, a, b port.HelperRecoveryEntry, id port.HelperIdentity) error {
	if err := f.call(ctx, "rename:"+entryNames[a]+":"+entryNames[b]); err != nil {
		return err
	}
	if !f.entries[a].meta.Present || !f.entries[a].meta.Directory || f.entries[a].meta.Identity != id {
		return nativeRefusal("source_replaced")
	}
	if f.entries[b].meta.Present {
		return nativeRefusal("destination_exists")
	}
	f.entries[b], f.entries[a] = f.entries[a], fixtureEntry{}
	return nil
}
func (f *runtimeFixture) Exchange(ctx context.Context, a, b port.HelperRecoveryEntry, aid, bid port.HelperIdentity) error {
	if err := f.call(ctx, "exchange:"+entryNames[a]+":"+entryNames[b]); err != nil {
		return err
	}
	if !f.entries[a].meta.Present || !f.entries[b].meta.Present || f.entries[a].meta.Identity != aid || f.entries[b].meta.Identity != bid {
		return nativeRefusal("exchange_precondition")
	}
	f.entries[a], f.entries[b] = f.entries[b], f.entries[a]
	return nil
}
func (f *runtimeFixture) WritePhase(ctx context.Context, phase string) error {
	if err := f.call(ctx, "write:"+phase); err != nil {
		return err
	}
	f.phase = phase
	return nil
}
func nativeRefusal(code string) error {
	return &port.HelperRecoveryFailure{Code: code, Phase: "refused"}
}

func bind(t *testing.T, r port.HelperRequest, runtime port.HelperRecoveryRuntime) *Service {
	t.Helper()
	s, err := Bind(context.Background(), []byte("captured"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) { return r, nil }), runtime)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func outcome(phase string, err error) string {
	if err == nil {
		if phase == "" {
			return "ok"
		}
		return phase
	}
	var f *Failure
	if !errors.As(err, &f) {
		return "unexpected unclassified error"
	}
	return f.Code + "@" + f.Phase
}
func requireFailure(t *testing.T, err error, code, phase string, internal, uncertain bool) *Failure {
	t.Helper()
	var f *Failure
	if !errors.As(err, &f) || f.Code != code || f.Phase != phase || f.Internal != internal || f.Uncertain != uncertain || err.Error() != "helper_recovery_failure" {
		t.Fatalf("failure=%#v (%v), want %s/%s internal=%t uncertain=%t", f, err, code, phase, internal, uncertain)
	}
	return f
}

//go:embed testdata/python-oracle.json
var originalOracle []byte

// The fixture is static output of original Python AST functions with only tree
// checks/effects instrumented. It is not a second implementation or native test.
func TestOriginalPythonBranchPhasePairMatrix(t *testing.T) {
	var fixture struct {
		SHA256   string `json:"sha256"`
		Outcomes []string
		Groups   []struct {
			Phase, Action, Inspect, Reconcile string
			Incompatible, Rejected            bool
			Patterns                          []string
		}
	}
	if err := json.Unmarshal(originalOracle, &fixture); err != nil {
		t.Fatal(err)
	}
	source, err := os.ReadFile("../../../../../resources/native/update_helper.py")
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(source)
	if hex.EncodeToString(digest[:]) != fixture.SHA256 {
		t.Fatal("original helper changed; regenerate and review static oracle")
	}
	patterns := []string{}
	for i := range 256 {
		patterns = append(patterns, string([]byte{"-stx"[(i/64)%4], "-stx"[(i/16)%4], "-stx"[(i/4)%4], "-stx"[i%4]}))
	}
	rows := 0
	for _, group := range fixture.Groups {
		pairs := group.Patterns
		if len(pairs) == 0 {
			pairs = patterns
		}
		inspections, err := hex.DecodeString(group.Inspect)
		if err != nil || len(inspections) != len(pairs) {
			t.Fatal("invalid inspect oracle")
		}
		reconciliations, err := hex.DecodeString(group.Reconcile)
		if err != nil || len(reconciliations) != len(pairs) {
			t.Fatal("invalid reconcile oracle")
		}
		for i, pattern := range pairs {
			rows++
			r := requestFixture()
			r.Action = group.Action
			if group.Incompatible {
				r.Source.Version = "0.2.0-owner.beta.3"
			}
			for _, method := range []string{"inspect", "reconcile"} {
				f := newRuntime(t, r, group.Phase, pattern)
				if group.Rejected {
					f.entries[4].meta.Present = true
				}
				s := bind(t, r, f)
				want, result := fixture.Outcomes[inspections[i]], ""
				if method == "inspect" {
					result = outcome("", s.Inspect(context.Background()))
					for _, call := range f.trace {
						if isEffect(call) || call == "fence" {
							t.Fatal("Inspect effected or fenced", call)
						}
					}
				} else {
					want = fixture.Outcomes[reconciliations[i]]
					p, err := s.Reconcile(context.Background())
					result = outcome(p, err)
				}
				if result != want {
					t.Fatalf("row=%d %s phase=%s pair=%s incompatible=%t action=%s rejected=%t got=%s want=%s trace=%v", rows, method, group.Phase, pattern, group.Incompatible, group.Action, group.Rejected, result, want, f.trace)
				}
			}
		}
	}
	if rows != 4354 {
		t.Fatal("oracle row count changed", rows)
	}
}

func isEffect(v string) bool {
	return strings.HasPrefix(v, "rename:") || strings.HasPrefix(v, "exchange:") || strings.HasPrefix(v, "write:")
}

type traceCase struct {
	name, phase, pair, result string
	incompatible              bool
	trace                     []string
}

var traceCases = []traceCase{
	{"cancel unexchanged preparation", "prepared", "st--", "cancelled", false, []string{"phase", "entries", "matches:app:s", "matches:staged:t", "fence", "write:cancelled"}},
	{"finish exchanged preparation", "prepared", "ts--", "verified", false, []string{"phase", "entries", "matches:app:s", "verify:app:t", "verify:staged:s", "fence", "rename:staged:previous", "write:verified"}},
	{"settle installed pair", "new_installed", "t-s-", "verified", false, []string{"phase", "entries", "verify:previous:s", "verify:app:t", "fence", "write:verified"}},
	{"finish preexchange rollback", "rollback_started", "t-s-", "rolled_back", false, []string{"phase", "entries", "matches:app:t", "matches:previous:s", "fence", "exchange:app:previous", "verify:app:s", "verify:previous:t", "fence", "entries", "rename:previous:failed", "write:rolled_back"}},
	{"finish exchanged rollback", "rollback_started", "s-t-", "rolled_back", false, []string{"phase", "entries", "matches:app:t", "verify:app:s", "verify:previous:t", "fence", "entries", "rename:previous:failed", "write:rolled_back"}},
	{"repair former rollback gap", "rollback_started", "--sx", "rolled_back", false, []string{"phase", "entries", "verify:previous:s", "fence", "rename:previous:app", "write:rolled_back"}},
	{"repair former apply gap", "predecessor_saved", "-ts-", "rolled_back", false, []string{"phase", "entries", "verify:previous:s", "verify:staged:t", "fence", "rename:previous:app", "write:rolled_back"}},
	{"record finished rollback", "rollback_started", "s--x", "rolled_back", false, []string{"phase", "entries", "verify:app:s", "fence", "write:rolled_back"}},
	{"retain verified incompatible target", "rollback_started", "t-s-", "verified", true, []string{"phase", "entries", "entries", "matches:app:t", "matches:previous:s", "fence", "entries", "matches:app:t", "matches:previous:s", "write:verified"}},
}

func fixtureCase(t *testing.T, c traceCase) (*Service, *runtimeFixture) {
	r := requestFixture()
	if c.incompatible {
		r.Source.Version = "0.2.0-owner.beta.3"
	}
	f := newRuntime(t, r, c.phase, c.pair)
	return bind(t, r, f), f
}

func TestExactEffectAndJournalOrder(t *testing.T) {
	for _, c := range traceCases {
		t.Run(c.name, func(t *testing.T) {
			s, f := fixtureCase(t, c)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			f.ctx = ctx
			p, err := s.Reconcile(ctx)
			if err != nil || p != c.result || !reflect.DeepEqual(f.trace, c.trace) {
				t.Fatal(p, err, f.trace, "want", c.trace)
			}
		})
	}
}

func TestInspectExactPortOrderAndFailures(t *testing.T) {
	cases := []traceCase{
		{"prepared source", "prepared", "st--", "ok", false, []string{"phase", "entries", "matches:app:s", "matches:staged:t"}},
		{"prepared exchanged", "prepared", "ts--", "ok", false, []string{"phase", "entries", "matches:app:s", "matches:app:t", "matches:staged:s"}},
		{"rollback target", "rollback_started", "t-s-", "ok", false, []string{"phase", "entries", "matches:app:t", "matches:previous:s"}},
		{"rollback source", "rollback_started", "s-t-", "ok", false, []string{"phase", "entries", "matches:app:t", "matches:app:s", "matches:previous:t"}},
		{"rolled back other failed bytes", "rolled_back", "s--x", "ok", false, []string{"phase", "entries", "matches:app:s"}},
		{"forward", "rollback_started", "t-s-", "ok", true, []string{"phase", "entries", "matches:app:t", "matches:previous:s"}},
	}
	for _, c := range cases {
		s, f := fixtureCase(t, c)
		if err := s.Inspect(context.Background()); err != nil || !reflect.DeepEqual(f.trace, c.trace) {
			t.Fatal(c.name, err, f.trace)
		}
		for stop := range c.trace {
			for _, cancelOnly := range []bool{false, true} {
				s, f := fixtureCase(t, c)
				ctx, cancel := context.WithCancel(context.Background())
				cause := error(syscall.EIO)
				f.hook = func(string) error {
					if len(f.trace)-1 == stop {
						cancel()
						if !cancelOnly {
							return cause
						}
					}
					return nil
				}
				err := s.Inspect(ctx)
				code := "internal"
				if cancelOnly {
					code = "canceled"
				}
				requireFailure(t, err, code, "refused", !cancelOnly, false)
				if !reflect.DeepEqual(f.trace, c.trace[:stop+1]) || !errors.Is(err, context.Canceled) {
					t.Fatal("Inspect continued or lost cause", err, f.trace)
				}
				if !cancelOnly && !errors.Is(err, syscall.EIO) {
					t.Fatal("Inspect lost internal failure")
				}
				cancel()
			}
		}
	}
}

// Final success must still check context after a port's post-call check passed.
type finalBoundaryContext struct {
	context.Context
	remaining int
}

type dependencyContext struct {
	context.Context
	err error
}

func (c *dependencyContext) Err() error { return c.err }

func TestWrappedUnknownAndConcurrentDeadlineKeepBothCauses(t *testing.T) {
	s, f := fixtureCase(t, traceCases[0])
	ctx := &dependencyContext{Context: context.Background()}
	native := &port.HelperRecoveryFailure{Code: "move_uncertain", Phase: "refused", Uncertain: true, Cause: syscall.EIO}
	wrapped := fmt.Errorf("private dependency wrapper: %w", native)
	f.hook = func(string) error { ctx.err = context.DeadlineExceeded; return wrapped }
	_, err := s.Reconcile(ctx)
	requireFailure(t, err, "internal", "refused", true, true)
	for _, cause := range []error{wrapped, native, syscall.EIO, context.DeadlineExceeded} {
		if !errors.Is(err, cause) {
			t.Fatal("concurrent deadline/dependency cause lost", cause)
		}
	}
}

func TestBindingRetainsDependencyAndConcurrentCancellation(t *testing.T) {
	for _, code := range []string{"input", "acceptance", "opaque"} {
		ctx, cancel := context.WithCancel(context.Background())
		cause := errors.New(code)
		_, err := Bind(ctx, []byte("captured"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) {
			cancel()
			return port.HelperRequest{}, cause
		}), &runtimeFixture{})
		want := code
		if code == "opaque" {
			want = "internal"
		}
		requireFailure(t, err, want, "refused", code == "opaque", false)
		if !errors.Is(err, cause) || !errors.Is(err, context.Canceled) {
			t.Fatal("binding lost concurrent cause")
		}
		cancel()
	}
	ctx := &finalBoundaryContext{Context: context.Background()}
	s, err := Bind(ctx, []byte("captured"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) {
		ctx.remaining = 2
		return requestFixture(), nil
	}), &runtimeFixture{})
	if s != nil {
		t.Fatal("binding published after final cancellation")
	}
	requireFailure(t, err, "canceled", "refused", false, false)
}

func (c *finalBoundaryContext) Err() error {
	if c.remaining > 0 {
		c.remaining--
		if c.remaining == 0 {
			return context.Canceled
		}
	}
	return nil
}

func TestFinalSuccessGuardAndOpaqueClassifiedJoins(t *testing.T) {
	for _, method := range []string{"inspect", "reconcile"} {
		s, f := fixtureCase(t, traceCases[0])
		ctx := &finalBoundaryContext{Context: context.Background()}
		last := "write:cancelled"
		if method == "inspect" {
			last = "matches:staged:t"
		}
		f.hook = func(call string) error {
			if call == last {
				ctx.remaining = 2
			}
			return nil
		}
		var err error
		if method == "inspect" {
			err = s.Inspect(ctx)
		} else {
			var phase string
			phase, err = s.Reconcile(ctx)
			if phase != "" {
				t.Fatal("late success published")
			}
		}
		requireFailure(t, err, "canceled", "refused", false, method == "reconcile")
	}
	s, f := fixtureCase(t, traceCases[0])
	cause := errors.Join(nativeRefusal("path_type"), syscall.EIO, context.Canceled)
	f.hook = func(string) error { return cause }
	_, err := s.Reconcile(context.Background())
	requireFailure(t, err, "internal", "refused", true, false)
	if !errors.Is(err, syscall.EIO) || !errors.Is(err, cause) {
		t.Fatal("opaque joined internal error downgraded")
	}
	for _, cause := range []error{
		&port.HelperRecoveryFailure{Code: "private\ncode", Phase: "refused", Uncertain: true, Cause: syscall.EIO},
		errors.Join(&port.HelperRecoveryFailure{Code: "move_uncertain", Phase: "refused", Uncertain: true}, syscall.EIO, context.Canceled),
		errors.Join(nativeRefusal("path_type"), &port.HelperRecoveryFailure{Code: "move_uncertain", Phase: "refused", Uncertain: true}, syscall.EIO),
	} {
		s, f := fixtureCase(t, traceCases[0])
		f.hook = func(string) error { return cause }
		_, err := s.Reconcile(context.Background())
		requireFailure(t, err, "internal", "refused", true, true)
		if !errors.Is(err, cause) || !errors.Is(err, syscall.EIO) {
			t.Fatal("unknown provenance lost")
		}
	}
}

type cyclicDependency struct{ unwraps int }

func (*cyclicDependency) Error() string { return "private cyclic dependency" }
func (e *cyclicDependency) Unwrap() error {
	e.unwraps++
	if e.unwraps > 128 {
		panic("dependency unwrap exceeded conservative bound")
	}
	return e
}

// Inspect only direct children of bounded join nodes, never follow the cyclic
// dependency's Unwrap or call errors.Is through that dependency graph.
func hasDirectJoinedCause(err, want error) bool {
	pending := []error{err}
	for visited := 0; len(pending) > 0 && visited < 16; visited++ {
		current := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		if current == want {
			return true
		}
		if joined, ok := current.(interface{ Unwrap() []error }); ok {
			pending = append(pending, joined.Unwrap()...)
		}
	}
	return false
}

func TestCanceledCyclicAndHugeDependencyGraphsCompleteConservatively(t *testing.T) {
	cycle := &cyclicDependency{}
	large := make([]error, 1024)
	for i := range large {
		large[i] = syscall.EIO
	}
	for name, cause := range map[string]error{"cycle": cycle, "huge join": errors.Join(large...)} {
		t.Run(name, func(t *testing.T) {
			s, runtime := fixtureCase(t, traceCases[0])
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime.hook = func(string) error { cancel(); return cause }
			phase, err := s.Reconcile(ctx)
			failure := requireFailure(t, err, "internal", "refused", true, true)
			if phase != "" || !reflect.DeepEqual(runtime.trace, []string{"phase"}) {
				t.Fatal("failed dependency continued")
			}
			if !hasDirectJoinedCause(failure.Cause, cause) || !hasDirectJoinedCause(failure.Cause, context.Canceled) {
				t.Fatal("exact dependency or concurrent cancellation cause lost")
			}
		})
	}
	if cycle.unwraps != 128 {
		t.Fatal("unexpected cyclic traversal count", cycle.unwraps)
	}
}

func TestEveryHistoricalLaunchPhasePreservesPhaseWithoutReplay(t *testing.T) {
	for _, c := range []struct{ phase, pair string }{
		{"verified", "t-s-"}, {"launch_requested", "t-s-"}, {"completed", "t-s-"},
		{"cancelled", "st--"}, {"cancel_launch_requested", "st--"}, {"cancel_completed", "st--"},
		{"rolled_back", "s--x"}, {"rollback_launch_requested", "s--x"}, {"rollback_completed", "s--x"},
	} {
		r := requestFixture()
		f := newRuntime(t, r, c.phase, c.pair)
		s := bind(t, r, f)
		for range 2 {
			if err := s.Inspect(context.Background()); err != nil {
				t.Fatal(c.phase, err)
			}
		}
		f.trace = nil
		p, err := s.Reconcile(context.Background())
		if p != c.phase || err != nil {
			t.Fatal(c.phase, p, err)
		}
		for _, call := range f.trace {
			if isEffect(call) || call == "fence" {
				t.Fatal("historical phase replay", c.phase, call)
			}
		}
	}
}

func TestFailureAtEveryPortRetainsCauseAndStops(t *testing.T) {
	for _, c := range traceCases {
		for stop := range c.trace {
			t.Run(fmt.Sprintf("%s/%d", c.name, stop), func(t *testing.T) {
				s, f := fixtureCase(t, c)
				cause := errors.New("private runtime failure")
				f.hook = func(string) error {
					if len(f.trace)-1 == stop {
						return cause
					}
					return nil
				}
				p, err := s.Reconcile(context.Background())
				uncertain := false
				for _, call := range c.trace[:stop+1] {
					uncertain = uncertain || isEffect(call)
				}
				requireFailure(t, err, "internal", "refused", true, uncertain)
				if p != "" || !errors.Is(err, cause) || !reflect.DeepEqual(f.trace, c.trace[:stop+1]) {
					t.Fatal("failure lost or continued", p, err, f.trace)
				}
				_, err = s.Reconcile(context.Background())
				requireFailure(t, err, "recovery_attempt_unknown", "refused", false, true)
			})
		}
	}
}

func TestCancellationAtEveryPortAndFinalSuccess(t *testing.T) {
	for _, c := range traceCases {
		for stop := range c.trace {
			t.Run(fmt.Sprintf("%s/%d", c.name, stop), func(t *testing.T) {
				s, f := fixtureCase(t, c)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				f.ctx = ctx
				f.hook = func(string) error {
					if len(f.trace)-1 == stop {
						cancel()
					}
					return nil
				}
				p, err := s.Reconcile(ctx)
				uncertain := false
				for _, call := range c.trace[:stop+1] {
					uncertain = uncertain || isEffect(call)
				}
				requireFailure(t, err, "canceled", "refused", false, uncertain)
				if p != "" || !errors.Is(err, context.Canceled) || !reflect.DeepEqual(f.trace, c.trace[:stop+1]) {
					t.Fatal("canceled success or continuation", p, err, f.trace)
				}
			})
		}
	}
}

func TestDependencyErrorsWinConcurrentCancellation(t *testing.T) {
	for _, c := range traceCases {
		for stop := range c.trace {
			for _, kind := range []string{"opaque", "refusal", "unknown"} {
				t.Run(fmt.Sprintf("%s/%d/%s", c.name, stop, kind), func(t *testing.T) {
					s, f := fixtureCase(t, c)
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					joined := error(syscall.EIO)
					var cause error = joined
					if kind != "opaque" {
						cause = &port.HelperRecoveryFailure{Code: "source_replaced", Phase: "refused", Uncertain: kind == "unknown", Cause: joined}
					}
					f.hook = func(string) error {
						if len(f.trace)-1 == stop {
							cancel()
							return cause
						}
						return nil
					}
					_, err := s.Reconcile(ctx)
					uncertain := kind == "unknown"
					for _, call := range c.trace[:stop+1] {
						uncertain = uncertain || isEffect(call)
					}
					code := "source_replaced"
					if kind == "opaque" {
						code = "internal"
					}
					requireFailure(t, err, code, "refused", kind == "opaque", uncertain)
					if !errors.Is(err, cause) || !errors.Is(err, syscall.EIO) || !errors.Is(err, context.Canceled) {
						t.Fatal("dependency provenance lost", err)
					}
					if !reflect.DeepEqual(f.trace, c.trace[:stop+1]) {
						t.Fatal("continued after dependency error", f.trace)
					}
				})
			}
		}
	}
}

func TestFenceMutationsCannotUsePreflightAsAuthority(t *testing.T) {
	for _, mutate := range []string{"app", "previous", "staged", "failed", "rejected"} {
		t.Run("forward/"+mutate, func(t *testing.T) {
			s, f := fixtureCase(t, traceCases[8])
			if err := s.Inspect(context.Background()); err != nil {
				t.Fatal(err)
			}
			f.trace = nil
			f.hook = func(call string) error {
				if call == "fence" {
					switch mutate {
					case "app":
						f.entries[0].build = port.HelperBuild{}
					case "previous":
						f.entries[2].build = port.HelperBuild{}
					case "staged":
						f.entries[1].meta.Present = true
					case "failed":
						f.entries[3].meta.Present = true
					case "rejected":
						f.entries[4].meta.Present = true
					}
				}
				return nil
			}
			_, err := s.Reconcile(context.Background())
			requireFailure(t, err, "predecessor_state_unqualified", "refused", false, false)
			for _, call := range f.trace {
				if isEffect(call) {
					t.Fatal("mutated forward pair dispatched", f.trace)
				}
			}
		})
	}
	for _, c := range []traceCase{traceCases[1], traceCases[3], traceCases[5], traceCases[6]} {
		t.Run("identity/"+c.name, func(t *testing.T) {
			s, f := fixtureCase(t, c)
			f.hook = func(call string) error {
				if call == "fence" {
					for i := range f.entries {
						f.entries[i].meta.Identity.Inode += "9"
					}
				}
				return nil
			}
			_, err := s.Reconcile(context.Background())
			code := "source_replaced"
			if c.name == "finish preexchange rollback" {
				code = "exchange_precondition"
			}
			requireFailure(t, err, code, "refused", false, true)
			for _, call := range f.trace {
				if strings.HasPrefix(call, "write:") {
					t.Fatal("journal advanced after rejected identity")
				}
			}
		})
	}
}

func TestFailedBytesNeedOnlyOwnedDirectoryInSettledRollback(t *testing.T) {
	for _, phase := range []string{"rollback_started", "rolled_back", "rollback_launch_requested", "rollback_completed"} {
		for _, directory := range []bool{false, true} {
			for _, owned := range []bool{false, true} {
				r := requestFixture()
				f := newRuntime(t, r, phase, "s--x")
				f.entries[3].meta.Directory, f.entries[3].meta.OwnedByEffectiveUser = directory, owned
				s := bind(t, r, f)
				err := s.Inspect(context.Background())
				if directory && owned {
					if err != nil {
						t.Fatal(err)
					}
				} else {
					requireFailure(t, err, "recovery_pair", phase, false, false)
				}
				p, err := s.Reconcile(context.Background())
				if directory && owned {
					if err != nil || p == "" {
						t.Fatal(p, err)
					}
				} else {
					requireFailure(t, err, "failed_type", phase, false, false)
				}
				for _, call := range f.trace {
					if strings.Contains(call, "failed:") {
						t.Fatal("failed bytes incorrectly authenticated", call)
					}
				}
			}
		}
	}
}

func TestBindingCopiesInputAndEveryOptionalRequestValue(t *testing.T) {
	r := requestFixture()
	presentation := "sidecar-only"
	r.RelaunchPresentation = &presentation
	r.Action = "apply"
	r.Predecessor = &port.HelperPredecessor{Kind: "confirmed_closed", StartedAt: "2026-10-15T12:00:00Z", LastQuitSHA256: strings.Repeat("f", 64), StateIdentity: port.HelperIdentity{Device: "1", Inode: "2"}}
	r.LeaseIdentity = &port.HelperIdentity{Device: "1", Inode: "3"}
	input := []byte("captured")
	f := newRuntime(t, r, "prepared", "st--")
	parser := parserFunc(func(_ context.Context, b []byte) (port.HelperRequest, error) {
		if string(b) != "captured" {
			t.Fatal("wrong capture")
		}
		b[0] = 'X'
		return r, nil
	})
	s, err := Bind(context.Background(), input, parser, f)
	if err != nil || string(input) != "captured" || len(f.trace) != 0 {
		t.Fatal("bind effects/alias", err, f.trace)
	}
	original := copyRequest(r)
	*r.RelaunchPresentation = "changed"
	*r.InstallLocation = "legacy"
	r.Predecessor.Kind = "changed"
	r.LeaseIdentity.Inode = "999"
	r.Source.Version = "changed"
	for range 2 {
		got, err := s.Request(context.Background())
		if err != nil || !reflect.DeepEqual(got, original) {
			t.Fatal("bound values drifted", got, err)
		}
		*got.RelaunchPresentation = "returned changed"
		*got.InstallLocation = "changed"
		got.Predecessor.Kind = "changed"
		got.LeaseIdentity.Inode = "changed"
	}
	if _, err := s.Reconcile(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestOneAttemptSharedAcrossCopiesAndConcurrentCalls(t *testing.T) {
	s, f := fixtureCase(t, traceCases[0])
	copied := *s
	entered, release := make(chan struct{}), make(chan struct{})
	f.hook = func(call string) error {
		if call == "phase" {
			close(entered)
			<-release
		}
		return nil
	}
	var wg sync.WaitGroup
	wg.Add(1)
	var first error
	go func() { defer wg.Done(); _, first = s.Reconcile(context.Background()) }()
	<-entered
	for range 16 {
		_, err := copied.Reconcile(context.Background())
		requireFailure(t, err, "recovery_attempt_unknown", "refused", false, true)
	}
	close(release)
	wg.Wait()
	if first != nil || !reflect.DeepEqual(f.trace, traceCases[0].trace) {
		t.Fatal(first, f.trace)
	}
	_, err := s.Reconcile(context.Background())
	requireFailure(t, err, "recovery_attempt_unknown", "refused", false, true)
	// Even a pre-canceled call consumes the attempt before checking cancellation.
	s, f = fixtureCase(t, traceCases[0])
	copied = *s
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = s.Reconcile(ctx)
	requireFailure(t, err, "canceled", "refused", false, false)
	_, err = copied.Reconcile(context.Background())
	requireFailure(t, err, "recovery_attempt_unknown", "refused", false, true)
	if len(f.trace) != 0 {
		t.Fatal("canceled call reached port", f.trace)
	}
}

func TestInspectRefusalsDoNotConsumeAttemptOrDispatch(t *testing.T) {
	s, _ := fixtureCase(t, traceCases[6])
	for range 2 {
		requireFailure(t, s.Inspect(context.Background()), "recovery_pair", "predecessor_saved", false, false)
	}
	p, err := s.Reconcile(context.Background())
	if p != "rolled_back" || err != nil {
		t.Fatal(p, err)
	}
}

func TestMalformedDependenciesAndBoundaryErrorsStayClosed(t *testing.T) {
	for _, size := range []int{0, 8193} {
		_, err := Bind(context.Background(), make([]byte, size), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) {
			t.Fatal("out of bound parser")
			return port.HelperRequest{}, nil
		}), &runtimeFixture{})
		requireFailure(t, err, "input", "refused", false, false)
	}
	for _, code := range []string{"input", "acceptance", "canceled", "unavailable", "private detail"} {
		cause := errors.New(code)
		_, err := Bind(context.Background(), []byte("x"), parserFunc(func(context.Context, []byte) (port.HelperRequest, error) { return port.HelperRequest{}, cause }), &runtimeFixture{})
		want, internal := code, false
		if code == "unavailable" || code == "private detail" {
			want, internal = "internal", true
		}
		requireFailure(t, err, want, "refused", internal, false)
		if !errors.Is(err, cause) {
			t.Fatal("parser cause lost")
		}
	}
	for _, malformed := range []*port.HelperRecoveryFailure{
		{Code: "line\nprivate", Phase: "refused"}, {Code: strings.Repeat("a", 81), Phase: "refused"},
		{Code: "failure", Phase: "private detail"}, {Code: "", Phase: "refused"},
	} {
		s, f := fixtureCase(t, traceCases[0])
		f.hook = func(string) error { return malformed }
		_, err := s.Reconcile(context.Background())
		requireFailure(t, err, "internal", "refused", true, false)
		if !errors.Is(err, malformed) {
			t.Fatal("malformed dependency cause lost")
		}
		if malformed.Error() != "helper_recovery_failure" {
			t.Fatal("port Error leaked")
		}
	}
	for _, phase := range []string{"refused", "unknown", "private\nphase"} {
		r := requestFixture()
		f := newRuntime(t, r, phase, "st--")
		s := bind(t, r, f)
		_, err := s.Reconcile(context.Background())
		requireFailure(t, err, "internal", "refused", true, false)
		if !reflect.DeepEqual(f.trace, []string{"phase"}) {
			t.Fatal("invalid phase continued")
		}
	}
}

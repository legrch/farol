package boot

import (
	"bytes"
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/app/services/processwait"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
)

// These witnesses use private SYMBOLIC seams only. They never wrap descriptors 3
// or 4 of the test process and never reach a native owner; the Darwin lane
// exercises the real compiled entry against a real scratch predecessor.

// liveHelperRequestFixture is the closed fixture minus its closed-predecessor
// proof: a live predecessor request.
func liveHelperRequestFixture() map[string]any {
	r := closedHelperRequestFixture()
	delete(r, "predecessor")
	delete(r, "leaseIdentity")
	return r
}

type liveHelperFixture struct {
	events    []string
	input     []byte
	frames    [][]byte
	until     time.Time
	now       time.Time
	waitUntil time.Time
	captured  releaseport.HelperRequest

	captureErr, confirmErr, waitErr, quitErr, acquireErr, emitErr error
	waitPanic                                                     any
	failCheck, checks, acquired                                   int
	checkErr                                                      error
	readyErr                                                      error
	readyCalls, execCalls                                         int
	framesAtReady                                                 int
	execFn                                                        func(context.Context, closedHelperExecution) (*executionapp.Result, error)
}

func newLiveHelperFixture(t *testing.T, mutate ...func(map[string]any)) *liveHelperFixture {
	t.Helper()
	r := liveHelperRequestFixture()
	for _, m := range mutate {
		m(r)
	}
	return &liveHelperFixture{input: closedHelperJSON(t, r), until: time.Now().Add(10 * time.Second), now: time.Now()}
}
func (f *liveHelperFixture) event(s string) { f.events = append(f.events, s) }

type liveHelperFixtureChannels struct{ f *liveHelperFixture }

func (c liveHelperFixtureChannels) Emit(_ context.Context, _ time.Time, b []byte) error {
	c.f.event("emit")
	c.f.frames = append(c.f.frames, append([]byte(nil), b...))
	return c.f.emitErr
}
func (c liveHelperFixtureChannels) Close() error { c.f.event("channels-close"); return nil }

type liveHelperFixtureInput struct{ f *liveHelperFixture }

func (r liveHelperFixtureInput) Read(_ context.Context, u time.Time) ([]byte, error) {
	r.f.event("read")
	r.f.until = u
	return append([]byte(nil), r.f.input...), nil
}
func (r liveHelperFixtureInput) Close() error { r.f.event("input-close"); return nil }

type liveHelperFixtureRoutes struct{ f *liveHelperFixture }

func (r liveHelperFixtureRoutes) WithFiles(_ context.Context, fn func(helperroutes.Files) error) error {
	r.f.event("with-files")
	return fn(helperroutes.Files{})
}
func (r liveHelperFixtureRoutes) Close() error { r.f.event("routes-close"); return nil }

type liveHelperFixtureAdmission struct{ f *liveHelperFixture }

func (a liveHelperFixtureAdmission) Check(context.Context) error {
	a.f.event("check")
	a.f.checks++
	if a.f.failCheck == a.f.checks {
		return a.f.checkErr
	}
	return nil
}
func (a liveHelperFixtureAdmission) AcquireUpdate(context.Context) error {
	a.f.event("acquire")
	a.f.acquired++
	return a.f.acquireErr
}
func (a liveHelperFixtureAdmission) Capture(context.Context) error {
	a.f.event("capture")
	return a.f.captureErr
}
func (a liveHelperFixtureAdmission) Confirm(context.Context) error {
	a.f.event("confirm")
	return a.f.confirmErr
}
func (a liveHelperFixtureAdmission) Wait(_ context.Context, until time.Time) error {
	a.f.event("wait")
	a.f.waitUntil = until
	if a.f.waitPanic != nil {
		panic(a.f.waitPanic)
	}
	return a.f.waitErr
}
func (a liveHelperFixtureAdmission) Quit(context.Context) error {
	a.f.event("quit")
	return a.f.quitErr
}
func (a liveHelperFixtureAdmission) Close() error { a.f.event("admission-close"); return nil }

func (f *liveHelperFixture) deps() liveHelperDependencies {
	return liveHelperDependencies{
		now: func() time.Time { return f.now },
		ready: func(_ context.Context, _ *executionapp.Milestone, h closedReleaseHelper) (*executionapp.Readiness, error) {
			f.event("ready")
			f.readyCalls++
			f.framesAtReady = len(f.frames)
			if f.readyErr != nil {
				return nil, f.readyErr
			}
			return &executionapp.Readiness{}, nil
		},
		execute: func(ctx context.Context, in closedHelperExecution) (*executionapp.Result, error) {
			f.event("execute")
			f.execCalls++
			if f.execFn != nil {
				return f.execFn(ctx, in)
			}
			return &executionapp.Result{Phase: "verified"}, nil
		},
		take: func(liveHelperFiles) (closedHelperInput, liveHelperChannels, error) {
			f.event("take")
			return liveHelperFixtureInput{f}, liveHelperFixtureChannels{f}, nil
		},
		open: func(_ context.Context, r releaseport.HelperRequest, _ time.Time) (closedHelperRoutes, error) {
			f.event("open")
			f.captured = closedHelperRequestCopy(r)
			return liveHelperFixtureRoutes{f}, nil
		},
		admission: func(_ helperroutes.Files, r releaseport.HelperRequest, _ []byte, _ time.Time) (liveHelperAdmission, error) {
			f.event("admission")
			if !reflect.DeepEqual(r, f.captured) {
				panic("binding changed")
			}
			return liveHelperFixtureAdmission{f}, nil
		},
	}
}

func (f *liveHelperFixture) entry() ([]byte, int) {
	return liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), f.deps())
}

func (f *liveHelperFixture) count(s string) int {
	n := 0
	for _, e := range f.events {
		if e == s {
			n++
		}
	}
	return n
}

func (f *liveHelperFixture) closedOnce(t *testing.T) {
	t.Helper()
	for _, s := range []string{"input-close", "channels-close", "routes-close", "admission-close"} {
		if n := f.count(s); n != 1 {
			t.Fatalf("%s count %d: %v", s, n, f.events)
		}
	}
}

func liveHelperSequence(t *testing.T, got []string, want ...string) {
	t.Helper()
	next := 0
	for _, e := range got {
		if next < len(want) && e == want[next] {
			next++
		}
	}
	if next != len(want) {
		t.Fatalf("order %v does not contain subsequence %v", got, want)
	}
}

const liveHelperUnknownLine = `{"phase": "unknown", "error": "internal", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"

// The Python live order (update_helper.py run(): update_lock, initial_marker,
// readiness trees, process_start, waiting_for_exit, wait_exit, owner_lease +
// confirmed_quit) is the contract. No custody check may sit between the frame and
// the exit: the desktop quits on the frame and its marker is meant to vanish.
func TestLiveHelperDeterministicOrder(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			f := newLiveHelperFixture(t, func(r map[string]any) { r["action"] = action })
			phase := map[string]string{"apply": "verified", "rollback": "rolled_back"}[action]
			f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
				return &executionapp.Result{Phase: phase}, nil
			}
			line, exit := f.entry()
			if want := `{"phase": "` + phase + `", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"; exit != 0 || string(line) != want {
				t.Fatalf("exit %d line %q", exit, line)
			}
			liveHelperSequence(t, f.events,
				"take", "read", "open", "with-files", "admission", "check", "acquire", "check", "capture", "check",
				"ready", "confirm", "check", "emit", "wait", "quit", "check", "execute", "check")
			// emit -> wait -> quit: nothing observes custody in between.
			var between []string
			in := false
			for _, e := range f.events {
				if e == "emit" {
					in = true
					continue
				}
				if e == "quit" {
					in = false
				}
				if in {
					between = append(between, e)
				}
			}
			if !reflect.DeepEqual(between, []string{"wait"}) {
				t.Fatalf("events between the frame and Quit proof: %v", between)
			}
			if f.framesAtReady != 0 || f.readyCalls != 1 || f.execCalls != 1 || len(f.frames) != 1 || f.acquired != 1 {
				t.Fatalf("ready frames %d ready %d exec %d frames %d acquired %d", f.framesAtReady, f.readyCalls, f.execCalls, len(f.frames), f.acquired)
			}
			f.closedOnce(t)
		})
	}
}

func TestLiveHelperFrameIsWaitingForExitForThisRequest(t *testing.T) {
	f := newLiveHelperFixture(t)
	if _, exit := f.entry(); exit != 0 {
		t.Fatal("exit", exit)
	}
	protocol, err := protocolapp.Bind(context.Background(), f.input, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	want, err := protocol.BuildHandoff(context.Background(), protocolapp.WaitingForExit, nil)
	if err != nil || len(f.frames) != 1 || !bytes.Equal(f.frames[0], want) {
		t.Fatalf("frame %q want %q err %v", f.frames, want, err)
	}
	for _, field := range []string{`"predecessor":`, `"leaseIdentity":`, "closed_predecessor_ready"} {
		if bytes.Contains(f.frames[0], []byte(field)) {
			t.Fatalf("live frame carries %s: %s", field, f.frames[0])
		}
	}
}

// Relaunch true, recover, a closed predecessor and a legacy-optional location are
// all refused before ANY routes, lock, frame or effect.
func TestLiveHelperRefusalsBeforeAnyEffect(t *testing.T) {
	for name, m := range map[string]func(map[string]any){
		"relaunch": func(r map[string]any) { r["relaunch"] = true },
		"recover":  func(r map[string]any) { r["action"] = "recover" },
		"recover-relaunch": func(r map[string]any) {
			r["action"], r["relaunch"] = "recover", true
		},
		"closed-predecessor": func(r map[string]any) {
			c := closedHelperRequestFixture()
			r["predecessor"], r["leaseIdentity"] = c["predecessor"], c["leaseIdentity"]
		},
		"no-install-location": func(r map[string]any) { delete(r, "installLocation") },
	} {
		t.Run(name, func(t *testing.T) {
			f := newLiveHelperFixture(t, m)
			line, exit := f.entry()
			if exit != 79 || string(line) != `{"phase": "unknown", "error": "internal"}`+"\n" {
				t.Fatalf("exit %d line %q", exit, line)
			}
			for _, e := range []string{"open", "with-files", "admission", "acquire", "capture", "ready", "confirm", "emit", "wait", "quit", "execute"} {
				if f.count(e) != 0 {
					t.Fatalf("refusal reached %s: %v", e, f.events)
				}
			}
			if len(f.frames) != 0 {
				t.Fatal("refusal emitted a frame")
			}
		})
	}
}

// Every pre-frame failure exposes nothing: no ACK, no wait, no Execute.
func TestLiveHelperPreACKFailuresExposeNothing(t *testing.T) {
	boom := errors.New("boom")
	for name, set := range map[string]func(*liveHelperFixture){
		"first-check": func(f *liveHelperFixture) { f.failCheck, f.checkErr = 1, boom },
		"acquire":     func(f *liveHelperFixture) { f.acquireErr = boom },
		"marker":      func(f *liveHelperFixture) { f.captureErr = boom },
		"readiness": func(f *liveHelperFixture) {
			f.readyErr = &executionapp.Failure{Phase: "refused", Code: "operation_exists"}
		},
		"identity":        func(f *liveHelperFixture) { f.confirmErr = &processwait.Failure{Code: "process_identity"} },
		"check-pre-ack":   func(f *liveHelperFixture) { f.failCheck, f.checkErr = 4, boom },
		"check-post-lock": func(f *liveHelperFixture) { f.failCheck, f.checkErr = 2, boom },
	} {
		t.Run(name, func(t *testing.T) {
			f := newLiveHelperFixture(t)
			set(f)
			line, exit := f.entry()
			// The ID is learned when the readiness scope holds the parsed request;
			// an earlier failure names none, exactly like the closed entry.
			want := `{"phase": "unknown", "error": "internal"}` + "\n"
			if f.readyCalls > 0 {
				want = liveHelperUnknownLine
			}
			if exit != 79 || string(line) != want {
				t.Fatalf("exit %d line %q want %q", exit, line, want)
			}
			if len(f.frames) != 0 || f.count("emit") != 0 || f.count("wait") != 0 || f.count("quit") != 0 || f.execCalls != 0 {
				t.Fatalf("pre-ACK failure escaped: %v", f.events)
			}
			f.closedOnce(t)
		})
	}
}

// The process identity is positively confirmed BEFORE the desktop is told to
// exit: a start mismatch / pid reuse emits no frame and never waits.
func TestLiveHelperIdentityPrecedesTheFrame(t *testing.T) {
	f := newLiveHelperFixture(t)
	f.confirmErr = &processwait.Failure{Code: "process_reused"}
	if _, exit := f.entry(); exit != 79 {
		t.Fatal("exit", exit)
	}
	liveHelperSequence(t, f.events, "ready", "confirm", "admission-close")
	if f.count("emit") != 0 || f.count("wait") != 0 || f.execCalls != 0 {
		t.Fatal("identity failure reached the frame", f.events)
	}
}

// After the frame the outcome of the desktop is unknown: every failure is 79,
// no Quit proof is sought without an observed exit, and Execute is never reached.
func TestLiveHelperPostFrameFailuresAreUnknownAndNeverExecute(t *testing.T) {
	boom := errors.New("boom")
	for name, set := range map[string]func(*liveHelperFixture){
		"emit":         func(f *liveHelperFixture) { f.emitErr = boom },
		"exit-never":   func(f *liveHelperFixture) { f.waitErr = &processwait.Failure{Code: "process_running"} },
		"pid-reused":   func(f *liveHelperFixture) { f.waitErr = &processwait.Failure{Code: "process_reused"} },
		"wait-unknown": func(f *liveHelperFixture) { f.waitErr = &processwait.Failure{Code: "process_unknown", Uncertain: true} },
		"wait-panic":   func(f *liveHelperFixture) { f.waitPanic = "wait" },
		"quit":         func(f *liveHelperFixture) { f.quitErr = boom },
		"check-post-q": func(f *liveHelperFixture) { f.failCheck, f.checkErr = 5, boom },
	} {
		t.Run(name, func(t *testing.T) {
			f := newLiveHelperFixture(t)
			set(f)
			line, exit := f.entry()
			if exit != 79 || string(line) != liveHelperUnknownLine {
				t.Fatalf("exit %d line %q events %v", exit, line, f.events)
			}
			if f.execCalls != 0 {
				t.Fatalf("Execute reached: %v", f.events)
			}
			if name == "exit-never" || name == "pid-reused" || name == "wait-unknown" || name == "wait-panic" {
				if f.count("quit") != 0 {
					t.Fatal("Quit proof sought without an observed exit", f.events)
				}
			}
			f.closedOnce(t)
		})
	}
}

func TestLiveHelperExecuteFailureMapping(t *testing.T) {
	f := newLiveHelperFixture(t)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
		return nil, &executionapp.Failure{Phase: "prepared", Code: "staged_changed"}
	}
	line, exit := f.entry()
	if want := `{"phase": "prepared", "error": "staged_changed", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"; exit != 70 || string(line) != want {
		t.Fatalf("exit %d line %q", exit, line)
	}
	f = newLiveHelperFixture(t)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
		return nil, &executionapp.Failure{Phase: "new_installed", Code: "x", Uncertain: true}
	}
	if line, exit = f.entry(); exit != 79 || string(line) != liveHelperUnknownLine {
		t.Fatalf("exit %d line %q", exit, line)
	}
}

// The wait budget is the request's waitSeconds, counted from the wait, and can
// only tighten the original absolute bound, never extend it.
func TestLiveHelperWaitBudgetNeverExtendsTheOriginalBound(t *testing.T) {
	f := newLiveHelperFixture(t)
	if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, f.now.Add(time.Hour), f.deps()); exit != 0 {
		t.Fatal("exit", exit)
	}
	if want := f.now.Add(30 * time.Second); !f.waitUntil.Equal(want) {
		t.Fatalf("wait bound %v, want waitSeconds from now %v", f.waitUntil, want)
	}
	g := newLiveHelperFixture(t)
	until := g.now.Add(5 * time.Second)
	if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, until, g.deps()); exit != 0 {
		t.Fatal("exit", exit)
	}
	if !g.waitUntil.Equal(until) {
		t.Fatalf("wait bound %v extended past the original %v", g.waitUntil, until)
	}
}

func TestLiveHelperPanicsAreSeventyNine(t *testing.T) {
	deps := newLiveHelperFixture(t).deps()
	deps.take = func(liveHelperFiles) (closedHelperInput, liveHelperChannels, error) { panic("take") }
	line, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(time.Second), deps)
	if exit != 79 || string(line) != `{"phase": "unknown", "error": "internal"}`+"\n" {
		t.Fatalf("exit %d line %q", exit, line)
	}
	f := newLiveHelperFixture(t)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) { panic("execute") }
	if line, exit = f.entry(); exit != 79 || string(line) != liveHelperUnknownLine {
		t.Fatalf("exit %d line %q", exit, line)
	}
}

func TestLiveHelperMissingReadinessSeamIsUnknown(t *testing.T) {
	f := newLiveHelperFixture(t)
	deps := f.deps()
	deps.ready = nil
	if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(time.Second), deps); exit != 79 || len(f.frames) != 0 {
		t.Fatal("nil readiness seam reached the frame", exit)
	}
}

func TestLiveHelperEntryRefusesExtraArguments(t *testing.T) {
	for _, args := range [][]string{{"x"}, {""}, {"--pid", "1"}} {
		var out, diag bytes.Buffer
		if code := runLiveReleaseHelper(args, &out, &diag); code != 2 || out.Len() != 0 || !strings.Contains(diag.String(), liveReleaseHelperCommand) {
			t.Fatal("extra argv was not refused before any descriptor or stdout use", args, code, out.String(), diag.String())
		}
		out.Reset()
		diag.Reset()
		if code := Run(append([]string{liveReleaseHelperCommand}, args...), nil, nopWriteCloser{&out}, &diag); code != 2 || out.Len() != 0 {
			t.Fatal("dispatcher accepted extra argv", args, code)
		}
	}
}

// The scoped execute step sees updateHeld and the single Execute attempt, exactly
// like the closed scope: a second consumption refuses.
func TestLiveHelperScopeConsumesOneExecution(t *testing.T) {
	f := newLiveHelperFixture(t)
	var second error
	err := withLiveReleaseHelperDependencies(context.Background(), liveHelperFiles{}, f.until, func(s closedReleaseHelper) error {
		if _, e := s.execute(context.Background()); e != nil {
			return e
		}
		_, second = s.execute(context.Background())
		return nil
	}, f.deps())
	if err != nil || second == nil || f.execCalls != 1 {
		t.Fatalf("err %v second %v exec %d", err, second, f.execCalls)
	}
}

func TestLiveHelperTakeRefusesNilAndAliasedRoles(t *testing.T) {
	if _, _, err := takeLiveHelperFiles(liveHelperFiles{}); err == nil {
		t.Fatal("nil roles accepted")
	}
	file, err := os.CreateTemp(t.TempDir(), "role")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, _, err = takeLiveHelperFiles(liveHelperFiles{Request: file, ACK: file}); err == nil {
		t.Fatal("aliased roles accepted")
	}
}

func TestLiveHelperCloseOwnersJoinsBeforeReleasing(t *testing.T) {
	var order []string
	step := func(name string, e error) func() error {
		return func() error { order = append(order, name); return e }
	}
	boom := errors.New("join")
	err := closeLiveHelperOwners(step("join", boom), step("promotion", nil), step("update", nil))
	if !reflect.DeepEqual(order, []string{"join", "promotion", "update"}) {
		t.Fatalf("order %v", order)
	}
	closedHelperFailureCheck(t, err, boom)
	if closeLiveHelperOwners(nil, nil, nil) != nil {
		t.Fatal("absent owners failed")
	}
}

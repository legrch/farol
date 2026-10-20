package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	release "github.com/legrch/farol/modules/release/domain"
	"github.com/legrch/farol/modules/release/infra/native/handoff"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
)

// All native owners here are PRIVATE SYMBOLIC seams. The real parser and codecs
// exercise correlation; these tests prove neither descriptors nor Darwin custody.
type closedHelperFixture struct {
	events                                               []string
	input, continuation                                  []byte
	frames                                               [][]byte
	inputErr, emitErr, continueErr, acquireErr           error
	inputClose, channelClose, routeClose, admissionClose error
	checkErr                                             error
	failCheck, checks, callback, acquired                int
	beforeRead, afterEmit, beforeCheck                   func()
	beforeContinue                                       func()
	beforeClose                                          func()
	until                                                time.Time
	captured                                             releaseport.HelperRequest
	slot                                                 []byte
	routesFiles                                          helperroutes.Files
	// Readiness seam: configured outcome plus what the seam observed.
	readyErr, readyCause                   error
	readyPanic                             any
	readyResult                            *executionapp.Readiness
	beforeReady                            func(context.Context)
	readyCtx                               context.Context
	readyHelper                            closedReleaseHelper
	readyCalls, framesAtReady, readyChecks int
	readyMilestone                         *executionapp.Milestone
}

func closedHelperJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, e := json.Marshal(v)
	if e != nil {
		t.Fatal(e)
	}
	return b
}
func closedHelperRequestFixture() map[string]any {
	return map[string]any{
		"schema": "farol.installed-update/1", "action": "apply", "home": "/disposable-fixture-home", "operationId": strings.Repeat("1", 32),
		"source": map[string]any{"digest": strings.Repeat("2", 64), "version": "source-version", "buildId": strings.Repeat("3", 64)},
		"target": map[string]any{"digest": strings.Repeat("4", 64), "version": "target-version", "buildId": strings.Repeat("5", 64)},
		"drain":  map[string]any{"status": "reconciled", "acceptedSource": strings.Repeat("3", 64), "acceptedTarget": strings.Repeat("5", 64)},
		"pid":    1234, "processStart": "opaque predecessor birth", "waitSeconds": 30, "relaunch": false, "installLocation": "legacy",
		"predecessor":   map[string]any{"kind": "confirmed_closed", "startedAt": "2026-10-16T12:00:00Z", "lastQuitSha256": strings.Repeat("6", 64), "stateIdentity": map[string]any{"device": "11", "inode": "12"}},
		"leaseIdentity": map[string]any{"device": "11", "inode": "13"},
	}
}
func closedHelperContinuation(r map[string]any) map[string]any {
	m := map[string]any{"schema": "farol.installed-update-continue/1"}
	for _, k := range []string{"operationId", "action", "source", "target", "pid", "processStart", "predecessor", "leaseIdentity"} {
		m[k] = r[k]
	}
	return m
}
func newClosedHelperFixture(t *testing.T) *closedHelperFixture {
	t.Helper()
	r := closedHelperRequestFixture()
	return &closedHelperFixture{input: closedHelperJSON(t, r), continuation: closedHelperJSON(t, closedHelperContinuation(r)), until: time.Now().Add(10 * time.Second)}
}
func (f *closedHelperFixture) event(s string) { f.events = append(f.events, s) }

type closedHelperFixtureInput struct{ f *closedHelperFixture }

func (r closedHelperFixtureInput) Read(ctx context.Context, u time.Time) ([]byte, error) {
	r.f.event("read")
	r.f.until = u
	if r.f.beforeRead != nil {
		r.f.beforeRead()
	}
	return append([]byte(nil), r.f.input...), r.f.inputErr
}
func (r closedHelperFixtureInput) Close() error { r.f.event("input-close"); return r.f.inputClose }

type closedHelperFixtureChannels struct{ f *closedHelperFixture }

func (c closedHelperFixtureChannels) Emit(ctx context.Context, u time.Time, b []byte) error {
	c.f.event("emit")
	c.f.frames = append(c.f.frames, append([]byte(nil), b...))
	if c.f.afterEmit != nil {
		c.f.afterEmit()
	}
	return c.f.emitErr
}
func (c closedHelperFixtureChannels) AwaitContinue(ctx context.Context, u time.Time) ([]byte, error) {
	c.f.event("continue")
	if c.f.beforeContinue != nil {
		c.f.beforeContinue()
	}
	return append([]byte(nil), c.f.continuation...), c.f.continueErr
}
func (c closedHelperFixtureChannels) Close() error {
	c.f.event("channels-close")
	return c.f.channelClose
}

type closedHelperFixtureRoutes struct{ f *closedHelperFixture }

func (r closedHelperFixtureRoutes) WithFiles(ctx context.Context, fn func(helperroutes.Files) error) error {
	r.f.event("with-files")
	return fn(r.f.routesFiles)
}
func (r closedHelperFixtureRoutes) Close() error { r.f.event("routes-close"); return r.f.routeClose }

type closedHelperFixtureAdmission struct{ f *closedHelperFixture }

func (a closedHelperFixtureAdmission) Check(ctx context.Context) error {
	a.f.event("check")
	a.f.checks++
	if a.f.beforeCheck != nil {
		a.f.beforeCheck()
	}
	if a.f.failCheck == a.f.checks {
		return a.f.checkErr
	}
	return nil
}
func (a closedHelperFixtureAdmission) AcquireUpdate(context.Context) error {
	a.f.event("acquire")
	a.f.acquired++
	return a.f.acquireErr
}
func (a closedHelperFixtureAdmission) Close() error {
	a.f.event("admission-close")
	if a.f.beforeClose != nil {
		a.f.beforeClose()
	}
	return a.f.admissionClose
}
func (f *closedHelperFixture) ready(ctx context.Context, m *executionapp.Milestone, h closedReleaseHelper) (*executionapp.Readiness, error) {
	f.event("ready")
	f.readyCalls++
	f.readyCtx, f.readyHelper, f.readyMilestone = ctx, h, m
	f.framesAtReady, f.readyChecks = len(f.frames), f.checks
	if f.beforeReady != nil {
		f.beforeReady(ctx)
	}
	if f.readyPanic != nil {
		panic(f.readyPanic)
	}
	if f.readyErr != nil {
		return nil, f.readyErr
	}
	if f.readyResult != nil {
		return f.readyResult, nil
	}
	return &executionapp.Readiness{}, nil
}
func (f *closedHelperFixture) deps() closedHelperDependencies {
	return closedHelperDependencies{
		ready: f.ready,
		take: func(closedHelperFiles) (closedHelperInput, closedHelperChannels, error) {
			f.event("take")
			return closedHelperFixtureInput{f}, closedHelperFixtureChannels{f}, nil
		},
		borrow: func(_ *os.File, fn func() error) error {
			f.event("borrow")
			defer f.event("borrow-return")
			return fn()
		},
		open: func(_ context.Context, r releaseport.HelperRequest, u time.Time) (closedHelperRoutes, error) {
			f.event("open")
			f.captured = closedHelperRequestCopy(r)
			if !u.Equal(f.until) {
				panic("bound changed")
			}
			return closedHelperFixtureRoutes{f}, nil
		},
		admission: func(files helperroutes.Files, _ *os.File, r releaseport.HelperRequest, b []byte, u time.Time) (closedHelperAdmission, error) {
			f.event("admission")
			f.slot = append([]byte(nil), b...)
			if !reflect.DeepEqual(r, f.captured) || files != f.routesFiles || !u.Equal(f.until) {
				panic("binding changed")
			}
			return closedHelperFixtureAdmission{f}, nil
		},
	}
}
func (f *closedHelperFixture) run(ctx context.Context, fn func(closedReleaseHelper) error) error {
	return withClosedReleaseHelperDependencies(ctx, closedHelperFiles{}, f.until, func(s closedReleaseHelper) error {
		f.event("callback")
		f.callback++
		if fn != nil {
			return fn(s)
		}
		return nil
	}, f.deps())
}
func closedHelperHas(events []string, s string) bool {
	for _, v := range events {
		if v == s {
			return true
		}
	}
	return false
}
func closedHelperFailureCheck(t *testing.T, err error, causes ...error) {
	t.Helper()
	if err == nil {
		t.Fatal("accepted refused/unknown operation")
	}
	if err.Error() != "release_closed_helper_refused_or_unknown" {
		t.Fatalf("outer text escaped: %q", err)
	}
	for _, e := range causes {
		if !errors.Is(err, e) {
			t.Fatalf("lost cause %T", e)
		}
	}
}
func closedHelperClosedOnce(t *testing.T, f *closedHelperFixture) {
	t.Helper()
	for _, s := range []string{"input-close", "channels-close", "routes-close", "admission-close"} {
		n := 0
		for _, e := range f.events {
			if e == s {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("%s count %d: %v", s, n, f.events)
		}
	}
}

func TestClosedHelperDeterministicOrderAndCorrelation(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			r := closedHelperRequestFixture()
			r["action"] = action
			f.input = closedHelperJSON(t, r)
			f.continuation = closedHelperJSON(t, closedHelperContinuation(r))
			if e := f.run(context.Background(), nil); e != nil {
				t.Fatal(e)
			}
			want := []string{"take", "read", "borrow", "open", "with-files", "admission", "check", "ready", "check", "emit", "check", "continue", "check", "acquire", "check", "callback", "check", "admission-close", "routes-close", "borrow-return", "channels-close", "input-close"}
			if !reflect.DeepEqual(f.events, want) {
				t.Fatalf("order:\n%v\n%v", f.events, want)
			}
			if len(f.frames) != 1 {
				t.Fatal("ACK attempt count")
			}
			var got map[string]any
			if json.Unmarshal(f.frames[0], &got) != nil {
				t.Fatal("ACK JSON")
			}
			ready := closedHelperContinuation(r)
			ready["schema"] = "farol.installed-update-handoff/1"
			ready["phase"] = "closed_predecessor_ready"
			var expected map[string]any
			_ = json.Unmarshal(closedHelperJSON(t, ready), &expected)
			if !reflect.DeepEqual(got, expected) {
				t.Fatal("ACK did not preserve every correlated value")
			}
			for _, s := range []string{"legacy", r["operationId"].(string), "source-version", "target-version", strings.Repeat("2", 64), strings.Repeat("3", 64), strings.Repeat("4", 64), strings.Repeat("5", 64)} {
				if !bytes.Contains(f.slot, []byte(s)) {
					t.Fatal("slot binding omitted value")
				}
			}
			closedHelperClosedOnce(t, f)
		})
	}
}
func TestClosedHelperDeterministicUnsupportedBeforeNative(t *testing.T) {
	for _, mode := range []string{"no-predecessor", "no-location", "recover", "malformed", "overflow", "partial"} {
		t.Run(mode, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			r := closedHelperRequestFixture()
			switch mode {
			case "no-predecessor":
				delete(r, "predecessor")
				delete(r, "leaseIdentity")
			case "no-location":
				delete(r, "installLocation")
			case "recover":
				r["action"] = "recover"
			}
			f.input = closedHelperJSON(t, r)
			switch mode {
			case "malformed":
				f.input = []byte(`{"schema":null}`)
			case "overflow":
				f.input = bytes.Repeat([]byte("x"), 8193)
			case "partial":
				f.input = f.input[:len(f.input)-1]
			}
			closedHelperFailureCheck(t, f.run(context.Background(), nil))
			if closedHelperHas(f.events, "borrow") || f.callback != 0 || len(f.frames) != 0 {
				t.Fatal("unsupported request reached native custody")
			}
		})
	}
}
func TestClosedHelperDeterministicContinuationCorrelation(t *testing.T) {
	for _, path := range []string{"schema", "operationId", "action", "pid", "processStart", "source.digest", "source.version", "source.buildId", "target.digest", "target.version", "target.buildId", "predecessor.kind", "predecessor.startedAt", "predecessor.lastQuitSha256", "predecessor.stateIdentity.device", "predecessor.stateIdentity.inode", "leaseIdentity.device", "leaseIdentity.inode"} {
		t.Run(path, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			m := closedHelperContinuation(closedHelperRequestFixture())
			parts := strings.Split(path, ".")
			target := m
			for _, part := range parts[:len(parts)-1] {
				target = target[part].(map[string]any)
			}
			key := parts[len(parts)-1]
			if key == "pid" {
				target[key] = 1235
			} else {
				target[key] = "changed"
			}
			f.continuation = closedHelperJSON(t, m)
			closedHelperFailureCheck(t, f.run(context.Background(), nil))
			if f.callback != 0 || f.acquired != 0 || len(f.frames) != 1 {
				t.Fatal("mismatch reached post-continuation authority")
			}
			closedHelperClosedOnce(t, f)
		})
	}
}
func TestClosedHelperDeterministicContinuationRefusals(t *testing.T) {
	for _, mode := range []string{"empty", "partial", "overflow", "duplicate", "trailing", "withheld-eof", "transport-error", "ACK-error"} {
		t.Run(mode, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			cause := errors.New("private-native-cause")
			switch mode {
			case "empty":
				f.continuation = nil
			case "partial":
				f.continuation = f.continuation[:len(f.continuation)-1]
			case "overflow":
				f.continuation = bytes.Repeat([]byte("x"), 4097)
			case "duplicate":
				f.continuation = append([]byte(`{"schema":"duplicate",`), f.continuation[1:]...)
			case "trailing":
				f.continuation = append(f.continuation, []byte(`{}`)...)
			case "withheld-eof":
				f.continueErr = context.DeadlineExceeded // A seam, not physical EOF evidence.
			case "transport-error":
				f.continueErr = cause
			case "ACK-error":
				f.emitErr = cause
			}
			err := f.run(context.Background(), nil)
			closedHelperFailureCheck(t, err)
			if mode == "transport-error" || mode == "ACK-error" {
				closedHelperFailureCheck(t, err, cause)
			}
			if f.callback != 0 || f.acquired != 0 || len(f.frames) != 1 {
				t.Fatal("transport/invalid frame admitted callback or resent ACK")
			}
			closedHelperClosedOnce(t, f)
		})
	}
}
func TestClosedHelperDeterministicBoundaryRefusals(t *testing.T) {
	for _, cause := range []error{handoff.ErrPathReplaced, handoff.ErrStateChanged, handoff.ErrLeaseIdentity, handoff.ErrProcessRunning, handoff.ErrProcessUnknown, handoff.ErrQuitStale, handoff.ErrQuitNotConfirmed, errors.New("private-slot-replacement")} {
		for boundary := 1; boundary <= 6; boundary++ {
			f := newClosedHelperFixture(t)
			f.failCheck = boundary
			f.checkErr = cause
			closedHelperFailureCheck(t, f.run(context.Background(), nil), cause)
			if boundary <= 5 && f.callback != 0 {
				t.Fatal("refusal reached callback")
			}
			if boundary <= 2 && len(f.frames) != 0 {
				t.Fatal("pre-ACK refusal exposed frame")
			}
			if boundary <= 4 && f.acquired != 0 {
				t.Fatal("pre-continuation refusal acquired lock")
			}
			if boundary == 6 && f.callback != 1 {
				t.Fatal("post-callback boundary not exercised")
			}
			closedHelperClosedOnce(t, f)
		}
	}
}
func TestClosedHelperDeterministicCopiedRetainedScope(t *testing.T) {
	f := newClosedHelperFixture(t)
	var retained, copied closedReleaseHelper
	var r releaseport.HelperRequest
	if err := f.run(context.Background(), func(s closedReleaseHelper) error {
		retained = s
		copied = s
		return copied.withFiles(context.Background(), func(_ context.Context, files helperroutes.Files, request releaseport.HelperRequest, u time.Time) error {
			r = closedHelperRequestCopy(request)
			if files != f.routesFiles || !u.Equal(f.until) {
				t.Fatal("borrow/bound changed")
			}
			*request.LeaseIdentity = releaseport.HelperIdentity{Device: "changed", Inode: "changed"}
			if !reflect.DeepEqual(r, s.state.request) {
				t.Fatal("callback mutated captured request")
			}
			return s.reverify(context.Background(), r)
		})
	}); err != nil {
		t.Fatal(err)
	}
	before := f.checks
	closedHelperFailureCheck(t, retained.reverify(context.Background(), r))
	closedHelperFailureCheck(t, copied.withFiles(context.Background(), func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error {
		t.Fatal("retained borrow ran")
		return nil
	}))
	if before != f.checks {
		t.Fatal("closed wrapper performed native work")
	}
	closedHelperClosedOnce(t, f)
}
func TestClosedHelperDeterministicOneShotAndUnknown(t *testing.T) {
	for _, mode := range []string{"copy-used", "changed-request", "retained-unknown", "nil-callback"} {
		t.Run(mode, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			cause := errors.New("private-uncertainty")
			err := f.run(context.Background(), func(s closedReleaseHelper) error {
				copy := s
				r := closedHelperRequestCopy(s.state.request)
				if mode == "copy-used" {
					if e := s.withFiles(context.Background(), func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error { return nil }); e != nil {
						return e
					}
					before := f.checks
					e := copy.withFiles(context.Background(), func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error {
						t.Fatal("second borrow")
						return nil
					})
					if f.checks != before {
						t.Fatal("duplicate borrow did I/O")
					}
					return e
				}
				if mode == "nil-callback" {
					return s.withFiles(context.Background(), nil)
				}
				if mode == "changed-request" {
					*r.InstallLocation = "shared"
					closedHelperFailureCheck(t, s.reverify(context.Background(), r))
					r = closedHelperRequestCopy(s.state.request)
				} else {
					s.retainUnknown(cause)
				}
				before := f.checks
				closedHelperFailureCheck(t, copy.reverify(context.Background(), r))
				if f.checks != before {
					t.Fatal("unknown owner did I/O")
				}
				return nil
			})
			closedHelperFailureCheck(t, err)
			if mode == "retained-unknown" {
				closedHelperFailureCheck(t, err, cause)
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

type closedHelperLagContext struct {
	context.Context
	until time.Time
}

func (c closedHelperLagContext) Deadline() (time.Time, bool) { return c.until, true }
func TestClosedHelperDeterministicOriginalDeadlineAndCancellation(t *testing.T) {
	for _, mode := range []string{"elapsed-caller", "elapsed-original", "fresh-wrapper", "canceled-native"} {
		t.Run(mode, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			deadline := time.Now().Add(15 * time.Millisecond)
			ctx := context.Context(context.Background())
			native := errors.New("private-native-late-result")
			if mode == "elapsed-caller" {
				ctx = closedHelperLagContext{ctx, deadline}
				f.beforeRead = func() { time.Sleep(time.Until(deadline) + time.Millisecond) }
			}
			if mode == "elapsed-original" {
				f.until = deadline
				f.beforeRead = func() { time.Sleep(time.Until(deadline) + time.Millisecond) }
			}
			if mode == "fresh-wrapper" {
				deadline = time.Now().Add(100 * time.Millisecond)
				f.until = deadline
			}
			var cancel context.CancelCauseFunc
			if mode == "canceled-native" {
				ctx, cancel = context.WithCancelCause(ctx)
				f.beforeCheck = func() { cancel(native) }
				f.failCheck = 1
				f.checkErr = native
			}
			err := f.run(ctx, func(s closedReleaseHelper) error {
				if mode == "fresh-wrapper" {
					time.Sleep(time.Until(deadline) + time.Millisecond)
					return s.reverify(context.Background(), closedHelperRequestCopy(s.state.request))
				}
				t.Fatal("late request reached callback")
				return nil
			})
			closedHelperFailureCheck(t, err)
			if mode == "canceled-native" {
				closedHelperFailureCheck(t, err, native, context.Canceled)
			} else {
				closedHelperFailureCheck(t, err, context.DeadlineExceeded)
			}
			if mode == "fresh-wrapper" && f.callback != 1 {
				t.Fatal("fresh-context callback not exercised")
			}
			if mode != "fresh-wrapper" && len(f.frames) != 0 {
				t.Fatal("late request emitted ACK")
			}
		})
	}
}
func TestClosedHelperDeterministicCallbackJoinAndCleanupCauses(t *testing.T) {
	f := newClosedHelperFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	callback := errors.New("private-callback")
	cleanup := []error{errors.New("private-input-close"), errors.New("private-channel-close"), errors.New("private-route-close"), errors.New("private-admission-close")}
	f.inputClose, f.channelClose, f.routeClose, f.admissionClose = cleanup[0], cleanup[1], cleanup[2], cleanup[3]
	go func() {
		done <- f.run(ctx, func(closedReleaseHelper) error { close(entered); <-release; return callback })
	}()
	<-entered
	cancel()
	select {
	case <-done:
		t.Fatal("callback abandoned on cancellation")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	err := <-done
	closedHelperFailureCheck(t, err, callback, cleanup[0], cleanup[1], cleanup[2], cleanup[3], context.Canceled)
	closedHelperClosedOnce(t, f)
}
func TestClosedHelperDeterministicNativeJoin(t *testing.T) {
	f := newClosedHelperFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	native := errors.New("private-native")
	f.beforeCheck = func() {
		if f.checks == 1 {
			close(entered)
			<-release
		}
	}
	f.failCheck = 1
	f.checkErr = native
	go func() { done <- f.run(ctx, nil) }()
	<-entered
	cancel()
	select {
	case <-done:
		t.Fatal("native return abandoned")
	case <-time.After(10 * time.Millisecond):
	}
	close(release)
	closedHelperFailureCheck(t, <-done, native, context.Canceled)
	closedHelperClosedOnce(t, f)
}
func TestClosedHelperDeterministicPanicRetainsCause(t *testing.T) {
	for _, nested := range []bool{false, true} {
		f := newClosedHelperFixture(t)
		cause := errors.New("private-panic /never-in-public-text")
		err := f.run(context.Background(), func(s closedReleaseHelper) error {
			if nested {
				return s.withFiles(context.Background(), func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error { panic(cause) })
			}
			panic(cause)
		})
		closedHelperFailureCheck(t, err, cause)
		closedHelperClosedOnce(t, f)
	}
}
func TestClosedHelperDeterministicEnteredBorrowJoined(t *testing.T) {
	f := newClosedHelperFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	var scoped closedReleaseHelper
	closed := make(chan struct{})
	go func() {
		done <- f.run(context.Background(), func(s closedReleaseHelper) error {
			go func() {
				_ = s.withFiles(context.Background(), func(context.Context, helperroutes.Files, releaseport.HelperRequest, time.Time) error {
					scoped = s
					close(entered)
					<-release
					return nil
				})
			}()
			<-entered
			return nil
		})
	}()
	<-entered
	select {
	case <-done:
		t.Fatal("entered borrow abandoned")
	default:
	}
	go func() {
		for {
			scoped.state.mu.Lock()
			active := scoped.state.active
			scoped.state.mu.Unlock()
			if !active {
				close(closed)
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("scope did not end")
	}
	close(release)
	closedHelperFailureCheck(t, <-done)
	closedHelperClosedOnce(t, f)
}

func TestClosedHelperDeterministicProcessMapping(t *testing.T) {
	cause := errors.New("private-process-observation")
	for _, tc := range []struct {
		v      releaseport.ProcessObservation
		err    error
		want   handoff.ProcessState
		failed bool
	}{
		{releaseport.ProcessObservation{Presence: releaseport.ProcessAbsent}, nil, handoff.ProcessAbsent, false},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessAbsent, Start: "invalid"}, nil, handoff.ProcessUnknown, true},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessPresent, Start: "original birth"}, nil, handoff.ProcessPresent, false},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessPresent, Start: "reused birth"}, nil, handoff.ProcessPresent, false},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessPresent}, nil, handoff.ProcessUnknown, true},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessUnknown}, nil, handoff.ProcessUnknown, true},
		{releaseport.ProcessObservation{Presence: releaseport.ProcessAbsent}, cause, handoff.ProcessUnknown, true},
	} {
		got, err := closedHelperProcessResult(tc.v, tc.err)
		if got != tc.want || (err != nil) != tc.failed {
			t.Fatal("process classification changed")
		}
		if tc.err != nil && !errors.Is(err, tc.err) {
			t.Fatal("process cause lost")
		}
	}
}
func TestClosedHelperDeterministicAcquireAndTakeFailure(t *testing.T) {
	cause := errors.New("private-constructor-or-acquire")
	f := newClosedHelperFixture(t)
	f.acquireErr = cause
	closedHelperFailureCheck(t, f.run(context.Background(), nil), cause)
	if f.callback != 0 || f.acquired != 1 {
		t.Fatal("acquire failure admitted callback")
	}
	closedHelperClosedOnce(t, f)
	f = newClosedHelperFixture(t)
	deps := f.deps()
	take := deps.take
	deps.take = func(files closedHelperFiles) (closedHelperInput, closedHelperChannels, error) {
		i, c, _ := take(files)
		return i, c, cause
	}
	closedHelperFailureCheck(t, withClosedReleaseHelperDependencies(context.Background(), closedHelperFiles{}, f.until, func(closedReleaseHelper) error { t.Fatal("constructor failure callback"); return nil }, deps), cause)
	if !reflect.DeepEqual(f.events, []string{"take", "channels-close", "input-close"}) {
		t.Fatal("constructor transfer cleanup", f.events)
	}
}

func TestClosedHelperDeterministicCleanupRetainedByCopies(t *testing.T) {
	f := newClosedHelperFixture(t)
	cause := errors.New("private-final-cleanup")
	f.channelClose = cause
	var retained closedReleaseHelper
	closedHelperFailureCheck(t, f.run(context.Background(), func(s closedReleaseHelper) error { retained = s; return nil }), cause)
	closedHelperFailureCheck(t, retained.unknown(), cause)
	before := f.checks
	closedHelperFailureCheck(t, retained.reverify(context.Background(), retained.state.request), cause)
	if f.checks != before {
		t.Fatal("cleanup-unknown copy did I/O")
	}
}
func TestClosedHelperDeterministicFreshCallbackContext(t *testing.T) {
	f := newClosedHelperFixture(t)
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	cause := errors.New("private-original-cancellation")
	err := f.run(ctx, func(s closedReleaseHelper) error {
		return s.withFiles(context.Background(), func(effective context.Context, _ helperroutes.Files, _ releaseport.HelperRequest, _ time.Time) error {
			cancel(cause)
			if effective.Err() != context.Canceled {
				t.Fatal("fresh context lost original cancellation")
			}
			return effective.Err()
		})
	})
	closedHelperFailureCheck(t, err, cause, context.Canceled)
}
func TestClosedHelperDeterministicNoReadOnInvalidBounds(t *testing.T) {
	f := newClosedHelperFixture(t)
	closedHelperFailureCheck(t, f.run(nil, nil))
	if !reflect.DeepEqual(f.events, []string{"take", "channels-close", "input-close"}) {
		t.Fatal("invalid bounds reached work")
	}
}

func TestClosedHelperDeterministicTypedNilCause(t *testing.T) {
	f := newClosedHelperFixture(t)
	var cause *closedHelperFailure
	closedHelperFailureCheck(t, f.run(context.Background(), func(closedReleaseHelper) error { return cause }), cause)
	closedHelperClosedOnce(t, f)
}

// Private symbolic callbacks exercise cleanup order and error retention only.
// The original processprobe owns actual native Wait/stream qualification.
func TestClosedHelperCloseRetainsOriginalJoinBeforeUpdateRelease(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprintf("failed-%t", failed), func(t *testing.T) {
			entered, release, closed := make(chan struct{}), make(chan struct{}), make(chan struct{})
			joinedCause, closeCause := errors.New("private joined cause"), errors.New("private close cause")
			returned := make(chan error, 1)
			go func() {
				returned <- closeClosedHelperOwners(func() error {
					close(entered)
					<-release
					if failed {
						return joinedCause
					}
					return nil
				}, func() error {
					close(closed)
					if failed {
						return closeCause
					}
					return nil
				})
			}()
			select {
			case <-entered:
			case <-time.After(2 * time.Second):
				t.Fatal("original join not entered")
			}
			select {
			case <-closed:
				t.Fatal("update released before original join")
			default:
			}
			select {
			case <-returned:
				t.Fatal("scope returned before original join")
			default:
			}
			close(release)
			select {
			case err := <-returned:
				if failed {
					if !errors.Is(err, joinedCause) || !errors.Is(err, closeCause) {
						t.Fatal("cleanup lost original causes")
					}
					if strings.Contains(err.Error(), "private") {
						t.Fatal("private native cause exposed")
					}
				} else if err != nil {
					t.Fatal("clean cleanup refused", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("original join return not observed")
			}
			select {
			case <-closed:
			default:
				t.Fatal("remaining update owner not attempted")
			}
		})
	}
}

func TestClosedHelperCloseAbsentOwnersAndSingleFailures(t *testing.T) {
	if err := closeClosedHelperOwners(nil, nil); err != nil {
		t.Fatal(err)
	}
	cause := errors.New("private single cleanup cause")
	for _, join := range []bool{false, true} {
		calls := 0
		failure := func() error { calls++; return cause }
		var err error
		if join {
			err = closeClosedHelperOwners(failure, nil)
		} else {
			err = closeClosedHelperOwners(nil, failure)
		}
		if calls != 1 || !errors.Is(err, cause) {
			t.Fatal("single cleanup cause lost or repeated", calls, err)
		}
	}
}

// Readiness seam tests. The seam is symbolic: they prove ordering, refusal
// containment, bound reuse and uncertainty retention, not the native journal,
// app trees or Darwin custody (those belong to the production composition lane).
func closedHelperReadyFailure(t *testing.T, err error) *closedHelperFailure {
	t.Helper()
	var failure *closedHelperFailure
	if !errors.As(err, &failure) {
		t.Fatal("failure lost its closed classification", err)
	}
	return failure
}

func TestClosedHelperReadinessPrecedesFrameAndIsRetained(t *testing.T) {
	for _, action := range []string{"apply", "rollback"} {
		t.Run(action, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			r := closedHelperRequestFixture()
			r["action"] = action
			f.input = closedHelperJSON(t, r)
			f.continuation = closedHelperJSON(t, closedHelperContinuation(r))
			f.readyResult = &executionapp.Readiness{}
			if e := f.run(context.Background(), func(s closedReleaseHelper) error {
				if s.state.readiness != f.readyResult || s.state.milestone == nil || s.state.milestone != f.readyMilestone {
					t.Fatal("readiness or milestone not retained for a later execution step")
				}
				return nil
			}); e != nil {
				t.Fatal(e)
			}
			if f.readyCalls != 1 || f.framesAtReady != 0 {
				t.Fatal("readiness did not precede the only ACK attempt", f.readyCalls, f.framesAtReady)
			}
			// Exactly the first custody proof precedes readiness; a fresh proof follows it.
			if f.readyChecks != 1 || f.events[len(f.events)-1] == "ready" {
				t.Fatal("readiness did not follow the first custody proof", f.readyChecks, f.events)
			}
			first, ready, emit := -1, -1, -1
			for i, e := range f.events {
				switch {
				case e == "check" && first < 0:
					first = i
				case e == "ready":
					ready = i
				case e == "emit":
					emit = i
				}
			}
			if !(first < ready && ready < emit) {
				t.Fatal("order", f.events)
			}
			if f.checks < 2 || f.events[emit-1] != "check" {
				t.Fatal("no custody fence between readiness and ACK", f.events)
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

func TestClosedHelperReadinessRefusalExposesNothing(t *testing.T) {
	for _, tc := range []struct{ action, code string }{{"apply", "operation_exists"}, {"apply", "staged_missing"}, {"rollback", "closed_rollback_pair"}, {"rollback", "closed_rollback_journal_changed"}} {
		t.Run(tc.action+"-"+tc.code, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			r := closedHelperRequestFixture()
			r["action"] = tc.action
			f.input = closedHelperJSON(t, r)
			f.continuation = closedHelperJSON(t, closedHelperContinuation(r))
			refusal := &executionapp.Failure{Code: tc.code, Phase: "refused"}
			f.readyErr = refusal
			err := f.run(context.Background(), nil)
			closedHelperFailureCheck(t, err, refusal)
			// Nested closed wrappers are conservatively uncertain; exposure is the
			// property under test, and Emit never happened.
			closedHelperReadyFailure(t, err)
			if len(f.frames) != 0 || closedHelperHas(f.events, "emit") || closedHelperHas(f.events, "continue") || f.acquired != 0 || f.callback != 0 {
				t.Fatal("refusal exposed a frame or reached continuation authority", f.events)
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

func TestClosedHelperReadinessErrorsAndNilResultAreContained(t *testing.T) {
	cause := errors.New("private-readiness-native-cause")
	for _, mode := range []string{"opaque", "internal", "uncertain", "nil-result", "missing-seam"} {
		t.Run(mode, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			deps := f.deps()
			switch mode {
			case "opaque":
				f.readyErr = cause
			case "internal":
				f.readyErr = &executionapp.Failure{Code: "internal", Phase: "refused", Internal: true}
			case "uncertain":
				f.readyErr = &executionapp.Failure{Code: "canceled", Phase: "refused", Uncertain: true, Cause: cause}
			case "nil-result":
				deps.ready = func(context.Context, *executionapp.Milestone, closedReleaseHelper) (*executionapp.Readiness, error) {
					return nil, nil
				}
			case "missing-seam":
				deps.ready = nil
			}
			err := withClosedReleaseHelperDependencies(context.Background(), closedHelperFiles{}, f.until, func(closedReleaseHelper) error { t.Fatal("callback"); return nil }, deps)
			closedHelperFailureCheck(t, err)
			if mode == "opaque" || mode == "uncertain" {
				closedHelperFailureCheck(t, err, cause)
			}
			if mode != "nil-result" && mode != "missing-seam" && !closedHelperReadyFailure(t, err).uncertain {
				t.Fatal("unproven readiness failure was classified as a clean refusal")
			}
			if len(f.frames) != 0 || f.acquired != 0 {
				t.Fatal("failure exposed a frame or acquired the update lock")
			}
			closedHelperClosedOnce(t, f)
		})
	}
}

func TestClosedHelperReadinessUsesOriginalBound(t *testing.T) {
	t.Run("elapses-inside-readiness", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		f.until = time.Now().Add(40 * time.Millisecond)
		// A caller deadline far beyond the original bound must not extend it.
		parent, cancel := context.WithTimeout(context.Background(), time.Hour)
		defer cancel()
		f.beforeReady = func(ctx context.Context) {
			if d, ok := ctx.Deadline(); !ok || d.After(f.until) {
				t.Error("readiness context deadline extends the original bound", d, f.until)
			}
			time.Sleep(time.Until(f.until) + 2*time.Millisecond)
		}
		err := f.run(parent, nil)
		closedHelperFailureCheck(t, err, context.DeadlineExceeded)
		if len(f.frames) != 0 || f.callback != 0 {
			t.Fatal("late readiness reached the frame")
		}
		closedHelperClosedOnce(t, f)
	})
	t.Run("cancelled-inside-readiness", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		ctx, cancel := context.WithCancelCause(context.Background())
		defer cancel(nil)
		native := errors.New("private-readiness-cancellation")
		f.beforeReady = func(context.Context) { cancel(native) }
		f.readyErr = context.Canceled
		err := f.run(ctx, nil)
		closedHelperFailureCheck(t, err, context.Canceled, native)
		if len(f.frames) != 0 || f.callback != 0 {
			t.Fatal("cancelled readiness reached the frame")
		}
		closedHelperClosedOnce(t, f)
	})
}

func TestClosedHelperReadinessPanicIsJoinedAndRetained(t *testing.T) {
	f := newClosedHelperFixture(t)
	cause := errors.New("private-readiness-panic /never-in-public-text")
	f.readyPanic = cause
	err := f.run(context.Background(), nil)
	closedHelperFailureCheck(t, err, cause)
	if !closedHelperReadyFailure(t, err).uncertain {
		t.Fatal("readiness panic was not unknown")
	}
	if strings.Contains(err.Error(), "private") {
		t.Fatal("panic text exposed")
	}
	if len(f.frames) != 0 || f.acquired != 0 || f.callback != 0 {
		t.Fatal("panic exposed a frame or reached continuation authority")
	}
	// The preflight scope retains the uncertainty and is permanently closed.
	closedHelperFailureCheck(t, f.readyHelper.unknown(), cause)
	before := f.checks
	closedHelperFailureCheck(t, f.readyHelper.reverify(context.Background(), f.readyHelper.state.request))
	if f.checks != before {
		t.Fatal("ended preflight scope performed native work")
	}
	closedHelperClosedOnce(t, f)
}

func TestClosedHelperReadinessScopeEndsBeforeFrame(t *testing.T) {
	f := newClosedHelperFixture(t)
	if err := f.run(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	before := f.checks
	closedHelperFailureCheck(t, f.readyHelper.reverify(context.Background(), f.readyHelper.state.request))
	if f.checks != before {
		t.Fatal("retained preflight scope renewed native authority")
	}
	// Preflight and callback scopes are distinct owners.
	if f.readyHelper.state.milestone != nil || f.readyHelper.state.readiness != nil {
		t.Fatal("preflight scope retained execution inputs")
	}
}

func TestClosedHelperJournalObservationAdmissionRefusals(t *testing.T) {
	op := release.Operation{ID: strings.Repeat("1", 32)}
	binding := releaseport.JournalDirectory{Device: "1", Inode: "2", ParentDevice: "3", ParentInode: "4"}
	if _, writer := any(&closedHelperJournalObservation{}).(releaseport.JournalAdmission); writer {
		t.Fatal("observation admission impersonates the writer admission")
	}
	ctx := context.Background()
	t.Run("nil", func(t *testing.T) {
		for _, a := range []*closedHelperJournalObservation{nil, {}, {operation: op, binding: binding}} {
			if a.JournalGate() != nil || !a.JournalUnknown(op) || a.ReverifyHelperJournalObservation(ctx, op, binding) == nil {
				t.Fatal("unbound observation admission accepted")
			}
			a.RetainJournalUnknown(op) // Must not panic.
		}
	})
	t.Run("active-ended-and-mismatch", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		state := &closedReleaseHelperState{active: true, request: closedHelperRequestCopy(f.captured), original: ctx, until: f.until, admission: closedHelperFixtureAdmission{f}}
		state.request = closedHelperRequestFixtureParsed(t)
		a := &closedHelperJournalObservation{helper: closedReleaseHelper{state}, gate: &fakeGate{}, operation: op, binding: binding}
		if a.JournalGate() == nil || a.JournalUnknown(op) {
			t.Fatal("active scope refused")
		}
		if err := a.ReverifyHelperJournalObservation(ctx, op, binding); err != nil || f.checks != 1 {
			t.Fatal("active scope did not run its custody check", err, f.checks)
		}
		other := op
		other.ID = strings.Repeat("9", 32)
		moved := binding
		moved.Inode = "5"
		if a.ReverifyHelperJournalObservation(ctx, other, binding) == nil || a.ReverifyHelperJournalObservation(ctx, op, moved) == nil || !a.JournalUnknown(other) || f.checks != 1 {
			t.Fatal("mismatched operation or directory binding accepted")
		}
		state.end()
		if a.ReverifyHelperJournalObservation(ctx, op, binding) == nil || f.checks != 1 {
			t.Fatal("ended scope renewed custody authority")
		}
	})
	t.Run("retains-unknown", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		state := &closedReleaseHelperState{active: true, request: closedHelperRequestFixtureParsed(t), original: ctx, until: f.until, admission: closedHelperFixtureAdmission{f}}
		a := &closedHelperJournalObservation{helper: closedReleaseHelper{state}, gate: &fakeGate{}, operation: op, binding: binding}
		a.RetainJournalUnknown(op)
		if !a.JournalUnknown(op) || state.unknown() == nil {
			t.Fatal("journal uncertainty not retained")
		}
		if a.ReverifyHelperJournalObservation(ctx, op, binding) == nil || f.checks != 0 {
			t.Fatal("unknown scope performed native work")
		}
	})
}

type fakeGate struct{}

func (*fakeGate) Lock()   {}
func (*fakeGate) Unlock() {}

func closedHelperRequestFixtureParsed(t *testing.T) releaseport.HelperRequest {
	t.Helper()
	f := newClosedHelperFixture(t)
	if err := f.run(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	return closedHelperRequestCopy(f.captured)
}

func TestClosedHelperReadyRefusesUnboundInputs(t *testing.T) {
	m, err := executionapp.NewMilestone(context.Background(), closedHelperRequestFixtureParsed(t))
	if err != nil {
		t.Fatal(err)
	}
	for name, call := range map[string]func() (*executionapp.Readiness, error){
		"nil-context": func() (*executionapp.Readiness, error) { return closedHelperReady(nil, m, closedReleaseHelper{}) },
		"nil-milestone": func() (*executionapp.Readiness, error) {
			return closedHelperReady(context.Background(), nil, closedReleaseHelper{})
		},
		"nil-state": func() (*executionapp.Readiness, error) {
			return closedHelperReady(context.Background(), m, closedReleaseHelper{})
		},
		"no-route": func() (*executionapp.Readiness, error) {
			return closedHelperReady(context.Background(), m, closedReleaseHelper{&closedReleaseHelperState{}})
		},
	} {
		if ready, err := call(); ready != nil || err == nil {
			t.Fatal(name, "accepted unbound readiness inputs")
		}
	}
}

package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	release "github.com/legrch/farol/modules/release/domain"
)

// Deterministic witnesses for the execution composition. Every owner is a
// private symbolic seam: they prove ordering, single consumption, admission
// refusals and terminal mapping, not custody, installation or relaunch.

const closedHelperExecID = "11111111111111111111111111111111"

func TestClosedHelperRelaunchRefusedBeforeAnyIO(t *testing.T) {
	f := newClosedHelperFixture(t)
	r := closedHelperRequestFixture()
	r["relaunch"] = true
	f.input = closedHelperJSON(t, r)
	f.continuation = closedHelperJSON(t, closedHelperContinuation(r))
	closedHelperFailureCheck(t, f.run(context.Background(), nil))
	for _, e := range []string{"borrow", "open", "admission", "ready", "emit", "acquire", "callback", "execute"} {
		if closedHelperHas(f.events, e) {
			t.Fatalf("relaunch request reached %s: %v", e, f.events)
		}
	}
	if len(f.frames) != 0 || f.callback != 0 || f.execCalls != 0 {
		t.Fatal("relaunch request produced a frame or ran")
	}
	closedHelperClosedInputs(t, f)
}

// closedHelperClosedInputs: a request refused before routes still closes the
// two transport owners exactly once.
func closedHelperClosedInputs(t *testing.T, f *closedHelperFixture) {
	t.Helper()
	for _, s := range []string{"input-close", "channels-close"} {
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

func TestClosedHelperProductionDependenciesSelectExecution(t *testing.T) {
	d := closedHelperProductionDependencies()
	if d.execute == nil || d.ready == nil {
		t.Fatal("production composition lost its execution or readiness seam")
	}
}

func TestClosedHelperJournalAdmissionRefusals(t *testing.T) {
	ctx := context.Background()
	op := release.Operation{ID: closedHelperExecID}
	binding := releaseport.JournalDirectory{Device: "1", Inode: "2", ParentDevice: "3", ParentInode: "4"}
	build := func(f *closedHelperFixture, held bool) (*closedHelperJournalAdmission, *closedReleaseHelperState) {
		state := &closedReleaseHelperState{active: true, request: closedHelperRequestFixtureParsed(t), original: ctx, until: f.until, admission: closedHelperFixtureAdmission{f}, updateHeld: held}
		return &closedHelperJournalAdmission{helper: closedReleaseHelper{state}, gate: &fakeGate{}, operation: op, binding: binding}, state
	}
	t.Run("nil-and-zero", func(t *testing.T) {
		for _, a := range []*closedHelperJournalAdmission{nil, {}, {operation: op, binding: binding}} {
			if a.JournalGate() != nil || !a.JournalUnknown(op) || !errors.Is(a.ReverifyJournal(ctx, op, binding), releaseport.JournalUnproven) {
				t.Fatal("unbound writer admission accepted")
			}
			a.RetainJournalUnknown(op) // Must not panic.
		}
	})
	t.Run("before-acquire-update", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		a, state := build(f, false)
		if a.JournalGate() != nil || !a.JournalUnknown(op) || !errors.Is(a.ReverifyJournal(ctx, op, binding), releaseport.JournalUnproven) {
			t.Fatal("a scope without the acquired update lock was admitted")
		}
		if f.checks != 0 || state.unknown() != nil {
			t.Fatal("refusal performed custody work or retained uncertainty")
		}
	})
	t.Run("held-then-ended", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		a, state := build(f, true)
		if a.JournalGate() == nil || a.JournalUnknown(op) {
			t.Fatal("held scope refused")
		}
		if err := a.ReverifyJournal(ctx, op, binding); err != nil || f.checks != 1 {
			t.Fatal("held scope did not run its custody check", err, f.checks)
		}
		state.end()
		if a.ReverifyJournal(ctx, op, binding) == nil || f.checks != 1 {
			t.Fatal("ended scope renewed custody authority")
		}
	})
	t.Run("mismatch", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		a, _ := build(f, true)
		other := op
		other.ID = strings.Repeat("9", 32)
		moved := binding
		moved.Inode = "5"
		if !errors.Is(a.ReverifyJournal(ctx, other, binding), releaseport.JournalUnproven) || !errors.Is(a.ReverifyJournal(ctx, op, moved), releaseport.JournalUnproven) || !errors.Is(a.ReverifyJournal(nil, op, binding), releaseport.JournalUnproven) || !a.JournalUnknown(other) || f.checks != 0 {
			t.Fatal("mismatched operation, binding or context accepted")
		}
	})
	t.Run("retained-unknown", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		a, state := build(f, true)
		a.RetainJournalUnknown(op)
		if !a.JournalUnknown(op) || state.unknown() == nil {
			t.Fatal("journal uncertainty not retained")
		}
		if a.ReverifyJournal(ctx, op, binding) == nil || f.checks != 0 {
			t.Fatal("unknown scope performed native work")
		}
	})
}

// The callback scope alone carries the update-held fact; the preflight scope
// never does, even though it shares the same native admission.
func TestClosedHelperUpdateHeldOnlyInCallbackScope(t *testing.T) {
	f := newClosedHelperFixture(t)
	var held bool
	var callbackState *closedReleaseHelperState
	if err := f.run(context.Background(), func(h closedReleaseHelper) error {
		held, callbackState = h.state.updateHeld, h.state
		if !closedHelperHas(f.events, "acquire") {
			t.Fatal("callback began before AcquireUpdate")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !held || callbackState == f.readyHelper.state {
		t.Fatal("callback scope did not carry the acquired update lock")
	}
	if f.readyHelper.state.updateHeld {
		t.Fatal("preflight scope claimed an update lock")
	}
	// A preflight helper cannot execute even if it somehow had inputs.
	f2 := newClosedHelperFixture(t)
	f2.readyResult = &executionapp.Readiness{}
	if err := f2.run(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := f2.readyHelper.execute(context.Background()); err == nil || f2.execCalls != 0 {
		t.Fatal("preflight helper executed")
	}
}

func TestClosedHelperExecuteIsSingleConsume(t *testing.T) {
	f := newClosedHelperFixture(t)
	var first, second *executionapp.Result
	var firstErr, secondErr, withFilesErr error
	err := f.run(context.Background(), func(h closedReleaseHelper) error {
		first, firstErr = h.execute(context.Background())
		second, secondErr = h.execute(context.Background())
		withFilesErr = h.withFiles(context.Background(), nil)
		return nil
	})
	if firstErr != nil || first == nil || *first != (executionapp.Result{Phase: "verified"}) {
		t.Fatal("first execute did not return the result", first, firstErr)
	}
	if second != nil || secondErr == nil || withFilesErr == nil {
		t.Fatal("a consumed scope accepted another borrow", second, secondErr, withFilesErr)
	}
	if f.execCalls != 1 {
		t.Fatalf("Execute ran %d times", f.execCalls)
	}
	// The second refusal was not an effect: the scope is still clean.
	if err != nil {
		t.Fatal(err)
	}
}

func TestClosedHelperExecuteFencesAroundExecuteAndPassesCopy(t *testing.T) {
	f := newClosedHelperFixture(t)
	var seen closedHelperExecution
	checksDuring := 0
	f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
		seen, checksDuring = in, f.checks
		in.request.PID = 9 // A mutation of the copy must not reach the scope.
		return &executionapp.Result{Phase: "rolled_back", Code: "target_verification"}, nil
	}
	var result *executionapp.Result
	var before int
	if err := f.run(context.Background(), func(h closedReleaseHelper) error {
		before = f.checks
		var e error
		result, e = h.execute(context.Background())
		if e != nil {
			t.Fatal(e)
		}
		if h.state.request.PID == 9 {
			t.Fatal("executor mutated the scope's request")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if result == nil || *result != (executionapp.Result{Phase: "rolled_back", Code: "target_verification"}) {
		t.Fatal("result changed", result)
	}
	if checksDuring != before+1 || f.checks < before+2 {
		t.Fatalf("custody not rechecked before and after Execute: before=%d during=%d after=%d", before, checksDuring, f.checks)
	}
	if seen.milestone == nil || seen.readiness == nil || seen.files != f.routesFiles || !seen.until.Equal(f.until) {
		t.Fatal("executor did not receive the scope's retained inputs")
	}
}

func TestClosedHelperExecuteFailureClassification(t *testing.T) {
	clean := &executionapp.Failure{Code: "readiness_required", Phase: "refused"}
	cases := []struct {
		name      string
		fn        func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error)
		wantErr   error // returned unchanged when non-nil
		retained  bool
		wantNilOK bool
	}{
		{name: "clean-refusal-is-direct-and-retains-nothing", fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, clean
		}, wantErr: clean},
		{name: "uncertain-failure", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, &executionapp.Failure{Code: "x", Phase: "refused", Uncertain: true}
		}},
		{name: "internal-failure", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, &executionapp.Failure{Code: "x", Phase: "refused", Internal: true}
		}},
		{name: "uncertain-cause-behind-clean-failure", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, &executionapp.Failure{Code: "x", Phase: "refused", Cause: errors.New("opaque native")}
		}},
		{name: "opaque-error", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, errors.New("opaque")
		}},
		{name: "wrapped-clean-failure", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, fmt.Errorf("wrapped: %w", clean)
		}},
		{name: "nil-nil", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return nil, nil
		}},
		{name: "panic", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			panic("boom")
		}},
		{name: "error-beside-result", retained: true, fn: func(*closedHelperFixture, context.Context, closedHelperExecution) (*executionapp.Result, error) {
			return &executionapp.Result{Phase: "verified"}, errors.New("late")
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newClosedHelperFixture(t)
			f.execFn = func(ctx context.Context, in closedHelperExecution) (*executionapp.Result, error) {
				return c.fn(f, ctx, in)
			}
			var result *executionapp.Result
			var execErr error
			var state *closedReleaseHelperState
			outer := f.run(context.Background(), func(h closedReleaseHelper) error {
				state = h.state
				result, execErr = h.execute(context.Background())
				return nil
			})
			if result != nil || execErr == nil {
				t.Fatal("failed execution reported a result", result, execErr)
			}
			if c.wantErr != nil {
				if execErr != c.wantErr || state.unknown() != nil || outer != nil {
					t.Fatal("clean refusal was wrapped or retained", execErr, outer)
				}
			} else {
				if execErr.Error() != "release_closed_helper_refused_or_unknown" || state.unknown() == nil || outer == nil {
					t.Fatal("unclean failure was not retained as unknown", execErr, outer)
				}
			}
			if f.execCalls != 1 {
				t.Fatal("Execute count", f.execCalls)
			}
			// The terminal line never reads a failed execution as success.
			line, exit := closedHelperTerminal(closedHelperExecID, result, execErr)
			if exit == 0 || bytes.Contains(line, []byte(`"verified"`)) {
				t.Fatal("failure mapped to success", string(line))
			}
			if c.wantErr == nil && exit != 79 {
				t.Fatalf("unclean failure exited %d", exit)
			}
		})
	}
}

// A custody failure after Execute committed an effect is never success: the
// post-Execute fence inside execute, and the scope's final check after the
// callback returned, both end as unknown (79).
func TestClosedHelperFinalCheckFailureAfterExecuteIsUnknown(t *testing.T) {
	cause := errors.New("custody lost after effect")
	t.Run("post-execute-fence", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		f.checkErr = cause
		f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
			f.failCheck = f.checks + 1 // The fence that follows Execute.
			return &executionapp.Result{Phase: "verified"}, nil
		}
		var result *executionapp.Result
		var execErr error
		outer := f.run(context.Background(), func(h closedReleaseHelper) error {
			result, execErr = h.execute(context.Background())
			return nil
		})
		if result != nil || execErr == nil || outer == nil {
			t.Fatal("custody loss after Execute read as success", result, execErr, outer)
		}
		if !errors.Is(execErr, cause) {
			t.Fatal("original custody cause lost")
		}
		if line, exit := closedHelperTerminal(closedHelperExecID, result, execErr); exit != 79 || !strings.Contains(string(line), `"unknown"`) {
			t.Fatal("not unknown", exit, string(line))
		}
	})
	t.Run("scope-final-check", func(t *testing.T) {
		f := newClosedHelperFixture(t)
		f.checkErr = cause
		var result *executionapp.Result
		var execErr error
		outer := f.run(context.Background(), func(h closedReleaseHelper) error {
			result, execErr = h.execute(context.Background())
			f.failCheck = f.checks + 1 // The scope's check after the callback.
			return nil
		})
		if execErr != nil || result == nil || *result != (executionapp.Result{Phase: "verified"}) {
			t.Fatal("setup: Execute should have succeeded", result, execErr)
		}
		if outer == nil || !errors.Is(outer, cause) {
			t.Fatal("final check failure did not surface", outer)
		}
		// A caller that captured a clean result still gets the scope error: the
		// non-nil error governs the terminal classification.
		if line, exit := closedHelperTerminal(closedHelperExecID, result, outer); exit != 79 {
			t.Fatal("captured success outlived a failed final check", exit, string(line))
		}
	})
}

func TestClosedHelperTerminalMapping(t *testing.T) {
	id := closedHelperExecID
	want := func(phase, code string, withID bool) string {
		s := `{"phase": "` + phase + `"`
		if code != "" {
			s += `, "error": "` + code + `"`
		}
		if withID {
			s += `, "operationId": "` + id + `"`
		}
		return s + "}\n"
	}
	failure := func(f executionapp.Failure) error { return &f }
	long := strings.Repeat("a", 81)
	cases := []struct {
		name   string
		id     string
		result *executionapp.Result
		err    error
		line   string
		exit   int
	}{
		{"verified", id, &executionapp.Result{Phase: "verified"}, nil, want("verified", "", true), 0},
		{"rolled-back", id, &executionapp.Result{Phase: "rolled_back"}, nil, want("rolled_back", "", true), 0},
		{"result-code", id, &executionapp.Result{Phase: "rolled_back", Code: "target_verification"}, nil, want("rolled_back", "target_verification", true), 70},
		{"failure-refusal", id, nil, failure(executionapp.Failure{Code: "closed_rollback_pair", Phase: "refused"}), want("refused", "closed_rollback_pair", true), 70},
		{"failure-with-clean-cause", id, nil, failure(executionapp.Failure{Code: "journal_invalid", Phase: "refused", Cause: context.Canceled}), want("refused", "journal_invalid", true), 70},
		{"failure-beats-result", id, &executionapp.Result{Phase: "verified"}, failure(executionapp.Failure{Code: "x", Phase: "refused"}), want("refused", "x", true), 70},
		{"error-beats-clean-result", id, &executionapp.Result{Phase: "verified"}, errors.New("late"), want("unknown", "internal", true), 79},
		{"uncertain", id, nil, failure(executionapp.Failure{Code: "x", Phase: "refused", Uncertain: true}), want("unknown", "internal", true), 79},
		{"internal", id, nil, failure(executionapp.Failure{Code: "x", Phase: "refused", Internal: true}), want("unknown", "internal", true), 79},
		{"uncertain-cause", id, nil, failure(executionapp.Failure{Code: "x", Phase: "refused", Cause: errors.New("opaque")}), want("unknown", "internal", true), 79},
		{"non-failure", id, nil, errors.New("plain"), want("unknown", "internal", true), 79},
		{"wrapped-failure", id, nil, fmt.Errorf("w: %w", &executionapp.Failure{Code: "x", Phase: "refused"}), want("unknown", "internal", true), 79},
		{"scope-failure", id, nil, closedHelperFail(true, &executionapp.Failure{Code: "x", Phase: "refused"}), want("unknown", "internal", true), 79},
		{"typed-nil-failure", id, nil, (*executionapp.Failure)(nil), want("unknown", "internal", true), 79},
		{"nil-nil", id, nil, nil, want("unknown", "internal", true), 79},
		{"empty-phase", id, &executionapp.Result{}, nil, want("unknown", "internal", true), 79},
		{"bad-phase-uppercase", id, &executionapp.Result{Phase: "Verified"}, nil, want("unknown", "internal", true), 79},
		{"bad-phase-digit", id, &executionapp.Result{Phase: "phase2"}, nil, want("unknown", "internal", true), 79},
		{"bad-phase-quote", id, &executionapp.Result{Phase: `a"b`}, nil, want("unknown", "internal", true), 79},
		{"bad-phase-length", id, &executionapp.Result{Phase: strings.Repeat("a", 41)}, nil, want("unknown", "internal", true), 79},
		{"bad-code-leading-digit", id, &executionapp.Result{Phase: "verified", Code: "1x"}, nil, want("unknown", "internal", true), 79},
		{"bad-code-char", id, &executionapp.Result{Phase: "verified", Code: "a-b"}, nil, want("unknown", "internal", true), 79},
		{"bad-code-length", id, &executionapp.Result{Phase: "verified", Code: long}, nil, want("unknown", "internal", true), 79},
		{"failure-bad-phase", id, nil, failure(executionapp.Failure{Code: "x", Phase: "Refused"}), want("unknown", "internal", true), 79},
		{"failure-empty-code", id, nil, failure(executionapp.Failure{Phase: "refused"}), want("unknown", "internal", true), 79},
		{"bad-id-short", "abc", &executionapp.Result{Phase: "verified"}, nil, want("unknown", "internal", false), 79},
		{"bad-id-uppercase", strings.ToUpper(id[:31]) + "A", &executionapp.Result{Phase: "verified"}, nil, want("unknown", "internal", false), 79},
		{"empty-id", "", nil, nil, want("unknown", "internal", false), 79},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			line, exit := closedHelperTerminal(c.id, c.result, c.err)
			if exit != c.exit || string(line) != c.line {
				t.Fatalf("got %d %q, want %d %q", exit, line, c.exit, c.line)
			}
			// Every line satisfies the desktop parser's contract.
			if len(line) > 4096 || !strings.HasSuffix(string(line), "\n") {
				t.Fatal("line size or terminator")
			}
			var record map[string]string
			if json.Unmarshal(line, &record) != nil {
				t.Fatal("not a flat JSON object of strings")
			}
			if !closedHelperPhasePattern.MatchString(record["phase"]) {
				t.Fatal("phase outside the parser's pattern")
			}
			if e, ok := record["error"]; ok && !closedHelperCodePattern.MatchString(e) {
				t.Fatal("error outside the parser's pattern")
			}
			if n := len(record); n != 2 && n != 3 && c.id != "" && closedHelperIDPattern.MatchString(c.id) {
				t.Fatal("key count outside 2 or 3", n)
			}
			if closedHelperIDPattern.MatchString(c.id) && record["operationId"] != c.id {
				t.Fatal("operation id not echoed")
			}
		})
	}
	// Key order is phase, error, operationId, exactly as Python's dict.
	line, _ := closedHelperTerminal(id, nil, failure(executionapp.Failure{Code: "c", Phase: "p"}))
	p, e, o := bytes.Index(line, []byte(`"phase"`)), bytes.Index(line, []byte(`"error"`)), bytes.Index(line, []byte(`"operationId"`))
	if !(0 < p+1 && p < e && e < o) {
		t.Fatal("key order", string(line))
	}
}

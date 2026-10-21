package boot

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
)

// Deterministic witnesses for the live helper's relaunch composition. Every
// owner is a private symbolic seam: they prove acceptance, wiring and terminal
// mapping. The launch itself (journal order, argv, the pre-launch image and
// binding checks, and the zero and nonzero open outcomes) is exercised in
// modules/release/infra/native/execution: deterministic Milestone relaunch tests
// and the FAROL_RELAUNCH_NATIVE=1 lane, which replaces open.

const liveRelaunchHome = "/disposable-fixture-home" // closedHelperRequestFixture's home

func TestLiveHelperAcceptsRelaunchForApplyAndRollback(t *testing.T) {
	for _, tc := range []struct{ action, phase string }{
		{"apply", "completed"},
		{"rollback", "rolled_back"},
	} {
		t.Run(tc.action, func(t *testing.T) {
			f := newLiveHelperFixture(t, func(r map[string]any) { r["action"], r["relaunch"] = tc.action, true })
			f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
				return &executionapp.Result{Phase: tc.phase}, nil
			}
			line, exit := f.entry()
			if want := `{"phase": "` + tc.phase + `", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"; exit != 0 || string(line) != want {
				t.Fatalf("exit %d line %q events %v", exit, line, f.events)
			}
			liveHelperSequence(t, f.events,
				"take", "read", "open", "with-files", "admission", "acquire", "capture", "ready", "confirm", "emit", "wait", "quit", "execute")
			if !f.captured.Relaunch || f.execCalls != 1 || len(f.frames) != 1 {
				t.Fatalf("relaunch request not carried: relaunch %v exec %d frames %d", f.captured.Relaunch, f.execCalls, len(f.frames))
			}
			f.closedOnce(t)
		})
	}
}

// The live execution receives the relaunch capabilities only when the request
// asked for them; the closed helper never does.
func TestLiveHelperWiresRelaunchCapabilitiesOnlyForARelaunchRequest(t *testing.T) {
	run := func(t *testing.T, relaunch bool) closedHelperExecution {
		t.Helper()
		var seen closedHelperExecution
		f := newLiveHelperFixture(t, func(r map[string]any) { r["relaunch"] = relaunch })
		f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
			seen = in
			return &executionapp.Result{Phase: "verified"}, nil
		}
		deps := f.deps()
		deps.measure = func(_ context.Context, until time.Time) (releaseport.HelperSelfIdentity, error) {
			if until.IsZero() {
				t.Error("measurement lost its bound")
			}
			return releaseport.HelperSelfIdentity{PID: int64(os.Getpid()), ProcessStart: "declared fixture birth"}, nil
		}
		if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), deps); exit != 0 {
			t.Fatal("exit", exit)
		}
		return seen
	}
	t.Run("relaunch false", func(t *testing.T) {
		if run(t, false).relaunch != nil {
			t.Fatal("a request without relaunch received launch capabilities")
		}
	})
	t.Run("relaunch true", func(t *testing.T) {
		in := run(t, true)
		if in.relaunch == nil || in.relaunch.arguments == nil || in.relaunch.measure == nil {
			t.Fatal("a relaunch request received no launch capabilities", in.relaunch)
		}
		self, err := in.relaunch.measure(context.Background(), time.Now().Add(time.Second))
		if err != nil || self.PID != int64(os.Getpid()) || self.ProcessStart != "declared fixture birth" {
			t.Fatal("the composed measurement is not the dependency", self, err)
		}
	})
	t.Run("measure unwired", func(t *testing.T) {
		// A live execution whose composition supplies no measurement carries none:
		// the runtime then refuses with launch_helper_identity.
		var seen closedHelperExecution
		f := newLiveHelperFixture(t, func(r map[string]any) { r["relaunch"] = true })
		f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
			seen = in
			return &executionapp.Result{Phase: "verified"}, nil
		}
		if _, exit := f.entry(); exit != 0 || seen.relaunch == nil || seen.relaunch.measure != nil {
			t.Fatal("an unwired measurement was invented", exit, seen.relaunch)
		}
	})
}

func TestLiveHelperProductionDependenciesMeasureThisProcess(t *testing.T) {
	if liveHelperProductionDependencies().measure == nil {
		t.Fatal("production composition lost its self measurement")
	}
}

// The composed arguments are the protocol owner's, bound to this request: the
// owner slot for a legacy install, the verified capture for a shared one, and
// always phase "completed" with this helper's pid and process start.
func TestLiveHelperRelaunchArgumentsAreTheProtocolOwners(t *testing.T) {
	self := releaseport.HelperSelfIdentity{PID: 4321, ProcessStart: "helper birth"}
	capture := liveRelaunchHome + "/Library/Application Support/io.github.legrch.farol/installed-updates/" + strings.Repeat("1", 32) + "/launch-Farol.app"
	for _, tc := range []struct {
		name     string
		location string
		captured *string
		app      string
		refused  string
	}{
		{"legacy", "legacy", nil, liveRelaunchHome + "/Applications/Farol.app", ""},
		{"shared capture", "shared", &capture, capture, ""},
		{"shared without a capture", "shared", nil, "", "launch_image_unconfirmed"},
		{"legacy with a capture", "legacy", &capture, "", "launch_image_unexpected"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var seen closedHelperExecution
			f := newLiveHelperFixture(t, func(r map[string]any) { r["relaunch"], r["installLocation"] = true, tc.location })
			f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
				seen = in
				return &executionapp.Result{Phase: "verified"}, nil
			}
			if _, exit := f.entry(); exit != 0 || seen.relaunch == nil {
				t.Fatal("exit", exit)
			}
			arguments, err := seen.relaunch.arguments(context.Background(), self, tc.captured)
			if tc.refused != "" {
				if err == nil || arguments != nil {
					t.Fatal("unbound launch image accepted", arguments, err)
				}
				return
			}
			if err != nil || len(arguments) != 5 {
				t.Fatal("arguments", arguments, err)
			}
			if !reflect.DeepEqual(arguments[:4], []string{"/usr/bin/open", "-a", tc.app, "--args"}) {
				t.Fatalf("argv %q", arguments)
			}
			const prefix = "--farol-installed-update-relaunch="
			if !strings.HasPrefix(arguments[4], prefix) {
				t.Fatal("hint argument", arguments[4])
			}
			var hint struct {
				OperationID string `json:"operationId"`
				Action      string `json:"action"`
				Phase       string `json:"phase"`
				BuildID     string `json:"buildId"`
				Helper      struct {
					PID          int64  `json:"pid"`
					ProcessStart string `json:"processStart"`
				} `json:"helper"`
			}
			if err := json.Unmarshal([]byte(strings.TrimPrefix(arguments[4], prefix)), &hint); err != nil {
				t.Fatal(err)
			}
			if hint.OperationID != strings.Repeat("1", 32) || hint.Action != "apply" || hint.Phase != "completed" ||
				hint.BuildID != strings.Repeat("5", 64) || hint.Helper.PID != 4321 || hint.Helper.ProcessStart != "helper birth" {
				t.Fatalf("hint %+v", hint)
			}
		})
	}
}

// The closed helper supplies no launch capability, and still refuses relaunch
// before any IO.
func TestClosedHelperExecutionCarriesNoRelaunchCapabilities(t *testing.T) {
	f := newClosedHelperFixture(t)
	var seen closedHelperExecution
	f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
		seen = in
		return &executionapp.Result{Phase: "verified"}, nil
	}
	err := f.run(context.Background(), func(s closedReleaseHelper) error {
		_, e := s.execute(context.Background())
		return e
	})
	if err != nil || f.execCalls != 1 || seen.relaunch != nil {
		t.Fatal("closed execution carried relaunch capabilities", err, f.execCalls, seen.relaunch)
	}
}

// Terminal mapping for the relaunch results. The desktop reads no stdout after
// it quits; the line and exit are the helper's own contract.
func TestLiveHelperRelaunchTerminalMapping(t *testing.T) {
	id := closedHelperEntryTestID
	for _, tc := range []struct {
		name   string
		result *executionapp.Result
		err    error
		line   string
		exit   int
	}{
		{"completed", &executionapp.Result{Phase: "completed"}, nil,
			`{"phase": "completed", "operationId": "` + id + `"}` + "\n", 0},
		{"clean launch_failed", &executionapp.Result{Phase: "launch_requested", Code: "launch_failed"}, nil,
			`{"phase": "launch_requested", "error": "launch_failed", "operationId": "` + id + `"}` + "\n", 70},
		{"launch_failed as a failure", nil, &executionapp.Failure{Phase: "launch_requested", Code: "launch_failed"},
			`{"phase": "launch_requested", "error": "launch_failed", "operationId": "` + id + `"}` + "\n", 70},
		{"unknown open outcome stays unknown", nil, &executionapp.Failure{Phase: "launch_requested", Code: "launch_failed", Uncertain: true},
			liveHelperUnknownLine, 79},
		{"unclassified launch error stays unknown", nil, errors.Join(errors.New("open outcome unknown"), &executionapp.Failure{Phase: "launch_requested", Code: "launch_unavailable"}),
			liveHelperUnknownLine, 79},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLiveHelperFixture(t, func(r map[string]any) { r["relaunch"] = true })
			f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) { return tc.result, tc.err }
			line, exit := f.entry()
			if exit != tc.exit || string(line) != tc.line {
				t.Fatalf("exit %d line %q, want %d %q", exit, line, tc.exit, tc.line)
			}
		})
	}
}

// The runtime configuration carries the launch capabilities exactly when the
// execution does: a live relaunch execution wires both, anything else neither.
func TestClosedHelperNativeConfigWiresRelaunchCapabilitiesOnlyWhenCarried(t *testing.T) {
	measure := func(context.Context, time.Time) (releaseport.HelperSelfIdentity, error) {
		return releaseport.HelperSelfIdentity{}, nil
	}
	arguments := func(context.Context, releaseport.HelperSelfIdentity, *string) ([]string, error) { return nil, nil }
	carried := closedHelperNativeConfig(closedHelperExecution{relaunch: &closedHelperRelaunch{arguments: arguments, measure: measure}}, nil, nil)
	if carried.RelaunchArguments == nil || carried.MeasureSelf == nil {
		t.Fatal("a relaunch execution lost a launch capability", carried.RelaunchArguments != nil, carried.MeasureSelf != nil)
	}
	for name, in := range map[string]closedHelperExecution{
		"closed":                     {},
		"no measurement":             {relaunch: &closedHelperRelaunch{arguments: arguments}},
		"no argument capability":     {relaunch: &closedHelperRelaunch{measure: measure}},
		"empty relaunch capability":  {relaunch: &closedHelperRelaunch{}},
		"relaunch carried but unset": {relaunch: nil},
	} {
		c := closedHelperNativeConfig(in, nil, nil)
		wantArgs, wantMeasure := in.relaunch != nil && in.relaunch.arguments != nil, in.relaunch != nil && in.relaunch.measure != nil
		if (c.RelaunchArguments != nil) != wantArgs || (c.MeasureSelf != nil) != wantMeasure {
			t.Fatalf("%s: wiring args=%v measure=%v", name, c.RelaunchArguments != nil, c.MeasureSelf != nil)
		}
	}
}

// liveRelaunchProbe scripts one observation and counts the joins of it.
type liveRelaunchProbe struct {
	observation releaseport.ProcessObservation
	observeErr  error
	joinErr     error
	observed    int
	joined      int
}

func (p *liveRelaunchProbe) Observe(context.Context, time.Time) (releaseport.ProcessObservation, error) {
	p.observed++
	return p.observation, p.observeErr
}
func (p *liveRelaunchProbe) Join() error { p.joined++; return p.joinErr }

// The measurement joins the original observation on EVERY path, and a join
// failure is never a clean identity. A clean observation refusal is the one
// launch_helper_identity refusal; everything else stays opaque and uncertain.
func TestLiveHelperMeasureJoinsTheObservationOnEveryPath(t *testing.T) {
	until := time.Now().Add(time.Second)
	present := releaseport.ProcessObservation{Presence: releaseport.ProcessPresent, Start: "Mon Oct 19 12:00:00 2026"}
	for _, tc := range []struct {
		name    string
		probe   liveRelaunchProbe
		ok      bool
		refusal bool // a clean launch_helper_identity refusal
	}{
		{"present", liveRelaunchProbe{observation: present}, true, false},
		{"absent", liveRelaunchProbe{observation: releaseport.ProcessObservation{Presence: releaseport.ProcessAbsent}}, false, true},
		{"observation failed", liveRelaunchProbe{observeErr: &releaseport.ProcessProbeFailure{Kind: releaseport.ProcessProbeStartFailure}}, false, false},
		{"join failed after a good observation", liveRelaunchProbe{observation: present, joinErr: &releaseport.ProcessProbeFailure{Kind: releaseport.ProcessProbeCleanupUnknown}}, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			probe := tc.probe
			self, err := liveHelperMeasureWith(context.Background(), until, 4321, &probe, liveHelperClock{})
			if probe.joined != 1 {
				t.Fatalf("the original observation was joined %d times", probe.joined)
			}
			if tc.ok {
				if err != nil || self != (releaseport.HelperSelfIdentity{PID: 4321, ProcessStart: "Mon Oct 19 12:00:00 2026"}) {
					t.Fatal("identity", self, err)
				}
				return
			}
			if err == nil || self != (releaseport.HelperSelfIdentity{}) {
				t.Fatal("an unqualified measurement produced an identity", self, err)
			}
			var refusal *releaseport.HelperRecoveryFailure
			if got := errors.As(err, &refusal) && refusal.Code == "launch_helper_identity" && !refusal.Uncertain && !refusal.Internal; got != tc.refusal {
				t.Fatalf("classification: clean launch_helper_identity refusal = %v, want %v (%v)", got, tc.refusal, err)
			}
		})
	}
}

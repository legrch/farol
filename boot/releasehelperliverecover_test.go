package boot

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	releaseport "github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	inputapp "github.com/legrch/farol/modules/release/app/services/helperinput"
	protocolapp "github.com/legrch/farol/modules/release/app/services/helperprotocol"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
	release "github.com/legrch/farol/modules/release/domain"
	inputnative "github.com/legrch/farol/modules/release/infra/native/helperinput"
	protocolnative "github.com/legrch/farol/modules/release/infra/native/helperprotocol"
	"github.com/legrch/farol/modules/release/infra/native/helperroutes"
)

// Deterministic witnesses for the live helper's recover-with-relaunch
// composition. Every owner is a private symbolic seam: they prove acceptance,
// wiring and terminal mapping. The recovery policy itself, and the rule that only a
// verified recovery launches, are exercised over the real runtime in
// modules/release/infra/native/execution (milestonerecover_test.go).

func recoverWithRelaunch(r map[string]any) { r["action"], r["relaunch"] = "recover", true }

// A live recover WITH relaunch is accepted and follows the apply order exactly:
// the same custody phases, one waiting_for_exit frame, one Execute.
func TestLiveHelperAcceptsRecoverWithRelaunch(t *testing.T) {
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) {
		return &executionapp.Result{Phase: "completed"}, nil
	}
	line, exit := f.entry()
	if want := `{"phase": "completed", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"; exit != 0 || string(line) != want {
		t.Fatalf("exit %d line %q events %v", exit, line, f.events)
	}
	liveHelperSequence(t, f.events,
		"take", "read", "open", "with-files", "admission", "check", "acquire", "check", "capture", "check",
		"ready", "confirm", "check", "emit", "wait", "quit", "check", "execute", "check")
	if f.captured.Action != "recover" || !f.captured.Relaunch || f.readyCalls != 1 || f.execCalls != 1 || len(f.frames) != 1 || f.framesAtReady != 0 {
		t.Fatalf("recover request not carried: %+v ready %d exec %d frames %d", f.captured, f.readyCalls, f.execCalls, len(f.frames))
	}
	protocol, err := protocolapp.Bind(context.Background(), f.input, inputapp.New(inputnative.JSONDecoder{}), protocolnative.JSONCodec{})
	if err != nil {
		t.Fatal(err)
	}
	want, err := protocol.BuildHandoff(context.Background(), protocolapp.WaitingForExit, nil)
	if err != nil || !bytes.Equal(f.frames[0], want) {
		t.Fatalf("frame %q want %q err %v", f.frames[0], want, err)
	}
	f.closedOnce(t)
}

// Offline recover (relaunch false) has no production caller and stays refused
// before any IO, with the same unknown line as every other unsupported shape.
func TestLiveHelperRefusesOfflineRecover(t *testing.T) {
	f := newLiveHelperFixture(t, func(r map[string]any) { r["action"], r["relaunch"] = "recover", false })
	line, exit := f.entry()
	if exit != 79 || string(line) != `{"phase": "unknown", "error": "internal"}`+"\n" {
		t.Fatalf("exit %d line %q", exit, line)
	}
	for _, e := range []string{"open", "with-files", "admission", "acquire", "capture", "ready", "confirm", "emit", "wait", "quit", "execute"} {
		if f.count(e) != 0 {
			t.Fatalf("offline recover reached %s: %v", e, f.events)
		}
	}
	if len(f.frames) != 0 {
		t.Fatal("offline recover emitted a frame")
	}
}

// The closed helper still refuses recover, with or without relaunch.
func TestClosedHelperStillRefusesRecoverWithRelaunch(t *testing.T) {
	for _, relaunch := range []bool{false, true} {
		f := newClosedHelperFixture(t)
		r := closedHelperRequestFixture()
		r["action"], r["relaunch"] = "recover", relaunch
		f.input = closedHelperJSON(t, r)
		closedHelperFailureCheck(t, f.run(context.Background(), nil))
		if closedHelperHas(f.events, "borrow") || f.callback != 0 || len(f.frames) != 0 {
			t.Fatalf("relaunch=%v: unsupported request reached native custody", relaunch)
		}
	}
}

// Terminal mapping for a recovery. Cancelled and rolled_back are clean exit-0
// outcomes; only a clean launch_failed (a recovery that settled verified, then
// failed to launch) is exit 70, and anything unclassified stays unknown.
func TestLiveHelperRecoverTerminalMapping(t *testing.T) {
	id := closedHelperEntryTestID
	ok := func(phase string) string { return `{"phase": "` + phase + `", "operationId": "` + id + `"}` + "\n" }
	for _, tc := range []struct {
		name   string
		result *executionapp.Result
		err    error
		line   string
		exit   int
	}{
		{"verified then completed", &executionapp.Result{Phase: "completed"}, nil, ok("completed"), 0},
		{"cancelled", &executionapp.Result{Phase: "cancelled"}, nil, ok("cancelled"), 0},
		{"rolled_back", &executionapp.Result{Phase: "rolled_back"}, nil, ok("rolled_back"), 0},
		{"launch_failed", &executionapp.Result{Phase: "launch_requested", Code: "launch_failed"}, nil,
			`{"phase": "launch_requested", "error": "launch_failed", "operationId": "` + id + `"}` + "\n", 70},
		// The recovery owner's own Failure type is what a live recover surfaces.
		{"recovery refusal", nil, &helperrecovery.Failure{Phase: "prepared", Code: "recovery_pair"},
			`{"phase": "prepared", "error": "recovery_pair", "operationId": "` + id + `"}` + "\n", 70},
		{"attempt unknown", nil, &helperrecovery.Failure{Phase: "refused", Code: "recovery_attempt_unknown", Uncertain: true}, liveHelperUnknownLine, 79},
		{"internal recovery failure", nil, &helperrecovery.Failure{Phase: "refused", Code: "internal", Internal: true}, liveHelperUnknownLine, 79},
		{"uncertain recovery refusal", nil, &helperrecovery.Failure{Phase: "prepared", Code: "recovery_pair", Uncertain: true}, liveHelperUnknownLine, 79},
		{"typed-nil recovery failure", nil, (*helperrecovery.Failure)(nil), liveHelperUnknownLine, 79},
		{"wrapped recovery refusal", nil, errors.Join(&helperrecovery.Failure{Phase: "prepared", Code: "recovery_pair"}), liveHelperUnknownLine, 79},
		{"malformed recovery code", nil, &helperrecovery.Failure{Phase: "prepared", Code: "Bad Code"}, liveHelperUnknownLine, 79},
		{"opaque error", nil, errors.New("recovery boom"), liveHelperUnknownLine, 79},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newLiveHelperFixture(t, recoverWithRelaunch)
			f.execFn = func(context.Context, closedHelperExecution) (*executionapp.Result, error) { return tc.result, tc.err }
			line, exit := f.entry()
			if exit != tc.exit || string(line) != tc.line {
				t.Fatalf("exit %d line %q, want %d %q", exit, line, tc.exit, tc.line)
			}
			if f.execCalls != 1 || len(f.frames) != 1 {
				t.Fatalf("exec %d frames %d", f.execCalls, len(f.frames))
			}
		})
	}
}

// recoverFakeRuntime is a scripted native runtime for the PRODUCTION recovery
// policy owner: it supplies observations only, so the failures it provokes are
// the real helperrecovery.Failure values the live helper must classify.
type recoverFakeRuntime struct {
	phase    string
	phaseErr error
	entries  releaseport.HelperRecoveryEntries
}

func (r recoverFakeRuntime) ReadPhase(context.Context) (string, error) { return r.phase, r.phaseErr }
func (r recoverFakeRuntime) Entries(context.Context) (releaseport.HelperRecoveryEntries, error) {
	return r.entries, nil
}
func (recoverFakeRuntime) MatchesTree(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperBuild) (bool, error) {
	return false, nil
}
func (recoverFakeRuntime) VerifyTree(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperBuild) error {
	return nil
}
func (recoverFakeRuntime) Fence(context.Context) error { return nil }
func (recoverFakeRuntime) Rename(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperRecoveryEntry, releaseport.HelperIdentity) error {
	return nil
}
func (recoverFakeRuntime) Exchange(context.Context, releaseport.HelperRecoveryEntry, releaseport.HelperRecoveryEntry, releaseport.HelperIdentity, releaseport.HelperIdentity) error {
	return nil
}
func (recoverFakeRuntime) WritePhase(context.Context, string) error { return nil }

// recoverFakeObservation is the read-only projection the Milestone's readiness
// inspects: one journal at the scripted phase for exactly this request.
type recoverFakeObservation struct {
	recoverFakeRuntime
	operation release.Operation
}

func (o recoverFakeObservation) ReadJournal(context.Context) (*releaseport.JournalView, error) {
	return &releaseport.JournalView{Value: &release.Journal{Operation: o.operation, Phase: o.phase}, Revision: "r1"}, nil
}

// recoverReady is the readiness seam running the REAL Milestone.Inspect, with the
// production recovery policy, over the scripted observation.
func recoverReady(f *liveHelperFixture, script recoverFakeRuntime) func(context.Context, *executionapp.Milestone, closedReleaseHelper) (*executionapp.Readiness, error) {
	return func(ctx context.Context, m *executionapp.Milestone, h closedReleaseHelper) (*executionapp.Readiness, error) {
		f.event("ready")
		f.readyCalls++
		operation, _, _ := closedHelperOperationBinding(h.state.request, helperroutes.Files{})
		return m.Inspect(ctx, recoverFakeObservation{recoverFakeRuntime: script, operation: operation})
	}
}

// A clean Inspect refusal of the PRODUCTION recovery owner (a prepared journal
// whose only entry is the app) is one refused frame and exit 70 with the owner's
// own phase and code: the desktop is never told to quit, nothing waits and nothing
// executes. The owner's type is helperrecovery.Failure, not the execution one.
func TestLiveHelperRecoverCleanInspectRefusalSendsOneRefusedFrame(t *testing.T) {
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	deps := f.deps()
	deps.recovery = helperRecoveryPolicies{}
	script := recoverFakeRuntime{phase: "prepared", entries: releaseport.HelperRecoveryEntries{App: releaseport.HelperRecoveryEntrySnapshot{Present: true, Directory: true}}}
	deps.ready = recoverReady(f, script)
	line, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), deps)
	if exit != 70 || string(line) != refusalLine("prepared", "recovery_pair") {
		t.Fatalf("exit %d line %q events %v", exit, line, f.events)
	}
	if len(f.frames) != 1 || !bytes.Equal(f.frames[0], wantRefusedFrame(t, f.input, "recovery_pair")) {
		t.Fatalf("frames %q", f.frames)
	}
	for _, e := range []string{"confirm", "wait", "quit", "execute"} {
		if f.count(e) != 0 {
			t.Fatalf("refusal reached %s: %v", e, f.events)
		}
	}
}

// An uncertain or internal Inspect failure of the same owner is NOT a refusal:
// no frame, exit 79.
func TestLiveHelperRecoverUncertainInspectFailureStaysUnknown(t *testing.T) {
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	deps := f.deps()
	deps.recovery = helperRecoveryPolicies{}
	script := recoverFakeRuntime{phase: "prepared", phaseErr: errors.New("journal read boom")}
	// Precondition: the owner itself classifies this as internal.
	service, err := helperrecovery.ObserveCaptured(context.Background(), releaseport.HelperRequest{Action: "recover"}, recoverFakeObservation{recoverFakeRuntime: script})
	var owned *helperrecovery.Failure
	if err != nil || !errors.As(service.Inspect(context.Background()), &owned) || !(owned.Internal || owned.Uncertain) {
		t.Fatal("the owner no longer classifies an opaque read failure as internal", owned)
	}
	deps.ready = recoverReady(f, script)
	line, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), deps)
	if exit != 79 || len(f.frames) != 0 {
		t.Fatalf("exit %d line %q frames %d", exit, line, len(f.frames))
	}
}

// A clean Reconcile refusal AFTER the waiting_for_exit frame: the production owner
// refuses (app absent, prepared), the exit is 70 with its phase and code, and no
// second frame is written.
func TestLiveHelperRecoverCleanReconcileRefusalAfterTheFrame(t *testing.T) {
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	f.execFn = func(ctx context.Context, in closedHelperExecution) (*executionapp.Result, error) {
		service, err := helperRecoveryPolicies{}.Bind(ctx, in.request, recoverFakeRuntime{phase: "prepared"})
		if err != nil {
			return nil, err
		}
		_, err = service.Reconcile(ctx)
		return nil, err
	}
	line, exit := f.entry()
	want := `{"phase": "prepared", "error": "predecessor_missing", "operationId": "` + closedHelperEntryTestID + `"}` + "\n"
	if exit != 70 || string(line) != want {
		t.Fatalf("exit %d line %q", exit, line)
	}
	if f.execCalls != 1 || len(f.frames) != 1 {
		t.Fatalf("exec %d frames %d: a refusal after the frame must send no second frame", f.execCalls, len(f.frames))
	}
}

// An uncertain Reconcile failure of the production owner stays unknown.
func TestLiveHelperRecoverUncertainReconcileFailureStaysUnknown(t *testing.T) {
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	f.execFn = func(ctx context.Context, in closedHelperExecution) (*executionapp.Result, error) {
		service, err := helperRecoveryPolicies{}.Bind(ctx, in.request, recoverFakeRuntime{phaseErr: errors.New("journal read boom")})
		if err != nil {
			return nil, err
		}
		_, err = service.Reconcile(ctx)
		var owned *helperrecovery.Failure
		if !errors.As(err, &owned) || !(owned.Internal || owned.Uncertain) {
			t.Error("the owner no longer classifies an opaque read failure as internal", err)
		}
		return nil, err
	}
	line, exit := f.entry()
	if exit != 79 || string(line) != liveHelperUnknownLine || len(f.frames) != 1 {
		t.Fatalf("exit %d line %q frames %d", exit, line, len(f.frames))
	}
}

// The recovery policy owner is attached to a recover Milestone ONLY; apply and
// rollback keep the policy-free Milestone.
func TestLiveHelperAttachesTheRecoveryPolicyOnlyForRecover(t *testing.T) {
	sentinel := helperRecoveryPolicies{}
	for _, tc := range []struct {
		action   string
		relaunch bool
		policies int
	}{
		{"recover", true, 1},
		{"apply", false, 0},
		{"apply", true, 0},
		{"rollback", false, 0},
		{"rollback", true, 0},
	} {
		t.Run(tc.action+map[bool]string{false: "", true: "-relaunch"}[tc.relaunch], func(t *testing.T) {
			var seen []releaseport.HelperRecoveryPolicies
			var action string
			f := newLiveHelperFixture(t, func(r map[string]any) { r["action"], r["relaunch"] = tc.action, tc.relaunch })
			deps := f.deps()
			deps.recovery = sentinel
			deps.milestone = func(ctx context.Context, r releaseport.HelperRequest, policies ...releaseport.HelperRecoveryPolicies) (*executionapp.Milestone, error) {
				action, seen = r.Action, policies
				return executionapp.NewMilestone(ctx, r, policies...)
			}
			if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), deps); exit != 0 {
				t.Fatalf("exit %d: %v", exit, f.events)
			}
			if action != tc.action || len(seen) != tc.policies {
				t.Fatalf("%s: milestone built with %d policies", action, len(seen))
			}
			if tc.policies == 1 && seen[0] != sentinel {
				t.Fatal("the recover Milestone did not receive the composed policy owner")
			}
		})
	}
}

// Production composition supplies the boot-adapted recovery owner and the real
// Milestone constructor.
func TestLiveHelperProductionDependenciesCarryTheRecoveryOwner(t *testing.T) {
	deps := liveHelperProductionDependencies()
	if _, ok := deps.recovery.(helperRecoveryPolicies); !ok || deps.milestone == nil {
		t.Fatal("production composition lost the recovery owner", deps.recovery, deps.milestone == nil)
	}
	for _, action := range []string{"recover", "apply", "rollback"} {
		request := releaseport.HelperRequest{Action: action, Relaunch: true}
		if m, err := liveHelperMilestone(context.Background(), request, deps); err != nil || m == nil {
			t.Fatalf("%s: milestone %v err %v", action, m, err)
		}
	}
	// A recover without a composed owner builds a Milestone that refuses at
	// readiness (recovery_policy_required); it never invents a substitute.
	deps.recovery, deps.milestone = nil, nil
	if m, err := liveHelperMilestone(context.Background(), releaseport.HelperRequest{Action: "recover", Relaunch: true}, deps); err != nil || m == nil {
		t.Fatalf("milestone %v err %v", m, err)
	}
}

// The recover execution carries the relaunch capabilities, and the hint it builds
// names action "recover" with phase "completed" for this helper (the Python
// recover hint, update_helper.py:1388).
func TestLiveHelperRecoverHintNamesTheRecoverAction(t *testing.T) {
	var seen closedHelperExecution
	f := newLiveHelperFixture(t, recoverWithRelaunch)
	f.execFn = func(_ context.Context, in closedHelperExecution) (*executionapp.Result, error) {
		seen = in
		return &executionapp.Result{Phase: "completed"}, nil
	}
	deps := f.deps()
	deps.measure = func(context.Context, time.Time) (releaseport.HelperSelfIdentity, error) {
		return releaseport.HelperSelfIdentity{PID: int64(os.Getpid()), ProcessStart: "declared fixture birth"}, nil
	}
	if _, exit := liveHelperEntry(context.Background(), liveHelperFiles{}, time.Now().Add(10*time.Second), deps); exit != 0 {
		t.Fatal("exit", exit)
	}
	if seen.relaunch == nil || seen.relaunch.arguments == nil || seen.relaunch.measure == nil {
		t.Fatal("a recover relaunch received no launch capabilities", seen.relaunch)
	}
	arguments, err := seen.relaunch.arguments(context.Background(), releaseport.HelperSelfIdentity{PID: 4321, ProcessStart: "helper birth"}, nil)
	if err != nil || len(arguments) != 5 {
		t.Fatal("arguments", arguments, err)
	}
	const prefix = "--farol-installed-update-relaunch="
	var hint struct{ OperationID, Action, Phase string }
	if !strings.HasPrefix(arguments[4], prefix) || json.Unmarshal([]byte(strings.TrimPrefix(arguments[4], prefix)), &hint) != nil ||
		hint.OperationID != closedHelperEntryTestID || hint.Action != "recover" || hint.Phase != "completed" {
		t.Fatalf("hint %q", arguments[4])
	}
}

// The adapter is the ORIGINAL recovery owner and never a typed-nil interface.
type recoveryObservationStub struct {
	releaseport.HelperRecoveryObservation
}

func TestHelperRecoveryPoliciesAdaptTheOriginalOwner(t *testing.T) {
	request := releaseport.HelperRequest{Action: "recover", Relaunch: true}
	inspection, err := helperRecoveryPolicies{}.Observe(context.Background(), request, recoveryObservationStub{})
	if err != nil || inspection == nil {
		t.Fatal("observation owner not bound", inspection, err)
	}
	if got, err := (helperRecoveryPolicies{}).Observe(context.Background(), request, nil); err == nil || got != nil {
		t.Fatal("a missing observation produced a policy", got, err)
	}
	if got, err := (helperRecoveryPolicies{}).Bind(context.Background(), request, nil); err == nil || got != nil {
		t.Fatal("a missing runtime produced a policy", got, err)
	}
}

package execution

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
	release "github.com/legrch/farol/modules/release/domain"
)

// Symbolic application composition only. These ports provide no native image,
// parser/provenance, journal durability, lease, Quit, child Wait or startup proof.
type milestoneRuntime struct {
	*runtimeFixture
	revision int
}

func milestoneFixture(action string, closed bool) (port.HelperRequest, *milestoneRuntime) {
	r := requestFixture(action)
	r.Home = "/symbolic-home"
	r.OperationID = strings.Repeat("1", 32)
	if !closed {
		r.Predecessor = nil
		r.LeaseIdentity = nil
	}
	return r, &milestoneRuntime{runtimeFixture: newRuntime(r), revision: 1}
}
func (r *milestoneRuntime) ReadJournal(context.Context) (v *port.JournalView, err error) {
	err = r.call("observe-journal", func() error {
		v = &port.JournalView{Revision: fmt.Sprint(r.revision)}
		if r.phase != "" {
			v.Value = &release.Journal{Operation: expectedOperation(r.request), Phase: r.phase}
		}
		return nil
	})
	return
}
func (r *milestoneRuntime) Prepare(ctx context.Context) error {
	if err := r.runtimeFixture.Prepare(ctx); err != nil {
		return err
	}
	r.revision++
	return nil
}
func (r *milestoneRuntime) WritePhase(ctx context.Context, phase string) error {
	if err := r.runtimeFixture.WritePhase(ctx, phase); err != nil {
		return err
	}
	r.revision++
	return nil
}
func requireNoEffect(t *testing.T, r *milestoneRuntime) {
	t.Helper()
	for _, s := range r.trace {
		if s == "prepare" || s == "reject" || strings.HasPrefix(s, "write:") || strings.HasPrefix(s, "exchange:") || strings.HasPrefix(s, "rename:") || strings.HasPrefix(s, "launch") || s == "capture" {
			t.Fatal("readiness consumed an effect", r.trace)
		}
	}
}
func requireExecutionCode(t *testing.T, err error, code string, unknown bool) {
	t.Helper()
	var failure *Failure
	if !errors.As(err, &failure) || failure.Code != code || failure.Uncertain != unknown {
		t.Fatalf("want %s uncertain=%v got %#v", code, unknown, err)
	}
}
func indexTrace(t *testing.T, trace []string, want string) int {
	t.Helper()
	for i, s := range trace {
		if s == want {
			return i
		}
	}
	t.Fatal("missing trace", want, trace)
	return -1
}

func TestInstallationReadinessRejectsBeforeAnyEffect(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*milestoneRuntime)
	}{
		{"existing-journal", "operation_exists", func(r *milestoneRuntime) { r.phase = "prepared" }},
		{"previous", "operation_exists", func(r *milestoneRuntime) { r.trees[port.Previous] = r.trees[port.App] }},
		{"failed", "operation_exists", func(r *milestoneRuntime) { r.trees[port.Failed] = r.trees[port.App] }},
		{"rejection", "operation_exists", func(r *milestoneRuntime) { r.reject = true }},
		{"app-missing", "app_missing", func(r *milestoneRuntime) { delete(r.trees, port.App) }},
		{"stage-missing", "staged_missing", func(r *milestoneRuntime) { delete(r.trees, port.Staged) }},
		{"cross-device", "exchange_unsupported", func(r *milestoneRuntime) {
			v := r.trees[port.Staged]
			v.identity.Device = "2"
			r.trees[port.Staged] = v
		}},
		{"source-mismatch", "tree", func(r *milestoneRuntime) { v := r.trees[port.App]; v.build.Version = "other"; r.trees[port.App] = v }},
		{"pair-replaced", "readiness_pair_changed", func(r *milestoneRuntime) {
			r.after = func(s string) {
				if strings.HasPrefix(s, "verify:1:") {
					v := r.trees[port.Staged]
					v.identity.Inode = "303"
					r.trees[port.Staged] = v
				}
			}
		}},
		{"journal-replaced", "readiness_journal_changed", func(r *milestoneRuntime) {
			r.after = func(s string) {
				if strings.HasPrefix(s, "verify:1:") {
					r.revision++
				}
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request, r := milestoneFixture("apply", true)
			tc.change(r)
			ready, err := InspectInstallation(context.Background(), request, r)
			if ready != nil {
				t.Fatal("refused preflight returned observations")
			}
			requireExecutionCode(t, err, tc.code, false)
			requireNoEffect(t, r)
		})
	}
}

func TestInstallationReadinessPinsClosedRollbackPhaseAndRevision(t *testing.T) {
	for _, closed := range []bool{false, true} {
		for _, phase := range []string{"verified", "completed", "launch_requested", "prepared", "rollback_started"} {
			t.Run(fmt.Sprint(closed, "-", phase), func(t *testing.T) {
				request, r := milestoneFixture("rollback", closed)
				r.phase = phase
				ready, err := InspectInstallation(context.Background(), request, r)
				accepted := phase == "verified" || phase == "completed" || phase == "launch_requested" && !closed
				if accepted != (err == nil) || accepted != (ready != nil) {
					t.Fatal("phase admission changed", err)
				}
				requireNoEffect(t, r)
				if ready != nil {
					r.revision++
					err = ready.Recheck(context.Background(), r)
					if closed {
						requireExecutionCode(t, err, "closed_rollback_pair_changed", false)
					} else if err != nil {
						t.Fatal(err)
					}
					requireNoEffect(t, r)
				}
			})
		}
	}
}

func TestInstallationReadinessRollbackRefusalPhaseParity(t *testing.T) {
	for _, closed := range []bool{false, true} {
		for _, fault := range []string{"phase", "pair", "tree", "pair-change", "journal-change"} {
			t.Run(fmt.Sprint(closed, "/", fault), func(t *testing.T) {
				request, r := milestoneFixture("rollback", closed)
				phase, code := "refused", ""
				switch fault {
				case "phase":
					r.phase, code = "rollback_started", "rollback_phase"
					if closed {
						phase = r.phase
					}
				case "pair":
					r.reject, code = true, "rollback_pair"
					if closed {
						code = "closed_rollback_pair"
					}
				case "tree":
					v := r.trees[port.App]
					v.build.Version = "changed"
					r.trees[port.App] = v
					code = "tree"
				case "pair-change":
					code = "readiness_pair_changed"
					if closed {
						code = "closed_rollback_pair_changed"
					}
					r.after = func(s string) {
						if strings.HasPrefix(s, "verify:2:") {
							v := r.trees[port.Previous]
							v.identity.Inode = "303"
							r.trees[port.Previous] = v
						}
					}
				case "journal-change":
					code = "readiness_journal_changed"
					if closed {
						code = "closed_rollback_journal_changed"
					}
					r.after = func(s string) {
						if strings.HasPrefix(s, "verify:2:") {
							r.revision++
						}
					}
				}
				ready, err := InspectInstallation(context.Background(), request, r)
				failure, ok := err.(*Failure)
				if ready != nil || !ok || failure.Code != code || failure.Phase != phase || failure.Internal || failure.Uncertain {
					t.Fatalf("want %s/%s refusal, got %#v ready=%v", phase, code, err, ready)
				}
				requireNoEffect(t, r)
			})
		}
	}
}

type milestoneLaunch struct {
	runtime *milestoneRuntime
	err     error
	self    port.HelperSelfIdentity
	path    string
}

func newMilestoneLaunch(request port.HelperRequest, r *milestoneRuntime) *milestoneLaunch {
	return &milestoneLaunch{runtime: r, self: port.HelperSelfIdentity{PID: 4321, ProcessStart: "symbolic helper birth"}, path: request.Home + "/Library/Application Support/Farol Next Preview/installed-updates/" + request.OperationID + "/launch-Farol.app"}
}
func (l *milestoneLaunch) CapturePrivateTarget(context.Context) (string, error) {
	err := l.runtime.call("capture", func() error { return nil })
	return l.path, err
}
func (l *milestoneLaunch) SelfIdentity(context.Context) (port.HelperSelfIdentity, error) {
	err := l.runtime.call("self", func() error { return nil })
	return l.self, err
}
func (l *milestoneLaunch) LaunchTarget(_ context.Context, self port.HelperSelfIdentity, path *string) error {
	return l.runtime.call("launch", func() error {
		if l.runtime.phase != "launch_requested" || self != l.self {
			return errors.New("launch before durable correlation")
		}
		shared := l.runtime.request.InstallLocation != nil && *l.runtime.request.InstallLocation == "shared"
		if shared && (path == nil || *path != l.path) || !shared && path != nil {
			return errors.New("capture correlation changed")
		}
		return l.err
	})
}

func TestHelperMilestoneApplyThroughDurableLaunch(t *testing.T) {
	for _, location := range []string{"legacy", "shared"} {
		t.Run(location, func(t *testing.T) {
			request, r := milestoneFixture("apply", true)
			request.InstallLocation = &location
			request.Relaunch = true
			r.request = captureRequest(request)
			milestone, err := testMilestone(context.Background(), request)
			if err != nil {
				t.Fatal(err)
			}
			ready, err := milestone.Inspect(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			requireNoEffect(t, r)
			launch := newMilestoneLaunch(request, r)
			result, err := milestone.Execute(context.Background(), r, ready, launch)
			if err != nil || result == nil || *result != (Result{Phase: "completed"}) {
				t.Fatal(result, err)
			}
			for _, pair := range [][2]string{{"prepare", "exchange:0:1"}, {"exchange:0:1", "rename:1:2"}, {"write:new_installed", "write:verified"}, {"write:verified", "write:launch_requested"}, {"write:launch_requested", "self"}, {"self", "launch"}, {"launch", "write:completed"}} {
				if indexTrace(t, r.trace, pair[0]) >= indexTrace(t, r.trace, pair[1]) {
					t.Fatal("policy order changed", r.trace)
				}
			}
			if location == "shared" && indexTrace(t, r.trace, "capture") >= indexTrace(t, r.trace, "write:launch_requested") {
				t.Fatal("private image capture followed launch intent")
			}
			before := append([]string(nil), r.trace...)
			copy := *milestone
			_, err = copy.Execute(context.Background(), r, ready, launch)
			requireExecutionCode(t, err, "execution_attempt_unknown", true)
			if !reflect.DeepEqual(before, r.trace) {
				t.Fatal("copy repeated native work")
			}
		})
	}
}

func TestHelperMilestoneKnownLaunchFailureDoesNotCompleteOrReplay(t *testing.T) {
	r, native := milestoneFixture("apply", true)
	r.Relaunch = true
	native.request = captureRequest(r)
	milestone, err := testMilestone(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	ready, err := milestone.Inspect(context.Background(), native)
	if err != nil {
		t.Fatal(err)
	}
	launch := newMilestoneLaunch(r, native)
	launch.err = &port.HelperRecoveryFailure{Code: "launch_failed", Phase: "refused", Cause: errors.New("original returned nonzero status")}
	result, err := milestone.Execute(context.Background(), native, ready, launch)
	if err != nil || result == nil || result.Phase != "launch_requested" || result.Code != "launch_failed" {
		t.Fatal(result, err)
	}
	if native.phase != "launch_requested" {
		t.Fatal("failed launch completed", native.trace)
	}
	for _, event := range native.trace {
		if event == "write:completed" {
			t.Fatal("failed launch completed")
		}
	}
	_, err = milestone.Execute(context.Background(), native, ready, launch)
	requireExecutionCode(t, err, "execution_attempt_unknown", true)
}

func TestHelperMilestoneCompensatesOnlyConfirmedNegative(t *testing.T) {
	for _, opaque := range []bool{false, true} {
		t.Run(fmt.Sprint(opaque), func(t *testing.T) {
			request, r := milestoneFixture("apply", true)
			request.Relaunch = true
			r.request = request
			m, _ := testMilestone(context.Background(), request)
			ready, err := m.Inspect(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			cause := errors.New("private tree query failed")
			r.before = func(name string) error {
				if name == "matches" {
					if opaque {
						return cause
					}
					r.match = false
				}
				return nil
			}
			result, err := m.Execute(context.Background(), r, ready, newMilestoneLaunch(request, r))
			if opaque {
				requireExecutionCode(t, err, "internal", true)
				if result != nil || !errors.Is(err, cause) || r.reject || r.phase != "new_installed" {
					t.Fatal("opaque verification failure authorized compensation")
				}
			} else if err != nil || result == nil || *result != (Result{Phase: "rolled_back", Code: "target_verification"}) || !r.reject {
				t.Fatal("confirmed negative was not durably compensated", result, err)
			}
			for _, s := range r.trace {
				if s == "launch" || s == "capture" {
					t.Fatal("failed target launched")
				}
			}
		})
	}
}

func TestHelperMilestoneRecoverRollbackAndHistoricalLaunch(t *testing.T) {
	for _, state := range []string{"prepared", "verified", "launch_requested", "completed", "rollback"} {
		t.Run(state, func(t *testing.T) {
			action := "recover"
			if state == "rollback" {
				action = "rollback"
			}
			request, r := milestoneFixture(action, false)
			request.Relaunch = true
			if state != "rollback" {
				r.phase = state
				if state != "prepared" {
					r.trees[port.Previous] = r.trees[port.App]
					r.trees[port.App] = r.trees[port.Staged]
					delete(r.trees, port.Staged)
				}
			}
			r.request = captureRequest(request)
			m, _ := testMilestone(context.Background(), request)
			ready, err := m.Inspect(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			result, err := m.Execute(context.Background(), r, ready, newMilestoneLaunch(request, r))
			want := map[string]string{"prepared": "cancelled", "verified": "completed", "launch_requested": "launch_requested", "completed": "completed", "rollback": "rolled_back"}[state]
			if err != nil || result == nil || result.Phase != want {
				t.Fatal(result, err)
			}
			launches := 0
			for _, s := range r.trace {
				if s == "launch" {
					launches++
				}
			}
			if (state == "verified" && launches != 1) || (state != "verified" && launches != 0) {
				t.Fatal("terminal or historical launch replayed", r.trace)
			}
		})
	}
}

func TestHelperMilestoneFailedOrLateLaunchNeverCompletesOrRetries(t *testing.T) {
	for _, kind := range []string{"opaque", "cancel", "identity", "capture"} {
		t.Run(kind, func(t *testing.T) {
			request, r := milestoneFixture("apply", true)
			request.Relaunch = true
			location := "shared"
			request.InstallLocation = &location
			r.request = captureRequest(request)
			m, _ := testMilestone(context.Background(), request)
			ready, err := m.Inspect(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			launch := newMilestoneLaunch(request, r)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cause := errors.New("private launcher failure")
			switch kind {
			case "opaque":
				launch.err = cause
			case "cancel":
				r.after = func(s string) {
					if s == "launch" {
						cancel()
					}
				}
			case "identity":
				launch.self = port.HelperSelfIdentity{}
			case "capture":
				launch.path = "/unverified-path"
			}
			result, err := m.Execute(ctx, r, ready, launch)
			var failure *Failure
			if result != nil || !errors.As(err, &failure) || !failure.Uncertain || r.phase == "completed" {
				t.Fatal("unknown launch became completed", result, err)
			}
			if kind == "opaque" && !errors.Is(err, cause) {
				t.Fatal("private cause lost")
			}
			if kind != "capture" && r.phase != "launch_requested" {
				t.Fatal("launch intent lost", r.phase)
			}
			before := append([]string(nil), r.trace...)
			_, err = m.Execute(context.Background(), r, ready, launch)
			requireExecutionCode(t, err, "execution_attempt_unknown", true)
			if !reflect.DeepEqual(before, r.trace) {
				t.Fatal("unknown launch retried")
			}
		})
	}
}

func TestHelperMilestoneOneAttemptAndRequestCapture(t *testing.T) {
	request, r := milestoneFixture("apply", true)
	m, _ := testMilestone(context.Background(), request)
	*request.InstallLocation = "changed"
	request.Predecessor.Kind = "changed"
	request.LeaseIdentity.Inode = "changed"
	ready, err := m.Inspect(context.Background(), r)
	if err != nil {
		t.Fatal(err)
	}
	if ready.request.Predecessor.Kind == "changed" || ready.request.LeaseIdentity.Inode == "changed" || *ready.request.InstallLocation == "changed" {
		t.Fatal("request aliases escaped capture")
	}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			copy := *m
			_, err := copy.Execute(context.Background(), r, ready, nil)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for err := range results {
		if err == nil {
			succeeded++
		} else {
			requireExecutionCode(t, err, "execution_attempt_unknown", true)
		}
	}
	if succeeded != 1 {
		t.Fatal("concurrent copies split attempt", succeeded)
	}
}

func TestHelperMilestoneCancellationAndMissingReadinessConsume(t *testing.T) {
	for _, kind := range []string{"cancel", "missing", "mismatched"} {
		t.Run(kind, func(t *testing.T) {
			request, r := milestoneFixture("apply", true)
			m, _ := testMilestone(context.Background(), request)
			ready, err := m.Inspect(context.Background(), r)
			if err != nil {
				t.Fatal(err)
			}
			r.trace = nil
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch kind {
			case "cancel":
				cancel()
			case "missing":
				ready = nil
			case "mismatched":
				ready.request.Target.BuildID = "changed"
			}
			_, err = m.Execute(ctx, r, ready, nil)
			if err == nil || len(r.trace) != 0 {
				t.Fatal("invalid invocation reached runtime", r.trace)
			}
			_, err = m.Execute(context.Background(), r, ready, nil)
			requireExecutionCode(t, err, "execution_attempt_unknown", true)
			if len(r.trace) != 0 {
				t.Fatal("invalid invocation was rearmed")
			}
		})
	}
}

func TestInstallationReadinessOpaqueReadKeepsCauses(t *testing.T) {
	request, r := milestoneFixture("apply", true)
	cause := errors.New("private journal observation failure")
	r.before = func(name string) error {
		if name == "observe-journal" {
			return errors.Join(cause, &port.HelperRecoveryFailure{Code: "journal_mismatch", Phase: "refused"})
		}
		return nil
	}
	ready, err := InspectInstallation(context.Background(), request, r)
	var failure *Failure
	if ready != nil || !errors.As(err, &failure) || !failure.Internal || !errors.Is(err, cause) {
		t.Fatal("opaque observation downgraded", err)
	}
	requireNoEffect(t, r)
}

// Boot-like adapter of the ORIGINAL recovery owner for pure composition tests.
type testRecoveryPolicies struct{}

func (testRecoveryPolicies) Observe(ctx context.Context, r port.HelperRequest, o port.HelperRecoveryObservation) (port.HelperRecoveryInspection, error) {
	return helperrecovery.ObserveCaptured(ctx, r, o)
}
func (testRecoveryPolicies) Bind(ctx context.Context, r port.HelperRequest, n port.HelperRecoveryRuntime) (port.HelperRecoveryReconciliation, error) {
	return helperrecovery.NewCaptured(ctx, r, n)
}
func testMilestone(ctx context.Context, r port.HelperRequest) (*Milestone, error) {
	return NewMilestone(ctx, r, testRecoveryPolicies{})
}

// Missing composition is a closed refusal, not a substitute policy or panic.
type missingRecoveryPolicies struct{}

func (missingRecoveryPolicies) Observe(context.Context, port.HelperRequest, port.HelperRecoveryObservation) (port.HelperRecoveryInspection, error) {
	return nil, nil
}
func (missingRecoveryPolicies) Bind(context.Context, port.HelperRequest, port.HelperRecoveryRuntime) (port.HelperRecoveryReconciliation, error) {
	return nil, nil
}
func TestHelperMilestoneMissingRecoveryPoliciesRefuse(t *testing.T) {
	for _, returnedNil := range []bool{false, true} {
		t.Run(fmt.Sprint(returnedNil), func(t *testing.T) {
			request, native := milestoneFixture("recover", false)
			native.phase = "prepared"
			var policies []port.HelperRecoveryPolicies
			if returnedNil {
				policies = append(policies, missingRecoveryPolicies{})
			}
			milestone, err := NewMilestone(context.Background(), request, policies...)
			if err != nil {
				t.Fatal(err)
			}
			copy := *milestone
			result, err := milestone.Execute(context.Background(), native, nil, nil)
			requireExecutionCode(t, err, "recovery_policy_required", false)
			if result != nil {
				t.Fatal("missing policy returned a result")
			}
			requireNoEffect(t, native)
			_, err = copy.Execute(context.Background(), native, nil, nil)
			requireExecutionCode(t, err, "execution_attempt_unknown", true)
			request.Relaunch = true
			ready, err := InspectInstallation(context.Background(), request, native, policies...)
			requireExecutionCode(t, err, "recovery_policy_required", false)
			if ready != nil {
				t.Fatal("missing inspection policy returned readiness")
			}
			requireNoEffect(t, native)
		})
	}
}

func TestInstallationReadinessDoesNotRereadFailedJournal(t *testing.T) {
	for _, code := range []string{"journal_invalid", "recovery_attempt_unknown", "opaque"} {
		t.Run(code, func(t *testing.T) {
			request, native := milestoneFixture("apply", true)
			cause := errors.New("private malformed journal bytes")
			calls := 0
			native.before = func(name string) error {
				if name != "observe-journal" {
					return nil
				}
				calls++
				if calls > 1 {
					return nil // An unsafe fallback could misread this as absence.
				}
				if code == "opaque" {
					return cause
				}
				return &port.HelperRecoveryFailure{Code: code, Phase: "refused", Uncertain: code == "recovery_attempt_unknown", Cause: cause}
			}
			ready, err := InspectInstallation(context.Background(), request, native)
			if ready != nil || err == nil || calls != 1 || !errors.Is(err, cause) || strings.Contains(err.Error(), cause.Error()) {
				t.Fatal("failed read became absence or leaked its cause", ready, err, calls)
			}
			requireNoEffect(t, native)
		})
	}
}

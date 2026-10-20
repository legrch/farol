package execution

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
)

// These witnesses run the application Milestone (Inspect, then Execute) over the
// real installation runtime through WithAdmittedInstallation's route seam, with
// real journal and rejection repositories on disposable trees. As in the
// lifecycle witnesses, route, lease, slot, predecessor process and admission
// stay symbolic: they establish composition of the existing owners, not custody,
// a selected helper, relaunch or installed use. The relaunch port is always nil.

func milestoneRoutes(ctx context.Context) error { return ctx.Err() }

// closed marks the request as a confirmed-closed predecessor request, which
// binds rollback to the exact pre-ACK journal revision and entry pair.
func (f *lifecycleFixture) milestoneRequest(action string, closed bool) port.HelperRequest {
	request := f.config.Request
	request.Action = action
	if closed {
		location := "legacy"
		request.InstallLocation = &location
		request.Predecessor = &port.HelperPredecessor{
			Kind: "confirmed_closed", StartedAt: "2026-10-16T12:00:00Z", LastQuitSHA256: strings.Repeat("6", 64),
			StateIdentity: port.HelperIdentity{Device: "11", Inode: "12"},
		}
		request.LeaseIdentity = &port.HelperIdentity{Device: "11", Inode: "13"}
	}
	f.config.Request, f.owner.request = request, request
	return request
}

// inspect observes through the sealed read-only projection, in its own scope.
func (f *lifecycleFixture) inspect(t *testing.T, m *executionapp.Milestone) (*executionapp.Readiness, error) {
	t.Helper()
	var ready *executionapp.Readiness
	err := withObservation(context.Background(), ObservationConfig{
		Request: f.config.Request, Files: f.config.Files, Journal: f.repo, Until: f.config.Until,
		Reverify: f.config.Reverify, Unknown: f.config.Unknown, RetainUnknown: f.config.RetainUnknown,
	}, milestoneRoutes, func(observation port.HelperInstallationObservation) error {
		var e error
		ready, e = m.Inspect(context.Background(), observation)
		return e
	})
	return ready, err
}

// execute runs Milestone.Execute in a separate admitted scope. The callback
// receives the value as the application's AdmittedRuntime without any assertion.
func (f *lifecycleFixture) execute(t *testing.T, m *executionapp.Milestone, ready *executionapp.Readiness) (*executionapp.Result, error) {
	t.Helper()
	var result *executionapp.Result
	err := withAdmittedInstallation(context.Background(), f.config, milestoneRoutes, func(native AdmittedInstallation) error {
		var runtime executionapp.AdmittedRuntime = native
		var e error
		result, e = m.Execute(context.Background(), runtime, ready, nil)
		return e
	})
	return result, err
}

func (f *lifecycleFixture) milestone(t *testing.T, action string, closed bool) (*executionapp.Milestone, *executionapp.Readiness) {
	t.Helper()
	m, err := executionapp.NewMilestone(context.Background(), f.milestoneRequest(action, closed))
	must(t, err)
	ready, err := f.inspect(t, m)
	must(t, err)
	if ready == nil {
		t.Fatal("inspection produced no readiness")
	}
	return m, ready
}

func TestMilestoneCompositionApplyThenClosedRollback(t *testing.T) {
	f := newLifecycleFixture(t)
	before := compositionSnapshot(t, f.root)
	m, ready := f.milestone(t, "apply", true)
	// Inspection is observation only: no journal, no entry, no retention.
	f.unchanged(t, before)
	if f.owner.retained() != nil {
		t.Fatal("inspection retained uncertainty")
	}
	result, err := f.execute(t, m, ready)
	must(t, err)
	if result == nil || *result != (executionapp.Result{Phase: "verified"}) {
		t.Fatal("apply did not settle verified", result)
	}
	f.physical(t, f.repo, "verified")
	lifecycleRequireTree(t, filepath.Join(f.config.Files.Applications.Name(), "Farol.app"), f.target)
	lifecycleRequireTree(t, filepath.Join(f.path, "previous.app"), f.source)

	// One Milestone is one attempt, including through a copy and a fresh scope.
	repeated, err := f.execute(t, m, ready)
	var consumed *executionapp.Failure
	if repeated != nil || !errors.As(err, &consumed) || consumed.Code != "execution_attempt_unknown" || !consumed.Uncertain {
		t.Fatal("a Milestone executed twice", repeated, err)
	}

	// Closed rollback binds to its own fresh pre-ACK observation.
	m, ready = f.milestone(t, "rollback", true)
	result, err = f.execute(t, m, ready)
	must(t, err)
	if result == nil || *result != (executionapp.Result{Phase: "rolled_back"}) {
		t.Fatal("closed rollback did not settle rolled_back", result)
	}
	f.physical(t, f.repo, "rolled_back")
	lifecycleRequireTree(t, filepath.Join(f.config.Files.Applications.Name(), "Farol.app"), f.source)
	lifecycleRequireTree(t, filepath.Join(f.path, "failed.app"), f.target)
}

func TestMilestoneCompositionTargetVerificationCompensates(t *testing.T) {
	f := newLifecycleFixture(t)
	changed := f.corruptInstalledTarget(t)
	m, ready := f.milestone(t, "apply", true)
	result, err := f.execute(t, m, ready)
	must(t, err)
	if !*changed || result == nil || *result != (executionapp.Result{Phase: "rolled_back", Code: "target_verification"}) {
		t.Fatal("negative tree observation did not compensate", result)
	}
	f.physical(t, f.repo, "rolled_back")
	f.rejected(t)
}

// Execute without matching readiness refuses before any effect, and a stale
// readiness (the world changed after inspection) is refused by Recheck.
func TestMilestoneCompositionRefusesWithoutFreshReadiness(t *testing.T) {
	t.Run("missing", func(t *testing.T) {
		f := newLifecycleFixture(t)
		m, _ := f.milestone(t, "apply", true)
		before := compositionSnapshot(t, f.root)
		result, err := f.execute(t, m, nil)
		var failure *executionapp.Failure
		if result != nil || !errors.As(err, &failure) || failure.Code != "readiness_required" {
			t.Fatal("execution accepted missing readiness", result, err)
		}
		f.unchanged(t, before)
	})
	t.Run("stale", func(t *testing.T) {
		f := newLifecycleFixture(t)
		m, ready := f.milestone(t, "apply", true)
		// A journal appears after inspection: operation_exists on Recheck.
		scope := f.execute
		must(t, installScope(f.compositionFixture, context.Background(), func(native port.HelperInstallationRuntime) error { return native.Prepare(context.Background()) }))
		result, err := scope(t, m, ready)
		var failure *executionapp.Failure
		if result != nil || !errors.As(err, &failure) || failure.Code != "operation_exists" {
			t.Fatal("stale readiness reached an effect", result, err)
		}
		f.physical(t, f.repo, "prepared")
	})
}

// The exported entry uses the live helperroutes borrow, which raw test
// descriptors cannot satisfy; it also refuses a nil callback or rejection owner.
func TestWithAdmittedInstallationRefusesWithoutRealRoutesOrOwners(t *testing.T) {
	f := newLifecycleFixture(t)
	entered := false
	if err := WithAdmittedInstallation(context.Background(), f.config, func(AdmittedInstallation) error { entered = true; return nil }); err == nil || entered {
		t.Fatal("raw test descriptors supplied real route custody")
	}
	if err := WithAdmittedInstallation(context.Background(), f.config, nil); err == nil {
		t.Fatal("nil callback accepted")
	}
	config := f.config
	config.Rejection = nil
	if err := withAdmittedInstallation(context.Background(), config, milestoneRoutes, func(AdmittedInstallation) error { entered = true; return nil }); err == nil || entered {
		t.Fatal("missing rejection owner accepted")
	}
}

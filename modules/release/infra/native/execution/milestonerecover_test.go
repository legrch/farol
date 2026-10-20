package execution

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
	executionapp "github.com/legrch/farol/modules/release/app/services/execution"
	"github.com/legrch/farol/modules/release/app/services/helperrecovery"
)

// These witnesses run a live recover WITH relaunch end to end over the real
// installation runtime, the real journal and the ORIGINAL recovery owner, in the
// owner's slot (legacy) mode, with the same symbolic OS launch seam as
// milestonerelaunch_test.go. Intermediate journal states are constructed through
// the runtime's own Prepare/Exchange/WritePhase; none is an actual helper crash.
// Only a recovery that settled verified launches: cancelled and rolled_back
// never measure, build or open (Python update_helper.py:1388).

// recoverPolicies is the boot adapter of the original recovery owner, as
// boot/releasehelperrecovery.go composes it.
type recoverPolicies struct{}

func (recoverPolicies) Observe(ctx context.Context, r port.HelperRequest, o port.HelperRecoveryObservation) (port.HelperRecoveryInspection, error) {
	return helperrecovery.ObserveCaptured(ctx, r, o)
}
func (recoverPolicies) Bind(ctx context.Context, r port.HelperRequest, n port.HelperRecoveryRuntime) (port.HelperRecoveryReconciliation, error) {
	return helperrecovery.NewCaptured(ctx, r, n)
}

// stage constructs a journal/tree state through the runtime's own effects.
func (f *relaunchLifecycle) stage(t *testing.T, fn func(port.HelperInstallationRuntime) error) {
	t.Helper()
	must(t, installScope(f.compositionFixture, context.Background(), fn))
}

func (f *relaunchLifecycle) recoverMilestone(t *testing.T, policies ...port.HelperRecoveryPolicies) (*executionapp.Milestone, *executionapp.Readiness, error) {
	t.Helper()
	m, err := executionapp.NewMilestone(context.Background(), f.relaunchRequest("recover", true), policies...)
	must(t, err)
	ready, err := f.inspect(t, m)
	return m, ready, err
}

func (f *relaunchLifecycle) requireNoLaunch(t *testing.T) {
	t.Helper()
	if f.measures != 0 || f.builds != 0 || f.fake.opens != 0 {
		t.Fatal("a recovery that did not settle verified launched", f.measures, f.builds, f.fake.opens)
	}
}

// A prepared journal whose exchange already happened (app=target, staged=source)
// reconciles to verified; the launch then runs exactly as after a verified apply,
// with the hint naming the recover action and phase "completed".
func TestMilestoneRecoverRelaunchCompletesAfterReconcilingToVerified(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.stage(t, func(native port.HelperInstallationRuntime) error {
		if err := native.Prepare(context.Background()); err != nil {
			return err
		}
		return native.Exchange(context.Background(), port.App, port.Staged, f.sourceID, f.targetID)
	})
	f.physical(t, f.repo, "prepared")
	m, ready, err := f.recoverMilestone(t, recoverPolicies{})
	must(t, err)
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "completed"}) {
		t.Fatal("a recovery that reconciled to verified did not complete", result)
	}
	f.physical(t, f.repo, "completed")
	if want := []string{"prepared", "verified", "launch_requested", "completed"}; !containsInOrder(f.phases, want[1:]) {
		t.Fatalf("journal order %v does not contain %v", f.phases, want[1:])
	}
	if f.measures != 1 || f.builds != 1 || f.fake.opens != 1 {
		t.Fatal("measure, arguments and open must each run once", f.measures, f.builds, f.fake.opens)
	}
	for step, phases := range map[string][]string{"measure": f.atMeasure, "arguments": f.atBuild, "open": f.fake.phases} {
		if len(phases) != 1 || phases[0] != "launch_requested" {
			t.Fatalf("%s did not run at launch_requested: %v", step, phases)
		}
	}
	arguments := f.fake.arguments[0]
	if len(arguments) != 5 || arguments[0] != "/usr/bin/open" || arguments[2] != f.app {
		t.Fatalf("argv %q (image %s)", arguments, f.app)
	}
	hint := relaunchHintOf(t, arguments[4])
	if hint.OperationID != f.config.Request.OperationID || hint.Action != "recover" || hint.Phase != "completed" ||
		hint.BuildID != f.config.Request.Target.BuildID || hint.Helper.ProcessStart != relaunchSelfStart {
		t.Fatalf("hint %+v", hint)
	}
	lifecycleRequireTree(t, f.app, f.target)
	lifecycleRequireTree(t, filepath.Join(f.path, "previous.app"), f.source)
	if f.owner.retained() != nil {
		t.Fatal("a completed recovery retained uncertainty", f.owner.retained())
	}
}

// A journal that already settled verified (the apply wrote it, then the helper
// stopped before the launch) is recovered by launching: reconcile observes the
// pair and keeps the phase, and verified is the launch condition.
func TestMilestoneRecoverRelaunchLaunchesAnAlreadyVerifiedJournal(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", false)
	result, err := f.run(t, m, ready)
	must(t, err)
	if result == nil || *result != (executionapp.Result{Phase: "verified"}) {
		t.Fatal("setup apply", result)
	}
	m, ready, err = f.recoverMilestone(t, recoverPolicies{})
	must(t, err)
	result, err = f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "completed"}) {
		t.Fatal("a verified journal was not launched to completion", result)
	}
	f.physical(t, f.repo, "completed")
	if f.measures != 1 || f.builds != 1 || f.fake.opens != 1 {
		t.Fatal("exactly one launch expected", f.measures, f.builds, f.fake.opens)
	}
}

// A prepared journal whose exchange never happened (app=source, staged=target) is
// cancelled by the recovery. Cancelled is not verified: nothing is launched.
func TestMilestoneRecoverRelaunchCancelledNeverLaunches(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.stage(t, func(native port.HelperInstallationRuntime) error { return native.Prepare(context.Background()) })
	f.physical(t, f.repo, "prepared")
	m, ready, err := f.recoverMilestone(t, recoverPolicies{})
	must(t, err)
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "cancelled"}) {
		t.Fatal("the unexchanged pair was not cancelled", result)
	}
	f.physical(t, f.repo, "cancelled")
	f.requireNoLaunch(t)
	lifecycleRequireTree(t, f.app, f.source)
	lifecycleRequireTree(t, filepath.Join(f.path, "staged.app"), f.target)
	if f.owner.retained() != nil {
		t.Fatal("a cancelled recovery retained uncertainty", f.owner.retained())
	}
}

// A rollback that stopped at rollback_started is repaired to rolled_back (the
// exchange is finished and the target is kept as failed.app). Rolled back is not
// verified: nothing is launched.
func TestMilestoneRecoverRelaunchRollbackRepairNeverLaunches(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	m, ready := f.prepare(t, "apply", false)
	result, err := f.run(t, m, ready)
	must(t, err)
	if result == nil || *result != (executionapp.Result{Phase: "verified"}) {
		t.Fatal("setup apply", result)
	}
	must(t, withAdmittedInstallation(context.Background(), f.config, milestoneRoutes, func(native AdmittedInstallation) error {
		// The runtime writes only against a revision it has read in this scope.
		if _, err := native.ReadPhase(context.Background()); err != nil {
			return err
		}
		return native.WritePhase(context.Background(), "rollback_started")
	}))
	f.physical(t, f.repo, "rollback_started")
	m, ready, err = f.recoverMilestone(t, recoverPolicies{})
	must(t, err)
	result, err = f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "rolled_back"}) {
		t.Fatal("the interrupted rollback was not repaired", result)
	}
	f.physical(t, f.repo, "rolled_back")
	f.requireNoLaunch(t)
	lifecycleRequireTree(t, f.app, f.source)
	lifecycleRequireTree(t, filepath.Join(f.path, "failed.app"), f.target)
}

// A recovery that settled verified but whose clean launch failed reports the
// original launch_failed; the journal keeps launch_requested.
func TestMilestoneRecoverRelaunchCleanLaunchFailure(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.fake.err = fail("launch_failed", false, false, nil)
	f.stage(t, func(native port.HelperInstallationRuntime) error {
		if err := native.Prepare(context.Background()); err != nil {
			return err
		}
		return native.Exchange(context.Background(), port.App, port.Staged, f.sourceID, f.targetID)
	})
	m, ready, err := f.recoverMilestone(t, recoverPolicies{})
	must(t, err)
	result, err := f.run(t, m, ready)
	if err != nil {
		t.Fatal(describe(err))
	}
	if result == nil || *result != (executionapp.Result{Phase: "launch_requested", Code: "launch_failed"}) {
		t.Fatal("clean launch failure was not reported", result)
	}
	f.physical(t, f.repo, "launch_requested")
	if f.fake.opens != 1 || f.owner.retained() != nil {
		t.Fatal("clean failure retried or retained uncertainty", f.fake.opens, f.owner.retained())
	}
}

// The recovery owner's own single attempt: a second Reconcile through the same
// bound service is the unknown, uncertain recovery_attempt_unknown and changes
// nothing.
func TestMilestoneRecoverSecondReconcileIsAttemptUnknown(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.stage(t, func(native port.HelperInstallationRuntime) error { return native.Prepare(context.Background()) })
	request := f.relaunchRequest("recover", true)
	err := withAdmittedInstallation(context.Background(), f.config, milestoneRoutes, func(native AdmittedInstallation) error {
		service, err := recoverPolicies{}.Bind(context.Background(), request, native)
		if err != nil {
			return err
		}
		phase, err := service.Reconcile(context.Background())
		if err != nil || phase != "cancelled" {
			t.Fatal("first reconcile", phase, describe(err))
		}
		again, err := service.Reconcile(context.Background())
		var failure *helperrecovery.Failure
		if again != "" || !errors.As(err, &failure) || failure.Code != "recovery_attempt_unknown" || !failure.Uncertain {
			t.Fatal("a second reconcile was not an unknown attempt", again, err)
		}
		return nil
	})
	must(t, err)
	f.physical(t, f.repo, "cancelled")
}

// The pre-ACK Inspect is the original read-only pair check: a prepared journal
// whose entries match no recognised pair is a clean recovery_pair refusal at
// readiness, before anything could be told to quit and with nothing changed.
func TestMilestoneRecoverRelaunchUnrecognisedPairRefusesAtReadiness(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.stage(t, func(native port.HelperInstallationRuntime) error { return native.Prepare(context.Background()) })
	must(t, os.RemoveAll(filepath.Join(f.path, "staged.app")))
	before := compositionSnapshot(t, f.root)
	_, ready, err := f.recoverMilestone(t, recoverPolicies{})
	var failure *executionapp.Failure
	var recovery *helperrecovery.Failure
	if ready != nil || err == nil || !errors.As(err, &failure) && !errors.As(err, &recovery) {
		t.Fatal("an unrecognised pair was inspected as ready", ready, describe(err))
	}
	if !(recovery != nil && recovery.Code == "recovery_pair" && !recovery.Uncertain) && !(failure != nil && failure.Code == "recovery_pair" && !failure.Uncertain && !failure.Internal) {
		t.Fatal("not the clean recovery_pair refusal", describe(err))
	}
	f.unchanged(t, before)
	f.requireNoLaunch(t)
	f.physical(t, f.repo, "prepared")
}

// Without the recovery policy the Milestone cannot even inspect a relaunching
// recovery: no journal, entry or launch effect follows.
func TestMilestoneRecoverRelaunchWithoutAPolicyRefusesAtReadiness(t *testing.T) {
	f := newFakeRelaunchLifecycle(t)
	f.stage(t, func(native port.HelperInstallationRuntime) error { return native.Prepare(context.Background()) })
	before := compositionSnapshot(t, f.root)
	ready, err := func() (*executionapp.Readiness, error) {
		_, ready, err := f.recoverMilestone(t)
		return ready, err
	}()
	var failure *executionapp.Failure
	if ready != nil || !errors.As(err, &failure) || failure.Code != "recovery_policy_required" {
		t.Fatal("a policy-free recovery was inspected", ready, describe(err))
	}
	f.unchanged(t, before)
	f.requireNoLaunch(t)
	if _, err := os.Lstat(filepath.Join(f.path, "failed.app")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a refused recovery wrote an entry", err)
	}
}

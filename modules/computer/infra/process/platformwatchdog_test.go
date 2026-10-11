package process

import (
	"context"
	"strings"
	"sync"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
)

// Full service sequencing with fake platform facts, measurement and helper IPC.
// This exercises the production join but proves no native platform or release.
func newPlatformWatchdogFixture(t *testing.T) (*watchdogFixture, platformFixture) {
	t.Helper()
	f := newWatchdogFixture(t)
	pf := platformFixtureCPU(t)
	pf.clock.value = f.clock.Now()
	pf.policy.Snapshot.Participant.Grant.Identity = f.lease.binding.Identity
	pf.policy.Snapshot.Participant.Grant.ExpiresAt = f.lease.snapshot.Participant.Grant.ExpiresAt
	pf.policy.Snapshot.Approval.ExpiresAt = f.lease.snapshot.Approval.ExpiresAt
	f.lease.snapshot = pf.policy.Snapshot
	template := copyCommand(pf.original)
	template.Binding, template.Confinement = nil, nil
	template.Args, template.Input = nil, nil
	preparer, err := NewRootScopedSupervisedPreparer("cli", template, pf.policy, pf.strategy(t), pf.watchdog, context.Background(), f.clock)
	if err != nil {
		t.Fatal(err)
	}
	preparer.boundary.host = f.host
	preparer.boundary.measure = f.preparer.boundary.measure
	f.preparer = preparer
	service, err := processsvc.NewForInvocation("operation", f.lease, preparer, f.reservation, &sync.Mutex{}, f.clock)
	if err != nil {
		t.Fatal(err)
	}
	f.route, err = processcontract.New(service)
	if err != nil {
		t.Fatal(err)
	}
	return f, pf
}

func TestRootScopedPlatformWatchdogUsesOriginalReservationAndOneRelease(t *testing.T) {
	f, _ := newPlatformWatchdogFixture(t)
	f.prepare(t)
	if f.reservation.calls != 0 || f.host.calls.Load() != 0 || f.measurements.Load() != 0 {
		t.Fatal("selection caused execution effects")
	}
	selected := f.preparer.boundary.platform
	if selected == nil || selected.frozen.deadline.set {
		t.Fatal("deadline bound before original reservation")
	}
	start := f.start(t)
	prepare, release := <-f.host.frames, <-f.host.frames
	if f.reservation.calls != 1 || f.host.starts.Load() != 1 || f.measurements.Load() != 1 ||
		prepare["executable"] != seatbeltExecutable || prepare["deadlineAt"] != float64(f.lease.deadline.UnixMilli()) || release["type"] != "start" ||
		!selected.frozen.deadline.value.Equal(f.lease.deadline) {
		t.Fatal("reservation/wrapper/deadline/release mismatch")
	}
	f.emit(t, map[string]any{"type": "stdout", "id": prepare["id"], "data": "T0s="})
	f.emit(t, map[string]any{"type": "close", "id": prepare["id"], "code": 0, "signal": nil})
	f.settle(t)
	result, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: start.Handle})
	if err != nil || result.State != processcontract.Exited || result.StdoutBase64 != "T0s=" || !result.RootWaited || !result.OutputDrained ||
		result.DescendantCleanup != processcontract.CleanupUnverified {
		t.Fatal(result, err)
	}
	again, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err != nil || again == nil || again.Handle != start.Handle || f.host.starts.Load() != 1 || f.reservation.calls != 1 {
		t.Fatal("original result was not retained without another dispatch", again, err)
	}
}

func TestRootScopedPlatformWatchdogRejectsDriftBeforeHelperAndRelease(t *testing.T) {
	for _, stage := range []string{"before-helper", "after-prepared"} {
		t.Run(stage, func(t *testing.T) {
			f, pf := newPlatformWatchdogFixture(t)
			f.prepare(t)
			drift := func() {
				value := pf.facts.files[pf.descriptor.Backend.Path]
				value.sha256 = strings.Repeat("9", 64)
				pf.facts.files[pf.descriptor.Backend.Path] = value
			}
			if stage == "before-helper" {
				drift()
			} else {
				f.host.beforePrepared = drift
			}
			_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.starts.Load() != 0 {
				t.Fatal("unqualified command released")
			}
			expectedHelpers := int32(0)
			if stage == "after-prepared" {
				expectedHelpers = 1
				f.settle(t)
			}
			if f.host.calls.Load() != expectedHelpers {
				t.Fatal("unexpected helper lifecycle")
			}
			_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
			if err == nil || f.host.calls.Load() != expectedHelpers || f.reservation.calls != 1 {
				t.Fatal("refused operation replayed")
			}
		})
	}
}

func TestRootScopedPlatformWatchdogSealsSupportAndCannotUsePendingMarker(t *testing.T) {
	f, pf := newPlatformWatchdogFixture(t)
	f.prepare(t)
	first := f.preparer.selected.Seal()
	if f.preparer.boundary.policy.qualification.Qualify(context.Background(), f.preparer.selected.command) == nil {
		t.Fatal("selection marker accepted a direct execution")
	}
	pf.descriptor.QualificationSHA256 = strings.Repeat("7", 64)
	f.preparer.boundary.strategy = pf.strategy(t)
	// A changed support selection cannot reuse the already selected reservation.
	invocation := f.preparer.selected.Invocation()
	if _, err := f.preparer.Prepare(context.Background(), invocation); err == nil {
		t.Fatal("changed support reused selected intent")
	}
	if f.preparer.selected.Seal() != first || f.host.calls.Load() != 0 || f.reservation.calls != 0 {
		t.Fatal("selection was replaced")
	}
}

func TestRootScopedPlatformWatchdogPreservesUnknownRelease(t *testing.T) {
	f, _ := newPlatformWatchdogFixture(t)
	f.host.reply = "lost"
	f.prepare(t)
	_, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || f.host.starts.Load() != 1 || f.preparer.RetainedHandle() == "" {
		t.Fatal("missing release response lost original attempt")
	}
	f.settle(t)
	_, err = f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
	if err == nil || f.host.starts.Load() != 1 || f.host.calls.Load() != 1 || f.reservation.calls != 1 {
		t.Fatal("unknown operation was dispatched again")
	}
}

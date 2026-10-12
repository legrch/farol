package process

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU doubles only: the existing in-memory IPC peer and exact helper Wait.
// These tests do not execute a native process or qualify descendant cleanup.
func newSupervisorWatchdogFixture(t *testing.T, rootScoped bool) *watchdogFixture {
	t.Helper()
	f := newWatchdogFixture(t)
	if rootScoped {
		selection := f.preparer.boundary.policy.selection
		participant, approval := selection.Snapshot.Participant.Clone(), selection.Snapshot.Approval.Clone()
		selection.Snapshot.Participant, selection.Snapshot.Approval = &participant, &approval
		selection.FilePolicy, selection.Git = authority.RootScopedFiles, RootScopedGit
		selection.Snapshot.Participant.Grant.FilePolicy = authority.RootScopedFiles
		selection.Snapshot.Approval.FilePolicy = authority.RootScopedFiles
		policy, err := NewSeatbelt(selection, f.evidence)
		if err != nil {
			t.Fatal(err)
		}
		f.preparer.base.template.Environment = policy.Environment(f.preparer.base.template.Write)
		f.preparer.base.qualification = policy
		f.preparer.boundary.policy = policy
		f.lease.snapshot = selection.Snapshot
	}
	f.host.holdWait = true
	f.prepare(t)
	return f
}

func supervisorWatchdogEvent(t *testing.T, f *watchdogFixture, kind string) {
	t.Helper()
	c := f.child().process.(*watchdogChild)
	// Feed the real decoder synchronously so intermediate reads need no polling
	// or timing assumptions. The transport receiver still owns its EOF/fence.
	event := map[string]any{"type": kind, "id": c.id}
	switch kind {
	case "stdout":
		event["data"] = "AP8=" // Synthetic binary output: NUL, 0xff.
	case "exit", "close":
		event["code"], event["signal"] = 7, nil
	}
	raw, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.event(raw); err != nil {
		t.Fatal(err)
	}
}

func finishSupervisorWatchdog(t *testing.T, f *watchdogFixture, helperErr error) {
	t.Helper()
	if err := f.host.peer.Close(); err != nil {
		t.Fatal(err)
	}
	f.host.process.ended <- helperErr
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.child().WaitForCompletion(ctx); err != nil {
		t.Fatal("CPU helper did not settle", err)
	}
	if f.host.process.waits.Load() != 1 || f.host.calls.Load() != 1 || f.host.starts.Load() != 1 || f.reservation.calls != 1 {
		t.Fatal("original helper ownership or dispatch count changed")
	}
}

func readSupervisorWatchdog(t *testing.T, f *watchdogFixture, handle string) *processcontract.ReadResponse {
	t.Helper()
	out, err := f.route.Read(context.Background(), processcontract.ReadRequest{Handle: handle})
	if err != nil || out == nil {
		t.Fatal(out, err)
	}
	return out
}

func requireSupervisorRootFacts(t *testing.T, out *processcontract.ReadResponse, drained bool) {
	t.Helper()
	if out.RootState != processcontract.RootExited || !out.RootWaited || out.ExitCode == nil || *out.ExitCode != 7 ||
		out.ExitSignal != 0 || out.OutputDrained != drained || out.StdoutBase64 != "AP8=" ||
		out.GroupCleanup != processcontract.CleanupUnverified || out.DescendantCleanup != processcontract.CleanupUnverified {
		t.Fatalf("root/output facts lost or cleanup promoted: %+v", out)
	}
}

func TestWatchdogSupervisorKnownExitRequiresRootScopedSelectionAndHelperWait(t *testing.T) {
	for _, rootScoped := range []bool{true, false} {
		name := "legacy"
		if rootScoped {
			name = "approved-roots-v1"
		}
		t.Run(name, func(t *testing.T) {
			f := newSupervisorWatchdogFixture(t, rootScoped)
			start := f.start(t)
			pending := processcontract.SupervisorState("")
			pendingState := processcontract.Unknown
			if rootScoped {
				pending = processcontract.SupervisorRunning
				pendingState = processcontract.Running
			}
			initial := readSupervisorWatchdog(t, f, start.Handle)
			if initial.Supervisor != pending || initial.State != processcontract.Running {
				t.Fatal("supervisor selected outside approved roots or start changed", initial)
			}
			supervisorWatchdogEvent(t, f, "stdout")
			for _, kind := range []string{"exit", "close"} {
				supervisorWatchdogEvent(t, f, kind)
				out := readSupervisorWatchdog(t, f, start.Handle)
				requireSupervisorRootFacts(t, out, kind == "close")
				if out.Supervisor != pending || out.State != pendingState {
					t.Fatal("root facts alone supplied helper completion", out)
				}
				select {
				case <-f.child().done:
					t.Fatal("root close completed the held helper")
				default:
				}
			}
			finishSupervisorWatchdog(t, f, nil)
			for range 2 {
				out := readSupervisorWatchdog(t, f, start.Handle)
				requireSupervisorRootFacts(t, out, true)
				state, supervisor := processcontract.Unknown, processcontract.SupervisorState("")
				if rootScoped {
					state, supervisor = processcontract.Exited, processcontract.SupervisorExited
				}
				if out.State != state || out.Supervisor != supervisor || out.CancelRequested || f.preparer.RetainedHandle() != start.Handle {
					t.Fatal("known supervisor result lost or legacy uncertainty cleared", out)
				}
			}
		})
	}
}

func TestWatchdogSupervisorHelperFailureAndIPCFenceRemainUnknown(t *testing.T) {
	for _, fence := range []bool{false, true} {
		name := "helper-wait-failure"
		if fence {
			name = "ipc-fence"
		}
		t.Run(name, func(t *testing.T) {
			f := newSupervisorWatchdogFixture(t, true)
			start := f.start(t)
			supervisorWatchdogEvent(t, f, "stdout")
			supervisorWatchdogEvent(t, f, "close")
			helperErr := errors.New("synthetic unknown helper Wait")
			if fence {
				c := f.child().process.(*watchdogChild)
				f.emit(t, map[string]any{"type": "stdout", "id": "crossed-resource", "data": "QQ=="})
				select {
				case <-c.failed:
				case <-time.After(time.Second):
					t.Fatal("crossed IPC event did not fence the original receiver")
				}
				out := readSupervisorWatchdog(t, f, start.Handle)
				requireSupervisorRootFacts(t, out, true)
				if out.Supervisor != processcontract.SupervisorUnknown || out.State != processcontract.Unknown {
					t.Fatal("IPC uncertainty hidden behind outstanding helper Wait", out)
				}
				helperErr = nil // A later successful helper Wait cannot clear this fence.
			}
			finishSupervisorWatchdog(t, f, helperErr)
			for range 2 {
				out := readSupervisorWatchdog(t, f, start.Handle)
				requireSupervisorRootFacts(t, out, !fence)
				if out.Supervisor != processcontract.SupervisorUnknown || out.State != processcontract.Unknown {
					t.Fatal("uncertain helper/IPC upgraded to Exited", out)
				}
			}
		})
	}
}

func TestWatchdogSupervisorCancellationCannotUpgradeKnownRoot(t *testing.T) {
	for _, reply := range []string{"", "refused-stop"} {
		name := "acknowledged-stop"
		if reply != "" {
			name = reply
		}
		t.Run(name, func(t *testing.T) {
			f := newSupervisorWatchdogFixture(t, true)
			f.host.reply = reply
			start := f.start(t)
			supervisorWatchdogEvent(t, f, "stdout")
			supervisorWatchdogEvent(t, f, "close")
			out := readSupervisorWatchdog(t, f, start.Handle)
			if out.State != processcontract.Running || out.Supervisor != processcontract.SupervisorRunning {
				t.Fatal("held helper prematurely settled", out)
			}
			cancel, err := f.route.Cancel(context.Background(), processcontract.CancelRequest{Handle: start.Handle})
			status := processcontract.CancelRequested
			if reply != "" {
				status = processcontract.CancelUnknown
			}
			if err != nil || cancel == nil || cancel.Status != status || f.host.stops.Load() != 1 {
				t.Fatal("stop evidence changed or control replayed", cancel, err)
			}
			finishSupervisorWatchdog(t, f, nil)
			out = readSupervisorWatchdog(t, f, start.Handle)
			requireSupervisorRootFacts(t, out, reply == "")
			if out.State != processcontract.Unknown || out.Supervisor != processcontract.SupervisorUnknown || !out.CancelRequested {
				t.Fatal("later helper success upgraded cancellation uncertainty", out)
			}
		})
	}
}

func TestChildSupervisorWaitRequiresCompleteUnfencedEvidence(t *testing.T) {
	for _, name := range []string{"known", "legacy", "prior-unknown", "helper-unverified", "root-unwaited", "undrained", "wait-error", "stop-attempted", "stop-unknown"} {
		t.Run(name, func(t *testing.T) {
			code := 7
			result := waited{result: exit{Code: &code, Waited: true, Drained: true, supervisorExited: true}}
			root := &ownedDouble{result: make(chan waited, 1)}
			c := &Child{handle: "cpu-child", process: root, supervisor: processsvc.SupervisorRunning,
				root: processsvc.RootRunning, group: processsvc.CleanupPending, descendants: processsvc.CleanupPending, done: make(chan struct{})}
			switch name {
			case "legacy":
				c.supervisor = ""
			case "prior-unknown":
				c.supervisor = processsvc.SupervisorUnknown
			case "helper-unverified":
				result.result.supervisorExited = false
			case "root-unwaited":
				result.result.Waited = false
			case "undrained":
				result.result.Drained = false
			case "wait-error":
				result.err = errors.New("synthetic unknown root Wait")
			case "stop-attempted", "stop-unknown":
				if name == "stop-unknown" {
					root.killError = errors.New("synthetic unknown stop")
				}
				receipt, err := c.Cancel(context.Background())
				status := processsvc.CancelRequested
				if name == "stop-unknown" {
					status = processsvc.CancelUnknown
				}
				if err != nil || receipt == nil || receipt.Status != status || root.killCount() != 1 {
					t.Fatal(receipt, err)
				}
			}
			root.result <- result
			c.wait()
			out, err := c.Read(context.Background(), processsvc.Window{})
			want := processsvc.SupervisorUnknown
			if name == "known" {
				want = processsvc.SupervisorExited
			} else if name == "legacy" {
				want = ""
			}
			if err != nil || out == nil || out.Supervisor != want ||
				out.GroupCleanup != processsvc.CleanupUnverified || out.DescendantCleanup != processsvc.CleanupUnverified {
				t.Fatal("incomplete evidence upgraded or cleanup forged", out, err)
			}
			if result.err == nil && result.result.Waited && (out.Root != processsvc.RootExited || !out.Waited || out.ExitCode == nil || *out.ExitCode != code || out.OutputDrained != result.result.Drained) {
				t.Fatal("known root evidence lost", out)
			}
			if (result.err != nil || !result.result.Waited) && (out.Root != processsvc.RootRunning || out.Waited || out.ExitCode != nil || out.OutputDrained) {
				t.Fatal("failed root Wait invented exit facts", out)
			}
		})
	}
}

package process

import (
	"context"
	"testing"
	"time"
)

// Controlled original-child observations, not native supervisor qualification.
func TestSupervisedResultPreservesRootFactsWithoutCleanupPromotion(t *testing.T) {
	f := newOwnedFixture(t, []byte("output"), []byte("diagnostic"), true)
	supervisor := SupervisorRunning
	f.child.mutate = func(_ int, o *Observation) {
		o.Supervisor = supervisor
		o.GroupCleanup, o.DescendantCleanup = CleanupUnverified, CleanupUnverified
	}
	read, err := f.s.Read(context.Background(), ReadRequest{Handle: f.child.handle})
	if err != nil || read.State != Running || f.s.uncertain || f.s.terminal || read.Observation.Root != RootExited || read.Observation.ExitCode == nil {
		t.Fatal("pending supervisor either claimed completion or poisoned original observation", read, err)
	}
	supervisor = SupervisorExited
	completeOwned(t, f)
	// Internal retention requires neither renewal nor current READ disclosure.
	f.clock.now = f.clock.now.Add(time.Minute)
	f.lease.closed = true
	result, err := f.s.CaptureOwnedTerminal(context.Background())
	if err != nil || ResultState(*result) != Exited || string(result.Observation.Stdout) != "output" ||
		result.Observation.Supervisor != SupervisorExited || result.Observation.GroupCleanup != CleanupUnverified ||
		result.Observation.DescendantCleanup != CleanupUnverified || !f.s.terminal {
		t.Fatal("known root result lost or cleanup promoted", result, err)
	}
	if f.child.waits.Load() != 1 || f.launch.calls != 1 || f.r.calls != 1 || f.child.cancels != 0 {
		t.Fatal("retention changed original execution")
	}
	if out, err := f.s.Read(context.Background(), ReadRequest{Handle: f.child.handle}); out != nil || err == nil {
		t.Fatal("retention renewed disclosure")
	}
}

func TestSupervisedResultDoesNotClearUnknownOrIncompleteOwnership(t *testing.T) {
	for _, name := range []string{"legacy", "running", "unknown", "undrained", "running-root", "pending-cleanup", "prior-unknown", "cancel-unknown"} {
		t.Run(name, func(t *testing.T) {
			f := newOwnedFixture(t, []byte("output"), nil, true)
			f.child.mutate = func(_ int, o *Observation) {
				o.Supervisor = SupervisorExited
				o.GroupCleanup, o.DescendantCleanup = CleanupUnverified, CleanupUnverified
				switch name {
				case "legacy":
					o.Supervisor = ""
				case "running":
					o.Supervisor = SupervisorRunning
				case "unknown":
					o.Supervisor = SupervisorUnknown
				case "undrained":
					o.OutputDrained = false
				case "running-root":
					o.Root, o.Waited, o.ExitCode = RootRunning, false, nil
				case "pending-cleanup":
					o.GroupCleanup = CleanupPending
				}
			}
			if name == "prior-unknown" {
				f.s.uncertain = true
				if err := f.s.WaitForCompletion(context.Background()); err == nil {
					t.Fatal("unknown operation regained completion ownership")
				}
			} else {
				completeOwned(t, f)
			}
			if name == "cancel-unknown" {
				f.s.cancelAttempted = true
				f.s.cancelFailure = fail("PROCESS_CANCEL_UNKNOWN", true)
			}
			refuseOwned(t, f.s)
			if f.s.terminal || f.launch.calls != 1 || f.r.calls != 1 {
				t.Fatal("unverified execution became settled or was reissued")
			}
		})
	}
}

func TestSupervisorObservationValidation(t *testing.T) {
	code := 0
	base := Observation{Handle: "child", Supervisor: SupervisorExited, Root: RootExited, Waited: true,
		ExitCode: &code, OutputDrained: true, GroupCleanup: CleanupUnverified, DescendantCleanup: CleanupUnverified}
	if !validObservation(&base, "child", Window{}) || completedState(base) != Exited {
		t.Fatal("valid supervised result rejected")
	}
	for _, change := range []func(*Observation){
		func(o *Observation) { o.Supervisor = "other" },
		func(o *Observation) { o.Root, o.Waited, o.ExitCode = RootRunning, false, nil },
		func(o *Observation) { o.OutputDrained = false },
		func(o *Observation) { o.Waited = false },
		func(o *Observation) { o.ExitSignal = 9 },
	} {
		bad := base
		change(&bad)
		if validObservation(&bad, "child", Window{}) {
			t.Fatal("contradictory supervisor facts accepted", bad)
		}
	}
}

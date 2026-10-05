package process

import (
	"context"
	"errors"
	"testing"
	"time"

	processcontract "github.com/legrch/farol/modules/computer/contracts/process"
)

// Pure measurement/launcher doubles. No filesystem, process or provider effect.
func TestParentMeasurementsRemainHeldThroughOneBootstrap(t *testing.T) {
	f := newParentFixture(t)
	measured, closed := 0, 0
	held := false
	f.preparer.anchor.measure = func(ctx context.Context, command Command, launch *confinedLaunch) (func(), error) {
		measured++
		if f.lease.inspecting.Load() || f.reservation.calls != 1 || f.boot.calls != 0 || launch == nil || len(launch.pins) == 0 || command.Confinement == nil || command.Confinement.ProfileSHA256 != launch.command.Confinement.ProfileSHA256 {
			t.Fatal("measurement did not follow exact reservation outside owner gate")
		}
		if deadline, ok := ctx.Deadline(); !ok || !deadline.Equal(f.reservation.intent.Deadline) {
			t.Fatal("measurement extended the original execution deadline")
		}
		held = true
		return func() { held = false; closed++ }, nil
	}
	f.prepare(t)
	if measured != 0 {
		t.Fatal("constructor/Prepare measured files")
	}
	f.boot.before = func() {
		if !held || closed != 0 {
			t.Fatal("measurement descriptors not retained through bootstrap")
		}
	}
	f.start(t)
	if measured != 1 || held || closed != 1 {
		t.Fatal("measurement lifetime not settled after single attempt")
	}
	f.finish(t, parentClosedReceipt(f), parentWaited())
	f.start(t)
	if measured != 1 || closed != 1 || f.boot.calls != 1 {
		t.Fatal("repeat Start remeasured or relaunched")
	}
}

func TestParentMeasurementFailureOrLateWithdrawalNeverBootstraps(t *testing.T) {
	for _, mode := range []string{"failure", "partial-failure", "missing-close", "revoked", "expired", "lifetime-ended"} {
		t.Run(mode, func(t *testing.T) {
			f := newParentFixture(t)
			measured, closed := 0, 0
			f.preparer.anchor.measure = func(context.Context, Command, *confinedLaunch) (func(), error) {
				measured++
				close := func() { closed++ }
				switch mode {
				case "failure":
					return nil, errors.New("changed native measurement")
				case "partial-failure":
					return close, errors.New("late measurement failure")
				case "missing-close":
					return nil, nil
				case "revoked":
					f.lease.mutex.Lock()
					f.lease.revoked = true
					f.lease.mutex.Unlock()
				case "expired":
					f.clock.advance(15 * time.Second)
				case "lifetime-ended":
					f.cancel()
				}
				return close, nil
			}
			f.prepare(t)
			for attempt := 0; attempt < 2; attempt++ {
				out, err := f.route.Start(context.Background(), processcontract.StartRequest{OperationID: "operation"})
				if out != nil || err == nil {
					t.Fatal("invalid measurement/late authority accepted", out, err)
				}
				var failure *processcontract.Failure
				if !errors.As(err, &failure) || failure.Code != "PROCESS_NATIVE_REFUSED" || failure.Outcome != "refused" || failure.Retry != "never" {
					t.Fatal("pre-bootstrap refusal classification changed", err)
				}
			}
			wantClose := 1
			if mode == "failure" || mode == "missing-close" {
				wantClose = 0
			}
			if measured != 1 || closed != wantClose || f.boot.calls != 0 || f.reservation.calls != 1 || f.preparer.RetainedHandle() != "" {
				t.Fatalf("measurement=%d close=%d boot=%d reserve=%d", measured, closed, f.boot.calls, f.reservation.calls)
			}
		})
	}
}

package process

import (
	"context"
	"errors"
	"testing"
)

// These controlled owners exercise acknowledgement loss, not native execution,
// process cleanup, installed-app behavior or durable storage.
func TestStartedProcessDisclosureFailureIsUnknownAndRetainsOriginal(t *testing.T) {
	for _, phase := range []string{"initial-response", "retained-response"} {
		for _, fault := range []string{"withdrawn", "cancelled", "expired", "owner-unavailable"} {
			t.Run(phase+"/"+fault, func(t *testing.T) {
				f := newOwnedFixture(t, []byte("retained output"), nil, false)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				withdraw := func() {
					switch fault {
					case "withdrawn":
						f.lease.closed = true
					case "cancelled":
						cancel()
					case "expired":
						f.clock.now = f.lease.execution.deadline
					case "owner-unavailable":
						f.lease.rawError = errors.New("private owner unavailable")
					}
				}
				if phase == "initial-response" {
					f.launch.after = withdraw
				} else {
					start(t, f.s)
					withdraw()
				}
				for attempt := 0; attempt < 2; attempt++ {
					out, err := f.s.Start(ctx, StartRequest{"operation"})
					unknown(t, err)
					if out != nil || err.Error() != "PROCESS_OUTCOME_UNKNOWN" || f.launch.calls != 1 || f.r.calls != 1 ||
						!f.s.started || f.s.child != f.child || f.s.handle != f.child.handle || f.s.uncertain {
						t.Fatal("lost acknowledgement changed the original execution owner", out, err)
					}
				}
				accesses := f.lease.accesses
				completeOwned(t, f)
				result, err := f.s.CaptureOwnedTerminal(context.Background())
				if err != nil || result == nil || string(result.Observation.Stdout) != "retained output" ||
					f.lease.accesses != accesses || f.child.waits.Load() != 1 || f.launch.calls != 1 || f.r.calls != 1 {
					t.Fatal("acknowledgement loss blocked retention or repeated execution", err)
				}
			})
		}
	}
}

func TestProcessDisclosureRefusalBeforeDispatchStaysRefused(t *testing.T) {
	for _, fault := range []string{"withdrawn", "cancelled", "expired", "owner-unavailable"} {
		t.Run(fault, func(t *testing.T) {
			f := newOwnedFixture(t, nil, nil, false)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "withdrawn":
				f.lease.closed = true
			case "cancelled":
				cancel()
			case "expired":
				f.clock.now = f.lease.execution.deadline
			case "owner-unavailable":
				f.lease.rawError = errors.New("private owner unavailable")
			}
			out, err := f.s.Start(ctx, StartRequest{"operation"})
			var failure *Failure
			if out != nil || err == nil || errors.As(err, &failure) && failure.Unknown || f.launch.calls != 0 || f.r.calls != 0 || f.s.started {
				t.Fatal("pre-dispatch refusal became an unknown execution", out, err)
			}
		})
	}
}

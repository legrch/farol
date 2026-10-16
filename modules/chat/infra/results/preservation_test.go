package results

import (
	"context"
	"testing"
	"time"
)

// Inject the last read-only IO boundary, not a native filesystem/provider.
// A late success must remain poisoned even when the context timer itself lags.
func TestPreservationVerifyWithdrawsContextExpiredDuringFinalIO(t *testing.T) {
	for _, kind := range []string{"cancel", "absolute-deadline"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var original context.Context = ctx
			var expire func()
			if kind == "cancel" {
				expire = cancel
			} else {
				until := time.Now().Add(100 * time.Millisecond)
				original = preservationContext{Context: context.Background(), until: until}
				expire = func() { time.Sleep(time.Until(until) + time.Millisecond) }
			}
			calls, closes := 0, 0
			l := &PreservationLease{ctx: original, lifetime: &ClosedLease{
				verify: func() error { calls++; expire(); return nil },
				close:  func() error { closes++; return nil },
			}}
			if l.Verify() == nil {
				t.Fatal("late successful IO restored expired preservation")
			}
			if _, err := l.Observation(); err == nil {
				t.Fatal("expired observation remained available")
			}
			if l.Verify() == nil || calls != 1 {
				t.Fatal("failed original verifier was repeated")
			}
			if l.Close() != nil || l.Close() != nil || closes != 1 {
				t.Fatal("cancelled lease lost owned cleanup")
			}
		})
	}
}

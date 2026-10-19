package connector_test

import (
	"context"
	"errors"
	"testing"
	"time"
)

// Injected policy fixtures only: no endpoint, native drain or live attachment.
func TestOwnerStoppedHealthNeedsOriginalAcknowledgedActiveWithdrawal(t *testing.T) {
	for _, mode := range []string{"pending", "active", "withdrawn-only", "withdrawal-failed", "withdrawal-in-flight", "cancelled-ack", "confirmed"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			if mode != "pending" {
				if err := f.owner.Publish(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "withdrawal-failed" {
				f.journal.withdrawErr = errors.New("unknown withdrawal")
			}
			if mode == "withdrawal-in-flight" {
				f.journal.withdrawHook = func() {
					if f.owner.ConfirmOwnerStop(ctx) == nil {
						t.Fatal("confirmed before original withdrawal ACK")
					}
				}
			}
			if mode != "pending" && mode != "active" {
				callCtx := ctx
				if mode == "cancelled-ack" {
					var cancel context.CancelFunc
					callCtx, cancel = context.WithCancel(ctx)
					f.journal.withdrawHook = cancel
				}
				err := f.owner.Withdraw(callCtx)
				if (err != nil) != (mode == "withdrawal-failed") {
					t.Fatal("unexpected withdrawal", err)
				}
			}
			if mode == "withdrawn-only" {
				if got, err := f.owner.ObserveOwnerStoppedHealth(ctx, "runtime"); got != nil || err == nil {
					t.Fatal("generic withdrawal became owner stop", got, err)
				}
				return
			}
			err := f.owner.ConfirmOwnerStop(ctx)
			want := mode == "confirmed" || mode == "withdrawal-in-flight"
			if (err == nil) != want {
				t.Fatal("incorrect confirmation", err)
			}
			got, err := f.owner.ObserveOwnerStoppedHealth(ctx, "runtime")
			if !want {
				if got != nil || err == nil {
					t.Fatal("unconfirmed owner disclosed stopped", got, err)
				}
				return
			}
			if err != nil || got == nil || got.State != "stopped" || got.Reason != "owner_stopped" || got.LocalReady || got.ObservedAtMillis == nil || got.ValidUntilMillis == nil || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil {
				t.Fatal("invalid negative result", got, err)
			}
			before := *got.ObservedAtMillis
			*got.ObservedAtMillis = 1
			f.clock.advance(time.Second)
			next, err := f.owner.ObserveOwnerStoppedHealth(ctx, "runtime")
			if err != nil || next.ObservedAtMillis == nil || *next.ObservedAtMillis != before+1000 || f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 1 {
				t.Fatal("negative read mutated authority or borrowed result", next, err)
			}
			if _, err := f.owner.Reconnect(ctx); err == nil {
				t.Fatal("negative read revived withdrawn owner")
			}
		})
	}
}

func TestOwnerStoppedHealthRejectsCrossedCancelledAndInvalidClock(t *testing.T) {
	f := newFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.Withdraw(ctx); err != nil {
		t.Fatal(err)
	}
	if err := f.owner.ConfirmOwnerStop(ctx); err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	for _, query := range []struct {
		ctx      context.Context
		instance string
	}{{ctx, "foreign"}, {cancelled, "runtime"}, {nil, "runtime"}} {
		if got, err := f.owner.ObserveOwnerStoppedHealth(query.ctx, query.instance); got != nil || err == nil {
			t.Fatal("crossed negative observation", got, err)
		}
	}
	for _, now := range []int64{0, -1, 1 << 53, (1<<53 - 1) - 44999} {
		f.clock.ms.Store(now)
		if got, err := f.owner.ObserveOwnerStoppedHealth(ctx, "runtime"); got != nil || err == nil {
			t.Fatal("invalid clock disclosed stopped", now, got, err)
		}
	}
}

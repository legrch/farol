package connector_test

import (
	"context"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/services/connector"
)

// Pure owner policy only: synthetic numeric helper reports are not HTTP,
// native child, hosted polling or attachment evidence.
func TestPollingUsesCurrentOwnerClockWithoutChangingAdmission(t *testing.T) {
	for _, sample := range []struct {
		name    string
		age     int64
		present bool
		want    string
	}{
		{"missing", 0, false, "unknown"}, {"never", 1700000000000, true, "no_success"},
		{"recent", 1000, true, "recent"}, {"boundary", 90000, true, "recent"},
		{"stale", 90001, true, "stale"}, {"future", -1, true, "unknown"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			f := newFixture(t)
			if err := f.owner.Publish(ctx); err != nil {
				t.Fatal(err)
			}
			cycles, errors := uint64(10), uint64(3)
			input := connector.ObservePollingQuery{Cycles: &cycles, Errors: &errors}
			if sample.present {
				last := uint64(f.clock.Now().UnixMilli() - sample.age)
				input.LastSuccessMillis = &last
			}
			out, err := f.owner.ObservePolling(ctx, input)
			if err != nil || string(out.State) != sample.want || out.ObservedAtMillis != uint64(f.clock.Now().UnixMilli()) {
				t.Fatal(out, err)
			}
			if (out.AgeSeconds != nil) != (sample.want == "recent" || sample.want == "stale") {
				t.Fatal("unexpected age", out)
			}
			*out.Cycles = 1000
			if cycles != 10 {
				t.Fatal("caller sample mutated")
			}
			if f.journal.publishes.Load() != 1 || f.journal.withdrawals.Load() != 0 {
				t.Fatal("query changed journal")
			}
			if _, err := f.owner.Reconnect(ctx); err != nil {
				t.Fatal("query changed admission", err)
			}
		})
	}
}
func TestPollingCannotReviveLostOwnerOrAdmitPending(t *testing.T) {
	f := newFixture(t)
	if out, err := f.owner.ObservePolling(ctx, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("pending owner became observed", out, err)
	}
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	f.guard.change(func(g *guard) { g.current = false })
	if out, err := f.owner.ObservePolling(ctx, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("lost owner disclosed", out, err)
	}
	f.guard.change(func(g *guard) { g.current = true })
	if out, err := f.owner.ObservePolling(ctx, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("lost owner revived", out, err)
	}
}
func TestPollingRefusesInvalidNumbersCancellationAndClock(t *testing.T) {
	f := newFixture(t)
	if err := f.owner.Publish(ctx); err != nil {
		t.Fatal(err)
	}
	huge := uint64(9007199254740992)
	if out, err := f.owner.ObservePolling(ctx, connector.ObservePollingQuery{Cycles: &huge}); out != nil || err == nil {
		t.Fatal("unsafe number admitted")
	}
	if out, err := f.owner.ObservePolling(nil, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("nil context admitted")
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if out, err := f.owner.ObservePolling(cancelled, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("cancelled query disclosed")
	}
	f.clock.advance(-time.Hour * 1000000)
	if out, err := f.owner.ObservePolling(ctx, connector.ObservePollingQuery{}); out != nil || err == nil {
		t.Fatal("invalid clock disclosed")
	}
}

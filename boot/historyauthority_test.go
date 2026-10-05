package boot

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

func TestHistoryAuthorityPinsCurrentOwnerWithoutExecutionAuthority(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	scope := port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "current", OwnerID: "owner"}
	qualified := true
	a, err := newHistoryReadAuthority(ctx, scope, func() error {
		if !qualified {
			return errors.New("root changed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	l, err := a.AdmitHistoryRead(ctx)
	if err != nil {
		t.Fatal(err)
	}
	calls := 0
	inspect := func(actual port.HistoryReadScope) error {
		calls++
		if actual != scope {
			t.Fatal("reader identity crossed")
		}
		return nil
	}
	if err := l.WithCurrent(ctx, inspect); err != nil || calls != 1 {
		t.Fatal(err)
	}
	qualified = false
	if err := l.WithCurrent(ctx, inspect); err == nil || calls != 1 {
		t.Fatal("root change authorized read")
	}
	qualified = true
	a.close()
	a.close()
	if err := l.WithCurrent(ctx, inspect); err == nil || calls != 1 {
		t.Fatal("closed lifetime revived lease")
	}
	if l, err := a.AdmitHistoryRead(ctx); err == nil || l != nil {
		t.Fatal("closed lifetime admitted new read")
	}
	// A new owner object never changes the original lease's captured lifetime.
	next, err := newHistoryReadAuthority(ctx, port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "next", OwnerID: "other"}, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer next.close()
	if err := l.WithCurrent(ctx, inspect); err == nil {
		t.Fatal("replacement owner revived old lease")
	}
}

func TestHistoryAuthorityChecksCancellationBeforeAndAfterInspection(t *testing.T) {
	for _, fault := range []string{"before-request", "during-request", "lifetime", "physical-after"} {
		t.Run(fault, func(t *testing.T) {
			life, stop := context.WithCancel(context.Background())
			defer stop()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			physical := true
			a, err := newHistoryReadAuthority(life, port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "current", OwnerID: "owner"}, func() error {
				if !physical {
					return errors.New("root crossed")
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			l, err := a.AdmitHistoryRead(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if fault == "before-request" {
				cancel()
			}
			if fault == "lifetime" {
				stop()
			}
			err = l.WithCurrent(ctx, func(port.HistoryReadScope) error {
				if fault == "during-request" {
					cancel()
				}
				if fault == "physical-after" {
					physical = false
				}
				return nil
			})
			if err == nil {
				t.Fatal("late invalidation exposed read scope")
			}
		})
	}
}

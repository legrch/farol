package domain_test

import (
	"github.com/legrch/farol/modules/computer/domain"
	"testing"
)

func TestOwnerStoppedObservationHasOnlyBoundedPresentationTime(t *testing.T) {
	const now uint64 = 1700000000000
	got := domain.ObserveOwnerStoppedConnection(now)
	if got.State != domain.ConnectionStateStopped || got.Reason != domain.ConnectionReasonOwnerStopped || got.LocalReady || got.ObservedAtMillis == nil || *got.ObservedAtMillis != now || got.ValidUntilMillis == nil || *got.ValidUntilMillis != now+45000 || got.LastPollSuccessMillis != nil || got.LastResponseAcceptedMillis != nil || got.NextRetryMillis != nil {
		t.Fatalf("unexpected stopped presentation: %+v", got)
	}
	*got.ObservedAtMillis = 1
	if other := domain.ObserveOwnerStoppedConnection(now); other.ObservedAtMillis == nil || *other.ObservedAtMillis != now {
		t.Fatal("observation shares mutable time")
	}
	for _, now := range []uint64{0, 1 << 53, (1<<53 - 1) - 44999} {
		got := domain.ObserveOwnerStoppedConnection(now)
		if got.State != domain.ConnectionStateUnobserved || got.ObservedAtMillis != nil || got.ValidUntilMillis != nil || got.LocalReady {
			t.Fatalf("invalid clock %d retained stop: %+v", now, got)
		}
	}
}

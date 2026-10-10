package planresponses

import (
	"context"
	"math"
	"testing"
	"time"
)

func TestOperationDeadlinePreservesEarlierCallerAndCancellation(t *testing.T) {
	earlier := time.Now().Add(time.Minute)
	caller, stop := context.WithDeadline(context.Background(), earlier)
	defer stop()
	bounded, cancel, err := (OperationDeadline{}).Limit(caller, uint64(time.Now().Add(2*time.Minute).UnixMilli()))
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	got, ok := bounded.Deadline()
	if !ok || !got.Equal(earlier) {
		t.Fatal("operation extended caller deadline")
	}
	stop()
	if bounded.Err() == nil {
		t.Fatal("caller cancellation detached")
	}
}

func TestOperationDeadlineRefusesExpiredInvalidAndCancelled(t *testing.T) {
	for _, millis := range []uint64{0, 1, math.MaxUint64} {
		ctx, cancel, err := (OperationDeadline{}).Limit(context.Background(), millis)
		if err == nil || ctx != nil || cancel != nil {
			t.Fatal("invalid deadline admitted")
		}
	}
	caller, stop := context.WithCancel(context.Background())
	stop()
	if ctx, _, err := (OperationDeadline{}).Limit(caller, uint64(time.Now().Add(time.Minute).UnixMilli())); err == nil || ctx != nil {
		t.Fatal("cancelled caller admitted")
	}
}

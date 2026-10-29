package boot

import (
	"context"
	"testing"
	"time"
)

func TestSelfTestParentGateExcludesConcurrentAndUnknown(t *testing.T) {
	var gate selfTestParentGate
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !gate.begin(cancel) || gate.begin(cancel) {
		t.Fatal("concurrent parent admitted")
	}
	gate.finish(true)
	if gate.begin(cancel) {
		t.Fatal("unknown parent allowed another run")
	}
}

func TestSelfTestParentGateStopsAndJoinsOriginal(t *testing.T) {
	var gate selfTestParentGate
	ctx, cancel := context.WithCancel(context.Background())
	if !gate.begin(cancel) {
		t.Fatal("parent refused")
	}
	gate.stop()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("parent not cancelled")
	}
	joined := make(chan struct{})
	go func() { gate.wait(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("quit passed before parent finished")
	default:
	}
	gate.finish(true)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("parent not joined")
	}
	if gate.begin(cancel) {
		t.Fatal("closed admission reopened")
	}
}

func TestSelfTestParentGateAllowsNextAfterKnownResult(t *testing.T) {
	var gate selfTestParentGate
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !gate.begin(cancel) {
		t.Fatal("first refused")
	}
	gate.finish(false)
	if !gate.begin(cancel) {
		t.Fatal("settled parent blocked next")
	}
	gate.finish(false)
}

func TestSelfTestParentGateBlocksCleanRetirementUntilSettled(t *testing.T) {
	for _, mode := range []string{"active", "unknown", "settled"} {
		t.Run(mode, func(t *testing.T) {
			s, _, _, _, _ := connectorMutationFixture(t)
			_, cancel := context.WithCancel(context.Background())
			defer cancel()
			if !s.mutations.selfTestParent.begin(cancel) {
				t.Fatal("parent refused")
			}
			if mode != "active" {
				s.mutations.selfTestParent.finish(mode == "unknown")
			}
			err := s.mutations.freezeForRetirement()
			if (err == nil) != (mode == "settled") {
				t.Fatal("incorrect retirement", mode, err)
			}
			if s.mutations.selfTestParent.begin(cancel) {
				t.Fatal("frozen parent admitted")
			}
			if mode == "active" {
				s.mutations.selfTestParent.finish(true)
			}
		})
	}
}

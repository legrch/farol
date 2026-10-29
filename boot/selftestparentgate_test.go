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
	if !gate.begin("original", cancel) || gate.begin("other", cancel) {
		t.Fatal("concurrent parent admitted")
	}
	gate.finish(true)
	if gate.begin("other", cancel) {
		t.Fatal("unknown parent allowed another run")
	}
}

func TestSelfTestParentGateStopsAndJoinsOriginal(t *testing.T) {
	var gate selfTestParentGate
	ctx, cancel := context.WithCancel(context.Background())
	if !gate.begin("original", cancel) {
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
	if gate.begin("other", cancel) {
		t.Fatal("closed admission reopened")
	}
}

func TestSelfTestParentGateAllowsNextAfterKnownResult(t *testing.T) {
	var gate selfTestParentGate
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !gate.begin("original", cancel) {
		t.Fatal("first refused")
	}
	gate.finish(false)
	if !gate.begin("other", cancel) {
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
			if !s.mutations.selfTestParent.begin("original", cancel) {
				t.Fatal("parent refused")
			}
			if mode != "active" {
				s.mutations.selfTestParent.finish(mode == "unknown")
			}
			err := s.mutations.freezeForRetirement()
			if (err == nil) != (mode == "settled") {
				t.Fatal("incorrect retirement", mode, err)
			}
			if s.mutations.selfTestParent.begin("other", cancel) {
				t.Fatal("frozen parent admitted")
			}
			if mode == "active" {
				s.mutations.selfTestParent.finish(true)
			}
		})
	}
}

func TestSelfTestCollectorJoinWaitsForOriginalOnly(t *testing.T) {
	ids, _ := selfTestIDsV1("00000000-0000-4000-8000-000000000001")
	known, unrelated := make(chan struct{}), make(chan struct{})
	ledger := &SettingsMutationIngress{operations: map[string]*settingsMutationOperation{
		ids.quick:   {process: &connectorProcessOperation{collectionDone: known}},
		"unrelated": {process: &connectorProcessOperation{collectionDone: unrelated}},
	}}
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !ledger.selfTestParent.begin(ids.run, cancel) {
		t.Fatal("parent refused")
	}
	ledger.selfTestParent.finish(true)
	joined := make(chan struct{})
	go func() { ledger.waitSelfTestCollectors(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("collector not joined")
	default:
	}
	close(known)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("unrelated collector blocked join")
	}
	close(unrelated)
}

func TestSelfTestCollectorJoinWaitsForVersionTwo(t *testing.T) {
	ids, _ := selfTestIDsV2("00000000-0000-4000-8000-000000000001")
	done := make(chan struct{})
	ledger := &SettingsMutationIngress{operations: map[string]*settingsMutationOperation{
		ids.cancel: {process: &connectorProcessOperation{collectionDone: done}},
	}}
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if !ledger.selfTestParent.begin(ids.run, cancel) {
		t.Fatal("parent refused")
	}
	ledger.selfTestParent.finish(true)
	joined := make(chan struct{})
	go func() { ledger.waitSelfTestCollectors(); close(joined) }()
	select {
	case <-joined:
		t.Fatal("version two collector not joined")
	default:
	}
	close(done)
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("settled version two collector not joined")
	}
}

func TestSelfTestParentAndRecoveryExcludeEachOther(t *testing.T) {
	s, _, _, _, _ := connectorMutationFixture(t)
	ledger := s.mutations
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	ledger.mu.Lock()
	ledger.recoveryReserved = true
	ledger.mu.Unlock()
	if ledger.beginSelfTestParent("original", cancel) {
		t.Fatal("parent crossed recovery reservation")
	}
	ledger.mu.Lock()
	ledger.recoveryReserved = false
	ledger.mu.Unlock()
	if !ledger.beginSelfTestParent("original", cancel) {
		t.Fatal("parent refused")
	}
	ledger.mu.Lock()
	disposition := ledger.recoveryDispositionLocked(false)
	ledger.mu.Unlock()
	if disposition != "pending_operation" {
		t.Fatal("recovery missed active parent", disposition)
	}
	ledger.selfTestParent.finish(true)
	ledger.mu.Lock()
	disposition = ledger.recoveryDispositionLocked(false)
	ledger.mu.Unlock()
	if disposition != "operation_unknown" {
		t.Fatal("recovery missed unknown parent", disposition)
	}
}

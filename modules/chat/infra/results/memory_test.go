package results

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

func scopeFixture() port.JournalScope {
	return port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
}
func bindingFixture() port.TurnBinding {
	return port.TurnBinding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 11, ParticipantID: "participant", TurnID: "turn", OperationID: "operation", TurnGeneration: 9007199254740993}
}
func requestFixture() port.RetainRequest {
	return port.RetainRequest{Binding: bindingFixture(), Result: turn.Result{ID: "result", Outcome: turn.Completed, Code: "COMPLETED"}, Payload: []byte("real retained bytes")}
}
func memoryFixture(t *testing.T, limits Limits) (*Memory, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	m, err := NewMemory(ctx, scopeFixture(), limits)
	if err != nil {
		t.Fatal(err)
	}
	return m, cancel
}
func TestReceiptAttestsRealIndependentBytesAndKnownDuplicateAtCapacity(t *testing.T) {
	m, _ := memoryFixture(t, Limits{Results: 1, ResultBytes: 64, TotalBytes: 64})
	request := requestFixture()
	receipt, err := m.Retain(context.Background(), request)
	if err != nil || receipt.Binding != request.Binding || receipt.Result != request.Result || receipt.Bytes != len(request.Payload) {
		t.Fatalf("receipt=%+v err=%v", receipt, err)
	}
	original := append([]byte(nil), request.Payload...)
	request.Payload[0] = 'X'
	receipt.Bytes = 0
	receipt.Binding.TurnGeneration++
	stored := m.entries[request.Binding.OperationID]
	if !bytes.Equal(stored.payload, original) || stored.receipt.Bytes != len(original) || stored.receipt.Binding != request.Binding {
		t.Fatal("caller bytes/receipt aliased retained storage")
	}
	request.Payload = original
	duplicate, err := m.Retain(context.Background(), request)
	if err != nil || *duplicate != stored.receipt || len(m.entries) != 1 || m.usedBytes != len(original) {
		t.Fatal("known duplicate consumed capacity or changed receipt", err)
	}
	next := request
	next.Binding.OperationID = "next-operation"
	if receipt, err := m.Retain(context.Background(), next); receipt != nil || !errors.Is(err, Capacity) {
		t.Fatal("capacity evicted retained result", err)
	}
	if !bytes.Equal(m.entries[request.Binding.OperationID].payload, original) {
		t.Fatal("capacity changed old bytes")
	}
}
func TestConflictingFullBindingMetadataAndBytesNeverOverwrite(t *testing.T) {
	cases := map[string]func(*port.RetainRequest){
		"owner":       func(r *port.RetainRequest) { r.Binding.OwnerID = "other" },
		"session":     func(r *port.RetainRequest) { r.Binding.SessionID = "other" },
		"task":        func(r *port.RetainRequest) { r.Binding.TaskID = "other" },
		"epoch":       func(r *port.RetainRequest) { r.Binding.TaskEpoch++ },
		"participant": func(r *port.RetainRequest) { r.Binding.ParticipantID = "other" },
		"turn":        func(r *port.RetainRequest) { r.Binding.TurnID = "other" },
		"generation":  func(r *port.RetainRequest) { r.Binding.TurnGeneration++ },
		"result-id":   func(r *port.RetainRequest) { r.Result.ID = "other" },
		"outcome":     func(r *port.RetainRequest) { r.Result.Outcome = turn.UnknownOutcome },
		"code":        func(r *port.RetainRequest) { r.Result.Code = "UNKNOWN" },
		"bytes":       func(r *port.RetainRequest) { r.Payload = []byte("REAL retained bytes") },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			m, _ := memoryFixture(t, TextLimits())
			original := requestFixture()
			if _, err := m.Retain(context.Background(), original); err != nil {
				t.Fatal(err)
			}
			changed := requestFixture()
			change(&changed)
			if receipt, err := m.Retain(context.Background(), changed); receipt != nil || !errors.Is(err, Conflict) {
				t.Fatal("changed operation returned proof", err)
			}
			stored := m.entries[original.Binding.OperationID]
			if !bytes.Equal(stored.payload, original.Payload) || stored.receipt.Binding != original.Binding || stored.receipt.Result != original.Result || len(m.entries) != 1 {
				t.Fatal("conflict overwrote original")
			}
		})
	}
}
func TestInvalidRequestsAndScopeRefuseWithoutStorage(t *testing.T) {
	cases := map[string]struct {
		change func(*port.RetainRequest)
		want   error
	}{
		"profile":       {func(r *port.RetainRequest) { r.Binding.ProfileID = "other" }, Mismatch},
		"backend":       {func(r *port.RetainRequest) { r.Binding.BackendGeneration = "other" }, Mismatch},
		"empty-owner":   {func(r *port.RetainRequest) { r.Binding.OwnerID = "" }, Invalid},
		"space-id":      {func(r *port.RetainRequest) { r.Binding.ParticipantID = "raw prompt" }, Invalid},
		"long-id":       {func(r *port.RetainRequest) { r.Binding.TurnID = strings.Repeat("x", 121) }, Invalid},
		"bad-utf8-id":   {func(r *port.RetainRequest) { r.Binding.OperationID = string([]byte{255}) }, Invalid},
		"epoch":         {func(r *port.RetainRequest) { r.Binding.TaskEpoch = 0 }, Invalid},
		"generation":    {func(r *port.RetainRequest) { r.Binding.TurnGeneration = 0 }, Invalid},
		"result-id":     {func(r *port.RetainRequest) { r.Result.ID = "" }, Invalid},
		"outcome":       {func(r *port.RetainRequest) { r.Result.Outcome = "raw" }, Invalid},
		"empty-code":    {func(r *port.RetainRequest) { r.Result.Code = "" }, Invalid},
		"raw-code":      {func(r *port.RetainRequest) { r.Result.Code = "private error message" }, Invalid},
		"prefix-code":   {func(r *port.RetainRequest) { r.Result.Code = "_UNKNOWN" }, Invalid},
		"large-payload": {func(r *port.RetainRequest) { r.Payload = make([]byte, MaxResultBytes+1) }, Invalid},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			m, _ := memoryFixture(t, TextLimits())
			request := requestFixture()
			c.change(&request)
			if receipt, err := m.Retain(context.Background(), request); receipt != nil || !errors.Is(err, c.want) {
				t.Fatalf("receipt=%+v err=%v", receipt, err)
			}
			if len(m.entries) != 0 || m.usedBytes != 0 {
				t.Fatal("invalid request stored")
			}
		})
	}
}
func TestPayloadAndEntryBudgetsIncludeZeroByteOutcomesWithoutEviction(t *testing.T) {
	t.Run("total-bytes", func(t *testing.T) {
		m, _ := memoryFixture(t, Limits{Results: 3, ResultBytes: 4, TotalBytes: 5})
		r := requestFixture()
		r.Payload = []byte{0, 255, 1, 2}
		if _, err := m.Retain(context.Background(), r); err != nil {
			t.Fatal(err)
		}
		next := r
		next.Binding.OperationID = "next"
		next.Payload = []byte{3, 4}
		if receipt, err := m.Retain(context.Background(), next); receipt != nil || !errors.Is(err, Capacity) {
			t.Fatal("byte bound exceeded", err)
		}
		if m.usedBytes != 4 || !bytes.Equal(m.entries[r.Binding.OperationID].payload, r.Payload) {
			t.Fatal("failed retention changed bytes")
		}
	})
	t.Run("empty-outcomes", func(t *testing.T) {
		m, _ := memoryFixture(t, Limits{Results: 1, ResultBytes: 1, TotalBytes: 1})
		r := requestFixture()
		r.Payload = nil
		r.Result.Outcome = turn.Refused
		r.Result.Code = "REFUSED"
		receipt, err := m.Retain(context.Background(), r)
		if err != nil || receipt.Bytes != 0 || len(m.entries) != 1 {
			t.Fatal("zero-byte result absent", err)
		}
		next := r
		next.Binding.OperationID = "next"
		if receipt, err := m.Retain(context.Background(), next); receipt != nil || !errors.Is(err, Capacity) {
			t.Fatal("zero bytes bypassed entry bound", err)
		}
	})
}
func TestConcurrentRetentionIsBoundedAndAtomic(t *testing.T) {
	m, _ := memoryFixture(t, Limits{Results: 8, ResultBytes: 1, TotalBytes: 8})
	start := make(chan struct{})
	errs := make(chan error, 32)
	var wg sync.WaitGroup
	for n := 0; n < 32; n++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			<-start
			r := requestFixture()
			r.Binding.OperationID = fmt.Sprintf("operation-%d", n)
			r.Binding.TurnID = fmt.Sprintf("turn-%d", n)
			r.Payload = []byte{byte(n)}
			receipt, err := m.Retain(context.Background(), r)
			if err == nil && (receipt == nil || receipt.Binding != r.Binding || receipt.Bytes != 1) {
				err = errors.New("incorrect concurrent receipt")
			}
			errs <- err
		}(n)
	}
	close(start)
	wg.Wait()
	close(errs)
	successes, capacity := 0, 0
	for err := range errs {
		if err == nil {
			successes++
		} else if errors.Is(err, Capacity) {
			capacity++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 8 || capacity != 24 || len(m.entries) != 8 || m.usedBytes != 8 {
		t.Fatal("concurrent bound/atomicity failed", successes, capacity)
	}
}
func TestLifetimeAndRequestCancellationNeverMintRetentionOrACK(t *testing.T) {
	m, cancelLifetime := memoryFixture(t, TextLimits())
	r := requestFixture()
	if _, err := m.Retain(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if err := m.Close(); !errors.Is(err, Active) || len(m.entries) != 1 {
		t.Fatal("active close discarded unacknowledged bytes", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if receipt, err := m.Retain(ctx, r); receipt != nil || !errors.Is(err, Unavailable) {
		t.Fatal("cancelled request returned proof", err)
	}
	if receipt, err := m.Retain(nil, r); receipt != nil || !errors.Is(err, Invalid) {
		t.Fatal("nil context accepted", err)
	}
	cancelLifetime()
	if receipt, err := m.Retain(context.Background(), r); receipt != nil || !errors.Is(err, Unavailable) {
		t.Fatal("ended lifetime returned proof", err)
	}
	if len(m.entries) != 1 {
		t.Fatal("cancellation silently evicted result")
	}
	if err := m.Close(); err != nil || len(m.entries) != 0 || m.usedBytes != 0 {
		t.Fatal("ended store not closed", err)
	}
	if err := m.Close(); err != nil {
		t.Fatal("close not idempotent", err)
	}
	if receipt, err := m.Retain(context.Background(), r); receipt != nil || !errors.Is(err, Unavailable) {
		t.Fatal("closed store admitted result", err)
	}
	fresh, err := NewMemory(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "fresh-backend"}, TextLimits())
	if err != nil || len(fresh.entries) != 0 {
		t.Fatal("fresh memory restored old bytes", err)
	}
	if receipt, err := fresh.Retain(context.Background(), r); receipt != nil || !errors.Is(err, Mismatch) {
		t.Fatal("old binding entered fresh backend", err)
	}
}

type nilContextFixture struct{ context.Context }

func TestConstructorAndZeroValueRefuseInvalidComposition(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	var typedNil *nilContextFixture
	cases := []struct {
		ctx    context.Context
		scope  port.JournalScope
		limits Limits
	}{
		{nil, scopeFixture(), TextLimits()}, {typedNil, scopeFixture(), TextLimits()}, {cancelled, scopeFixture(), TextLimits()},
		{context.Background(), port.JournalScope{}, TextLimits()}, {context.Background(), scopeFixture(), Limits{}},
		{context.Background(), scopeFixture(), Limits{MaxResults + 1, MaxResultBytes, MaxTotalBytes}},
		{context.Background(), scopeFixture(), Limits{1, MaxResultBytes + 1, MaxTotalBytes}},
		{context.Background(), scopeFixture(), Limits{1, 4, 3}}, {context.Background(), scopeFixture(), Limits{1, 4, MaxTotalBytes + 1}},
	}
	for n, c := range cases {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			if m, err := NewMemory(c.ctx, c.scope, c.limits); m != nil || !errors.Is(err, Invalid) {
				t.Fatal("invalid constructor", err)
			}
		})
	}
	var m *Memory
	if receipt, err := m.Retain(context.Background(), requestFixture()); receipt != nil || !errors.Is(err, Invalid) {
		t.Fatal("nil store accepted", err)
	}
	if receipt, err := new(Memory).Retain(context.Background(), requestFixture()); receipt != nil || !errors.Is(err, Unavailable) {
		t.Fatal("zero store accepted", err)
	}
}

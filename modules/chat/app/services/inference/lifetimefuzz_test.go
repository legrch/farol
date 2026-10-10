package inference_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Synthetic ports exercise owned app lifetime policy, not provider cancellation
// or durable owner implementations. Actual production HTTP/grant composition is
// covered independently in the adapter package.
func FuzzOperationWithdrawalAndNoReplay(f *testing.F) {
	for stage := uint8(0); stage < 9; stage++ {
		f.Add(stage, []byte("selected café 🌊"))
	}
	f.Fuzz(func(t *testing.T, stage uint8, payload []byte) {
		if len(payload) > 1024 {
			payload = payload[:1024]
		}
		fixture := newFixture(t)
		fixture.input[1].Content = string(payload)
		hash, err := inference.InputHash(intent.SHA256{}, fixture.input)
		if err != nil {
			t.Fatal(err)
		}
		fixture.binding.Context.InputHash = hash
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		switch stage % 9 {
		case 0:
			fixture.credentials.value.Account.Epoch++
		case 1:
			fixture.credentials.after = func() { fixture.a.current = false }
		case 2:
			fixture.transport.after = func() { fixture.a.current = false }
		case 3:
			fixture.transport.outcome = inference.Outcome{State: inference.Unknown, Code: "INFERENCE_TRANSPORT_UNKNOWN"}
		case 4:
			fixture.transport.outcome = inference.Outcome{State: inference.Failed, Code: "INFERENCE_MODEL_DENIED"}
		case 5:
			fixture.transport.after = cancel
		case 6:
			fixture.ledger.afterSettle = func() { fixture.c.now = fixture.binding.DeadlineMillis }
		case 7:
			fixture.publication.err = errors.New("synthetic private diagnostic")
		case 8:
			fixture.a.after = func() error {
				if fixture.publication.calls > 0 {
					return inference.Withdrawn
				}
				return nil
			}
		}
		got := fixture.service.Infer(ctx, fixture.binding, fixture.input)
		if got.State == inference.Completed || got.Text != "" || fixture.ledger.stored.Text != "" {
			t.Fatal("withdrawn/uncertain data became a final answer")
		}
		requests, publications := fixture.transport.calls, fixture.publication.calls
		if !utf8.Valid(payload) && (requests != 0 || publications != 0) {
			t.Fatal("invalid UTF8 crossed inference boundary")
		}
		_ = fixture.service.Infer(ctx, fixture.binding, fixture.input)
		if fixture.transport.calls != requests || fixture.publication.calls != publications || requests > 1 || publications > 1 {
			t.Fatal("original operation replayed")
		}
	})
}

func TestInputExactByteAndItemBoundaries(t *testing.T) {
	fixture := newFixture(t)
	request := inference.Request{Model: fixture.binding.Selection.Model, Input: []inference.InputItem{{Kind: "message", Role: "user"}}}
	empty, err := json.Marshal(request.Input)
	if err != nil {
		t.Fatal(err)
	}
	request.Input[0].Content = strings.Repeat("x", inference.MaxInputBytes-len(empty))
	encoded, _ := json.Marshal(request.Input)
	if len(encoded) != inference.MaxInputBytes || inference.ValidateRequest(request) != nil {
		t.Fatal("exact input byte limit refused")
	}
	request.Input[0].Content += "x"
	if inference.ValidateRequest(request) == nil {
		t.Fatal("input byte overflow admitted")
	}
	request.Input = make([]inference.InputItem, inference.MaxInputItems)
	for i := range request.Input {
		request.Input[i] = inference.InputItem{Kind: "message", Role: "user", Content: "🌊"}
	}
	if inference.ValidateRequest(request) != nil {
		t.Fatal("exact item limit refused")
	}
	request.Input = append(request.Input, request.Input[0])
	if inference.ValidateRequest(request) == nil {
		t.Fatal("item overflow admitted")
	}
}

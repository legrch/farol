package slotbinding

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/release/app/port"
)

type publisher struct {
	calls    int
	decision port.SlotBindingDecision
	err      error
}

func (p *publisher) Publish(_ context.Context, b []byte) (port.SlotBindingResult, error) {
	p.calls++
	b[0] = 'x'
	return port.SlotBindingResult{Decision: p.decision}, p.err
}
func TestServiceBoundary(t *testing.T) {
	for _, kind := range []string{"nil", "oversized", "cancelled", "confirmed", "refused", "unknown", "invalid", "error"} {
		t.Run(kind, func(t *testing.T) {
			p := &publisher{decision: port.SlotBindingConfirmed}
			s := New(p)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			data := []byte("fixture")
			want := port.SlotBindingRefused
			calls := 0
			switch kind {
			case "nil":
				s = New(nil)
			case "oversized":
				data = make([]byte, 8193)
			case "cancelled":
				cancel()
			case "confirmed":
				want = port.SlotBindingConfirmed
				calls = 1
			case "refused":
				p.decision = port.SlotBindingRefused
				calls = 1
			case "unknown":
				p.decision = port.SlotBindingUnknown
				want = port.SlotBindingUnknown
				calls = 1
			case "invalid":
				p.decision = 0
				want = port.SlotBindingUnknown
				calls = 1
			case "error":
				p.err = errors.New("lost response")
				want = port.SlotBindingUnknown
				calls = 1
			}
			original := append([]byte(nil), data...)
			r, _ := s.Publish(ctx, Request{Bytes: data})
			if r.Result.Decision != want || p.calls != calls {
				t.Fatal(r, p.calls)
			}
			if string(data) != string(original) {
				t.Fatal("caller bytes changed")
			}
		})
	}
}

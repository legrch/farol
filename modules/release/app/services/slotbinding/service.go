// Package slotbinding exposes one bounded publication, without updater state.
package slotbinding

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

type Service struct{ publisher port.SlotBindingPublisher }

func New(publisher port.SlotBindingPublisher) *Service { return &Service{publisher: publisher} }

type Request struct{ Bytes []byte }
type Response struct{ Result port.SlotBindingResult }

func (s *Service) Publish(ctx context.Context, request Request) (*Response, error) {
	refused := func(code string) (*Response, error) {
		return &Response{Result: port.SlotBindingResult{Decision: port.SlotBindingRefused, Code: code}}, nil
	}
	if len(request.Bytes) < 1 || len(request.Bytes) > 8192 {
		return refused("slot_binding_invalid")
	}
	if ctx.Err() != nil {
		return refused("slot_binding_cancelled")
	}
	if s.publisher == nil {
		return refused("slot_binding_unavailable")
	}
	result, err := s.publisher.Publish(ctx, append([]byte(nil), request.Bytes...))
	// An unclassified port failure can conceal publication. It is never a refusal.
	if err != nil || (result.Decision != port.SlotBindingConfirmed && result.Decision != port.SlotBindingRefused && result.Decision != port.SlotBindingUnknown) {
		result = port.SlotBindingResult{Decision: port.SlotBindingUnknown, Code: "slot_binding_publication_unconfirmed"}
	}
	return &Response{Result: result}, err
}

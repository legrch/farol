package helperprotocol

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

// BuildSlotBinding returns expected bytes only. Nil bytes preserve the original
// legacy request's absent installLocation field; explicit legacy/shared requests
// require their exact operation-slot record. The existing owner must observe
// that record through its borrowed physical directory at every effect fence.
func (s *Service) BuildSlotBinding(ctx context.Context, codec port.HelperSlotBindingCodec) ([]byte, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	if s.request.InstallLocation == nil {
		if ctx.Err() != nil {
			return nil, failure("canceled")
		}
		return nil, nil
	}
	if codec == nil {
		return nil, internal()
	}
	value := port.HelperSlotBinding{OperationID: s.request.OperationID, InstallLocation: *s.request.InstallLocation, Source: s.request.Source, Target: s.request.Target}
	data, err := codec.SlotBinding(value)
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	if err != nil {
		if err.Error() == "helper_protocol_size" {
			return nil, failure("slot_binding_invalid")
		}
		return nil, internal()
	}
	if len(data) < 1 || len(data) > 8192 {
		return nil, failure("slot_binding_invalid")
	}
	captured := append([]byte(nil), data...)
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	return captured, nil
}

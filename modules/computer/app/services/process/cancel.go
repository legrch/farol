package process

import "context"

type CancelRequest struct{ Handle string }
type CancelResponse struct{ Status CancelStatus }

// Cancel controls only the retained selected child. It does not renew expired
// admission, expose output, infer completion, or select a PID after reconnect.
func (s *Service) Cancel(ctx context.Context, request CancelRequest) (*CancelResponse, error) {
	if s == nil || ctx == nil {
		return nil, fail("PROCESS_INPUT_INVALID", false)
	}
	s.gate.Lock()
	child, handle := s.child, s.handle
	if child == nil || request.Handle != handle {
		s.gate.Unlock()
		return nil, fail("PROCESS_HANDLE_MISMATCH", false)
	}
	if child.Handle() != handle {
		s.uncertain = true
		s.gate.Unlock()
		return nil, fail("PROCESS_CANCEL_UNKNOWN", true)
	}
	if s.cancelAttempted {
		saved, err := s.cancellation, s.cancelFailure
		s.gate.Unlock()
		if err != nil {
			return nil, err
		}
		if saved == nil {
			return nil, fail("PROCESS_CANCEL_PENDING", true)
		}
		return &CancelResponse{saved.Status}, nil
	}
	if ctx.Err() != nil {
		s.gate.Unlock()
		return nil, fail("PROCESS_CANCELLED", false)
	}
	s.cancelAttempted = true
	s.gate.Unlock()
	receipt, err := child.Cancel(ctx)
	if err != nil || receipt == nil || receipt.Handle != handle ||
		!(receipt.Status == CancelRequested || receipt.Status == AlreadyTerminal || receipt.Status == CancelUnknown) {
		s.gate.Lock()
		s.uncertain = true
		s.cancelFailure = fail("PROCESS_CANCEL_UNKNOWN", true)
		err = s.cancelFailure
		s.gate.Unlock()
		return nil, err
	}
	saved := *receipt
	s.gate.Lock()
	terminal := s.terminal && !s.uncertain
	s.gate.Unlock()
	if saved.Status == AlreadyTerminal && !terminal {
		saved.Status = CancelUnknown
	}
	// An already-terminal ACK must still be corroborated by a later exact Wait
	// and group/cohort observation. Cancel itself never publishes terminal state.
	s.gate.Lock()
	s.cancellation = &saved
	if saved.Status == CancelUnknown {
		s.uncertain = true
	}
	s.gate.Unlock()
	return &CancelResponse{saved.Status}, nil
}

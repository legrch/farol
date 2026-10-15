package process

import "context"

type StartRequest struct{ OperationID string }
type StartResponse struct{ OperationID, Handle string }

func (s *Service) Start(ctx context.Context, request StartRequest) (*StartResponse, error) {
	if s == nil || ctx == nil || request.OperationID != s.intent.OperationID {
		return nil, fail("PROCESS_OPERATION_MISMATCH", false)
	}
	s.gate.Lock()
	if s.refusal != nil {
		err := s.refusal
		s.gate.Unlock()
		return nil, err
	}
	if s.pending {
		s.gate.Unlock()
		return nil, fail("PROCESS_START_PENDING", false)
	}
	if s.prepared == nil {
		s.gate.Unlock()
		return nil, fail("PROCESS_NOT_PREPARED", false)
	}
	if s.preparer != nil {
		selected, ok := s.prepared.(Selected)
		if !ok || s.invocation == nil || selected.Seal() != s.intent.Seal || !scopeMatchesSeal(s.scope, selected.Seal()) || !sameInvocation(*s.invocation, selected.Invocation()) {
			s.refusal = fail("PROCESS_PREPARATION_UNKNOWN", true)
			err := s.refusal
			s.gate.Unlock()
			return nil, err
		}
	}
	if s.started {
		child, handle, uncertain := s.child, s.handle, s.uncertain
		s.gate.Unlock()
		if uncertain || child == nil || child.Handle() != handle {
			s.gate.Lock()
			s.uncertain = true
			s.gate.Unlock()
			return nil, fail("PROCESS_OUTCOME_UNKNOWN", true)
		}
		var response *StartResponse
		err := s.withCurrent(ctx, func() error { response = &StartResponse{s.intent.OperationID, handle}; return nil })
		if err != nil {
			return nil, fail("PROCESS_OUTCOME_UNKNOWN", true)
		}
		return response, nil
	}
	s.pending = true
	s.gate.Unlock()
	finish := func(err error) (*StartResponse, error) {
		s.gate.Lock()
		s.pending = false
		s.refusal = err
		s.gate.Unlock()
		return nil, err
	}
	if err := s.current(ctx); err != nil {
		return finish(err)
	}
	receipt, err := s.reservations.Reserve(ctx, s.intent)
	if err != nil || receipt == nil || receipt.Status != Reserved || !sameIntent(receipt.Intent, s.intent) {
		return finish(fail("PROCESS_RESERVATION_UNKNOWN", true))
	}
	if err = s.current(ctx); err != nil {
		return finish(err)
	}
	// The producer performs the same guard after native preparation. Neither
	// Reserve nor Spawn runs under an app/Computer/Task/Chat inspect gate.
	child, err := s.prepared.Spawn(ctx, SpawnRequest{Deadline: s.intent.Deadline, Check: s.current})
	if err != nil {
		return finish(boundary(err))
	}
	if child == nil {
		return finish(fail("PROCESS_OUTCOME_UNKNOWN", true))
	}
	handle := child.Handle()
	if !identifier(handle) {
		return finish(fail("PROCESS_OUTCOME_UNKNOWN", true))
	}
	s.gate.Lock()
	s.pending = false
	s.started = true
	s.child = child
	s.handle = handle
	s.gate.Unlock()
	// Lost disclosure cannot classify an already dispatched effect as refused.
	// Keep the exact owning child for collection without replaying its start.
	var response *StartResponse
	err = s.withCurrent(ctx, func() error { response = &StartResponse{s.intent.OperationID, handle}; return nil })
	if err != nil {
		return nil, fail("PROCESS_OUTCOME_UNKNOWN", true)
	}
	return response, nil
}

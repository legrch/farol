package update

import (
	"context"
	"errors"
)

var ErrInvalidAction = errors.New("UPDATE_ACTION_INVALID")

type CloseRequest struct{}
type CloseResponse struct{ Drained bool }

func (s *Service) Close(ctx context.Context, _ CloseRequest) (*CloseResponse, error) {
	s.mu.Lock()
	first := s.state.Close()
	drained, cancelled := s.drained, s.cancelled
	s.mu.Unlock()
	if first {
		s.runtime.CancelPending()
		close(cancelled)
	}
	// All concurrent Close calls observe the same network-cancel completion and
	// current operation. Deadline expiry reports uncertainty, never cleanup.
	select {
	case <-cancelled:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	select {
	case <-drained:
		return &CloseResponse{Drained: true}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

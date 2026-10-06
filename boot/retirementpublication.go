package boot

import "context"

// Retirement joins the original publication/admission work under its existing
// effects gate. Closure is permanent even if withdrawal or later capture fails.
// No current-authority guard is held during storage IO or owner retirement.
func (s *ComputerIngress) freezeForRetirement(ctx context.Context) error {
	if s == nil || ctx == nil {
		return computerUnavailable()
	}
	s.effects.Lock()
	defer s.effects.Unlock()
	s.retiring = true
	_, err := s.guard.deactivate()
	s.mu.Lock()
	unknown := s.unknown
	s.mu.Unlock()
	if err != nil || unknown || ctx.Err() != nil {
		return computerUnavailable()
	}
	return nil
}

package lifecycle

import (
	"context"

	"github.com/legrch/farol/modules/chat/app/port"
)

// This private capability refers to the original live mutation, never replayed
// journal data. Only final send authorization can create it. Ordinary Handle
// projections remain pending/unavailable throughout this interval.
type sendCurrent struct {
	owner      *Service
	mutation   *mutation
	revision   uint64
	active     bool
	request    port.SendRequest
	authorized *port.SendRequest
}

func (c *sendCurrent) WithCurrent(ctx context.Context, inspect func(port.TurnBinding) error) error {
	if c == nil || c.owner == nil || ctx == nil || inspect == nil {
		return Invalid
	}
	s := c.owner
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	if !c.active {
		return Unavailable
	}
	c.authorized = nil
	if err := s.current(ctx, c.mutation); err != nil {
		return err
	}
	m := c.mutation
	if s.revision != c.revision || m.entry.Kind != "dispatch" || m.entry.Effect != "send" || m.handle.closed || m.handle.verification != c.request.Verification || browserBinding(m.entry.After.Binding) != c.request.Binding || m.handle.digest != c.request.IntentDigest {
		return Mismatch
	}
	if err := inspect(m.handle.fixed); err != nil {
		return err
	}
	if err := s.current(ctx, m); err != nil {
		return err
	}
	// Select the exact outgoing immutable bytes under both Computer and Chat
	// guards. No journal or browser round trip follows this authorization.
	copy := c.request
	c.authorized = &copy
	return nil
}

func (s *Service) authorizeSend(ctx context.Context, m *mutation, request port.SendRequest) (*port.SendRequest, error) {
	s.deps.Gate.Lock()
	if err := s.current(ctx, m); err != nil {
		s.deps.Gate.Unlock()
		return nil, err
	}
	authorizer := m.handle.sendAuthorization
	if authorizer == nil {
		s.deps.Gate.Unlock()
		return &request, nil
	}
	current := &sendCurrent{owner: s, mutation: m, revision: s.revision, active: true, request: request}
	s.deps.Gate.Unlock()
	err := authorizer.Authorize(ctx, current)
	s.deps.Gate.Lock()
	defer s.deps.Gate.Unlock()
	current.active = false
	if err != nil {
		return nil, err
	}
	if err := s.current(ctx, m); err != nil {
		return nil, err
	}
	if current.authorized == nil {
		return nil, Unavailable
	}
	return current.authorized, nil
}

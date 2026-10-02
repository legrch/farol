package update

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
	release "github.com/legrch/farol/modules/release/domain"
)

type LaterRequest struct{}
type LaterResponse struct{}

func (s *Service) Later(LaterRequest) (*LaterResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.state.Later()
	return &LaterResponse{}, nil
}

type ApplyRequest struct{}
type ApplyResponse struct{}

func (s *Service) Apply(ctx context.Context, _ ApplyRequest) (*ApplyResponse, error) {
	s.handoff(ctx, release.Apply)
	return &ApplyResponse{}, nil
}

type RestoreAction uint8

const (
	Recover RestoreAction = iota + 1
	Rollback
)

type RestoreRequest struct{ Action RestoreAction }
type RestoreResponse struct{}

func (s *Service) Restore(ctx context.Context, req RestoreRequest) (*RestoreResponse, error) {
	var action release.Action
	switch req.Action {
	case Recover:
		action = release.Recover
	case Rollback:
		action = release.Rollback
	default:
		return nil, ErrInvalidAction
	}
	s.handoff(ctx, action)
	return &RestoreResponse{}, nil
}

func (s *Service) handoff(ctx context.Context, action release.Action) {
	var a release.Archive
	if !s.begin(func() bool { var started bool; a, started = s.state.BeginHandoff(action); return started }) {
		return
	}
	var h *port.Handoff
	var err error
	if action == release.Apply {
		h, err = s.runtime.Apply(ctx, archivePort(a))
	} else {
		if action == release.Recover {
			h, err = s.runtime.Restore(ctx, port.Recover)
		} else {
			h, err = s.runtime.Restore(ctx, port.Rollback)
		}
	}
	decision, code := release.Unknown, "UPDATE_HANDOFF_UNKNOWN"
	// Even a classified error after a possible dispatch is unknown. Only a
	// parsed, explicit no-effect handoff can offer another owner intention.
	if err == nil && h != nil {
		if validCode(h.Code) {
			code = h.Code
		}
		switch h.Decision {
		case port.Accepted:
			decision = release.Accepted
		case port.Blocked:
			if validCode(h.Code) {
				decision = release.Blocked
			}
		}
	}
	s.finish(func() { s.state.HandedOff(decision, code) })
}

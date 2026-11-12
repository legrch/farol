// Package observation assesses continuity candidates without changing grants.
// There is no production boot, IPC, MCP, settings write, or refresh wiring.
package observation

import (
	"context"
	identityport "github.com/legrch/farol/modules/computer/app/port/observation"
	identity "github.com/legrch/farol/modules/computer/domain/observation"
)

type Service struct{ probe identityport.Probe }

func New(probe identityport.Probe) *Service { return &Service{probe: probe} }

type Request struct {
	Saved      identity.Saved
	Settlement identity.Settlement
}

func (s *Service) Assess(ctx context.Context, request Request) (identity.Assessment, error) {
	if ctx == nil || ctx.Err() != nil {
		return "", &identityport.Failure{Code: "WORKSPACE_REQUEST_CANCELLED"}
	}
	// Snapshot caller-owned evidence before the dependency callback. Callers
	// must not concurrently mutate the request while this copy is being made.
	saved := request.Saved
	if saved.Evidence != nil {
		evidence := *saved.Evidence
		saved.Evidence = &evidence
	}
	if early := identity.Preflight(saved, request.Settlement); early != "" {
		return early, nil
	}
	if s == nil || s.probe == nil {
		return "", &identityport.Failure{Code: "WORKSPACE_IDENTITY_UNAVAILABLE"}
	}
	current, err := s.probe.Observe(ctx, saved.Binding.Path)
	if err != nil {
		return "", err
	} // One observation, no retries or fallback.
	if ctx.Err() != nil {
		return "", &identityport.Failure{Code: "WORKSPACE_REQUEST_CANCELLED"}
	}
	return identity.Compare(saved, current, request.Settlement), nil
}

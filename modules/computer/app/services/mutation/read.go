package mutation

import (
	"context"
	"errors"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	state "github.com/legrch/farol/modules/computer/domain/mutation"
)

// ReadRequest includes the original payload solely for exact digest correlation;
// it is never execution permission. Read performs no Admit, Save or native IO.
type ReadRequest = CheckRequest
type ReadResponse = ExecuteResponse

func (s *Service) Read(ctx context.Context, r ReadRequest) (*ReadResponse, error) {
	if !s.matches(r) {
		return nil, invalid()
	}
	if _, err := s.Check(ctx, r); err != nil {
		return nil, err
	}
	if _, err := s.current(ctx, r.WorkspaceID, convert(r.Operation).Path(), nil, nil); err != nil {
		return nil, err
	}
	s.gate.Lock()
	if s.pending {
		s.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_IN_PROGRESS", "operation-store")
	}
	s.gate.Unlock()
	// Execute's terminal observer must not be used: missing records must remain
	// missing, and a read must never become a dispatch after restart.
	digest, err := s.digester.Digest(digestInput(r))
	if err != nil || !state.SHA256(digest) {
		return nil, authority.Fail("COMPUTER_MUTATION_FINGERPRINT_FAILED", "operation-store")
	}
	expected := bindingFor(r, digest)
	s.gate.Lock()
	if s.binding != nil && *s.binding != expected {
		s.gate.Unlock()
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_CONFLICT", "operation-store")
	}
	cached, publication := s.terminal, s.publication
	if cached != nil && cached.Phase() == state.Prepared {
		// A peer may still finish; re-observe this SAME durable key without effects.
		cached = nil
	}
	if cached != nil {
		copy := cached.Clone()
		cached = &copy
	}
	s.gate.Unlock()
	if cached != nil {
		return s.disclose(ctx, r, convert(r.Operation).Path(), cached, publication)
	}
	record, err := s.repository.Load(ctx, expected.Identity)
	if err != nil {
		return nil, storeUnavailable()
	}
	if record == nil {
		return nil, authority.Fail("COMPUTER_MUTATION_OPERATION_NOT_FOUND", "operation-store")
	}
	if _, err := record.Recover(expected); err != nil {
		var classified *authority.Failure
		if errors.As(err, &classified) {
			return nil, err
		}
		return nil, storeUnavailable()
	}
	return s.disclose(ctx, r, convert(r.Operation).Path(), record, "durable")
}

func digestInput(r CheckRequest) port.MutationDigestInput {
	return port.MutationDigestInput{WorkspaceID: r.WorkspaceID, Operation: convert(r.Operation)}
}
func bindingFor(r CheckRequest, digest string) state.Binding {
	return state.Binding{Identity: identity(r), WorkspaceID: r.WorkspaceID, RequestDigest: digest}
}

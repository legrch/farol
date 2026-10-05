package connector

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// A nil attempt means never attempted. Once reserved, a nil observation means
// pending, failed or outcome-unknown; none of those states permits another List.
type verificationAttempt struct {
	workspaceID, callID string
	observation         *port.ConnectorVerification
}

// withVerificationCurrent uses the existing synchronous, no-IO owner/host gate.
// The original authorization bounds this observation; it is not an execution
// lease renewal and cannot use a restored approval to extend its lifetime.
func (s *Service) withVerificationCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if s == nil || ctx == nil {
		return failure()
	}
	return s.WithCurrent(ctx, func(binding *port.TaskBinding) error {
		if ctx.Err() != nil {
			return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "connector-owner")
		}
		if binding != nil && s.launch.VerificationChallenge != ([32]byte{}) {
			now := s.clock.Now()
			if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 || !now.Before(s.launch.Admission.ExpiresAt) || !now.Before(s.launch.Approval.ExpiresAt) {
				return authority.Fail("AUTHORITY_EXPIRED", "connector-owner")
			}
		}
		if ctx.Err() != nil {
			return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "connector-owner")
		}
		return inspect(binding)
	})
}

// CheckVerificationChallenge is the no-IO preflight for trusted root before List.
// It validates only the exact current owner and its constructor challenge. It
// neither reserves an attempt nor grants authority to skip Begin or disclosure.
func (s *Service) CheckVerificationChallenge(ctx context.Context, digest [32]byte) error {
	return s.withVerificationCurrent(ctx, func(binding *port.TaskBinding) error {
		if binding == nil || s.launch.VerificationChallenge == ([32]byte{}) || digest != s.launch.VerificationChallenge {
			return failure()
		}
		return nil
	})
}

// BeginVerification reserves this owner's only attempt before root admits or
// dispatches List. Invalid challenge, scope or IDs do not consume the attempt.
// After reservation, even failed or uncertain IO stays fenced: no reset or replay.
func (s *Service) BeginVerification(ctx context.Context, digest [32]byte, workspaceID, callID string) error {
	return s.withVerificationCurrent(ctx, func(binding *port.TaskBinding) error {
		if binding == nil || s.launch.VerificationChallenge == ([32]byte{}) || digest != s.launch.VerificationChallenge || workspaceID == "" || callID == "" || s.verification != nil {
			return failure()
		}
		if _, ok := authority.FindScope(s.ceiling.Participant.Grant, workspaceID); !ok {
			return failure()
		}
		if _, ok := authority.FindApproved(s.ceiling.Approval, workspaceID); !ok {
			return failure()
		}
		s.verification = &verificationAttempt{workspaceID: workspaceID, callID: callID}
		return nil
	})
}

// RecordVerification is trusted-root-only. Root computes the challenge digest
// and calls after Begin and the exact reserved workspace List succeeded and its
// disclosure passed. Root must still apply the same lease's final disclosure to
// its response. This method does not execute or replay List, hash a
// challenge, read the journal, publish authority, or create an execution engine.
// An exact duplicate only observes the retained value; a different value refuses.
func (s *Service) RecordVerification(ctx context.Context, providedChallengeDigest [32]byte, observed port.ConnectorVerification) error {
	return s.withVerificationCurrent(ctx, func(binding *port.TaskBinding) error {
		challenge := s.launch.VerificationChallenge
		if binding == nil || challenge == ([32]byte{}) || providedChallengeDigest != challenge || observed.ChallengeDigest != challenge || observed.Host != s.launch.Host || observed.Binding != *binding || s.verification == nil || observed.WorkspaceID != s.verification.workspaceID || observed.CallID != s.verification.callID || observed.EntryCount > 500 {
			return failure()
		}
		if _, ok := authority.FindScope(s.ceiling.Participant.Grant, observed.WorkspaceID); !ok {
			return failure()
		}
		if _, ok := authority.FindApproved(s.ceiling.Approval, observed.WorkspaceID); !ok {
			return failure()
		}
		if s.verification.observation != nil {
			if *s.verification.observation != observed {
				return failure()
			}
			return nil
		}
		value := observed
		s.verification.observation = &value
		return nil
	})
}

// CurrentVerification returns an independent value only under this retained
// owner's current host guard. Never attempted or unsupported is nil. An attempt
// without completed proof is unavailable, including pending and unknown outcomes.
// Expired, withdrawn or unavailable owners refuse; no persisted cache is loaded.
func (s *Service) CurrentVerification(ctx context.Context) (*port.ConnectorVerification, error) {
	var out *port.ConnectorVerification
	err := s.withVerificationCurrent(ctx, func(binding *port.TaskBinding) error {
		if binding != nil && s.verification != nil {
			if s.verification.observation == nil {
				return failure()
			}
			value := *s.verification.observation
			out = &value
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

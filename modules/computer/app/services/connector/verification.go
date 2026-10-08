package connector

import (
	"context"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// A nil attempt means never attempted. Once reserved, a nil observation means
// pending, failed or outcome-unknown; none of those states permits another List.
type verificationAttempt struct {
	workspaceID, callID string
	observation         *port.ConnectorVerification
}

// withVerificationCurrent reads the sole access journal before entering the
// retained owner and host gates: AccessSnapshot -> owner -> guard. Callers must
// not already hold any of those gates. Current time-only approval may authorize
// a new verification or observation; the launch seal and one-shot attempt remain
// unchanged. Root still owns the original operation's fixed disclosure lease.
func (s *Service) withVerificationCurrent(ctx context.Context, inspect func(*port.TaskBinding) error) error {
	if s == nil || ctx == nil || inspect == nil {
		return failure()
	}
	if ctx.Err() != nil {
		return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "connector-owner")
	}
	// Zero challenge is unsupported, including existing source fixtures. It
	// cannot expose proof or reserve an attempt and needs no journal observation.
	if s.launch.VerificationChallenge == ([32]byte{}) {
		return s.WithCurrent(ctx, inspect)
	}
	calls := 0
	var result error
	err := s.journal.WithSnapshot(ctx, s.ceiling.Participant.ParticipantID, func(snapshot port.AccessSnapshot) (callbackErr error) {
		defer func() { result = callbackErr }()
		calls++
		if calls != 1 {
			return failure()
		}
		return s.WithCurrent(ctx, func(binding *port.TaskBinding) error {
			if binding == nil {
				return inspect(nil)
			}
			if snapshot.Participant == nil || !authority.SameParticipantCeiling(*snapshot.Participant, s.ceiling.Participant) {
				return authority.Fail("AUTHORITY_TASK_MISMATCH", "connector-owner")
			}
			if snapshot.Approval == nil || !authority.SameApprovalPolicy(*snapshot.Approval, s.ceiling.Approval) {
				return authority.Fail("AUTHORITY_COMPUTER_MISMATCH", "connector-owner")
			}
			now, expiry := s.clock.Now(), snapshot.Approval.ExpiresAt
			if now.UnixMilli() <= 0 || now.UnixMilli() > 9007199254740991 ||
				expiry.UnixMilli() <= 0 || expiry.UnixMilli() > 9007199254740991 ||
				!expiry.Equal(time.UnixMilli(expiry.UnixMilli())) || !now.Before(expiry) {
				return authority.Fail("AUTHORITY_EXPIRED", "connector-owner")
			}
			if ctx.Err() != nil {
				return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "connector-owner")
			}
			return inspect(binding)
		})
	})
	if err != nil {
		return classify(err)
	}
	if calls != 1 {
		return failure()
	}
	return result
}

// CheckVerificationChallenge is the current-journal preflight before List.
// It validates the exact current owner, sealed policy and constructor challenge. It
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
// challenge, publish authority, or create an execution engine. Current read
// authority is checked through the existing journal before recording the proof.
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
// owner's current host guard and same-policy current journal approval. Never
// attempted or unsupported is nil. An attempt
// without completed proof is unavailable, including pending and unknown outcomes.
// Current approval expiry, withdrawal or unavailability refuses; the historical
// launch expiry is not this read's authority. No persisted proof cache is loaded.
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

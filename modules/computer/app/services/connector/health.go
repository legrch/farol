package connector

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain"
)

// ObserveHealthQuery carries detached observations, never authority or trusted
// owner-stop, recovery or reconnecting state. Nil is an unobserved snapshot.
type ObserveHealthQuery struct {
	ExpectedInstanceID string
	Snapshot           *domain.ConnectionHealthSnapshot
}

// ObserveHealthResult is a detached presentation value. Recent transport does
// not establish an attachment, owner-command success or permission to retry.
type ObserveHealthResult struct {
	State, Reason              string
	ObservedAtMillis           *uint64
	ValidUntilMillis           *uint64
	LastPollSuccessMillis      *uint64
	LastResponseAcceptedMillis *uint64
	NextRetryMillis            *uint64
	LocalReady                 bool
}

func (s *Service) ObserveHealth(ctx context.Context, query ObserveHealthQuery) (*ObserveHealthResult, error) {
	if ctx == nil || s == nil || s.clock == nil {
		return nil, failure()
	}
	var result *ObserveHealthResult
	err := s.WithCurrent(ctx, func(binding *port.TaskBinding) error {
		if binding == nil {
			return failure()
		}
		now := s.clock.Now().UnixMilli()
		if ctx.Err() != nil || now <= 0 || uint64(now) > 1<<53-1 {
			return failure()
		}
		observed := domain.ObserveConnection(domain.ConnectionContext{
			NowMillis: uint64(now), Current: true, ExpectedInstanceID: query.ExpectedInstanceID,
		}, query.Snapshot)
		result = &ObserveHealthResult{
			State: string(observed.State), Reason: string(observed.Reason), LocalReady: observed.LocalReady,
			ObservedAtMillis:           healthCopyMillis(observed.ObservedAtMillis),
			ValidUntilMillis:           healthCopyMillis(observed.ValidUntilMillis),
			LastPollSuccessMillis:      healthCopyMillis(observed.LastPollSuccessMillis),
			LastResponseAcceptedMillis: healthCopyMillis(observed.LastResponseAcceptedMillis),
			NextRetryMillis:            healthCopyMillis(observed.NextRetryMillis),
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func healthCopyMillis(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

// ConfirmOwnerStop is for trusted root after the original endpoint close and
// withdrawal have both acknowledged. It cannot activate or republish this owner.
func (s *Service) ConfirmOwnerStop(ctx context.Context) error {
	if s == nil || ctx == nil || ctx.Err() != nil {
		return failure()
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if ctx.Err() != nil || s.phase != withdrawn || !s.withdrawalConfirmed {
		return failure()
	}
	s.ownerStopConfirmed = true
	return nil
}

// ObserveOwnerStoppedHealth reads only the original retired owner. Current
// consent, lifecycle cause and operation settlement are additionally fenced by
// root. This read has no journal IO and never enters positive WithCurrent.
func (s *Service) ObserveOwnerStoppedHealth(ctx context.Context, expectedInstanceID string) (*ObserveHealthResult, error) {
	if s == nil || ctx == nil || s.clock == nil || ctx.Err() != nil {
		return nil, failure()
	}
	s.gate.Lock()
	defer s.gate.Unlock()
	if ctx.Err() != nil || s.phase != withdrawn || !s.withdrawalConfirmed || !s.ownerStopConfirmed || expectedInstanceID != s.launch.Host.RuntimeID {
		return nil, failure()
	}
	now := s.clock.Now().UnixMilli()
	if ctx.Err() != nil || now <= 0 {
		return nil, failure()
	}
	observed := domain.ObserveOwnerStoppedConnection(uint64(now))
	if observed.State != domain.ConnectionStateStopped {
		return nil, failure()
	}
	return &ObserveHealthResult{
		State: string(observed.State), Reason: string(observed.Reason),
		ObservedAtMillis: healthCopyMillis(observed.ObservedAtMillis),
		ValidUntilMillis: healthCopyMillis(observed.ValidUntilMillis),
	}, nil
}

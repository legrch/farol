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

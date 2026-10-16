package connector

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
)

// ObservePollingQuery carries numeric helper reports only, never credentials,
// raw labels, URLs or an authority/attachment claim. Nil means unobserved.
type ObservePollingQuery struct {
	Cycles, Errors, LastSuccessMillis *uint64
}

type PollingState string

const (
	PollingUnknown   PollingState = "unknown"
	PollingRecent    PollingState = "recent"
	PollingStale     PollingState = "stale"
	PollingNoSuccess PollingState = "no_success"
)

// ObservePollingResult is a detached diagnostic observation. Recent means the
// helper reports a recent poll, never an external call or permission to retry.
type ObservePollingResult struct {
	State                      PollingState
	ObservedAtMillis           uint64
	Cycles, Errors, AgeSeconds *uint64
}

func pollingCopy(value *uint64) *uint64 {
	if value == nil {
		return nil
	}
	v := *value
	return &v
}

func (s *Service) ObservePolling(ctx context.Context, query ObservePollingQuery) (*ObservePollingResult, error) {
	if ctx == nil {
		return nil, failure()
	}
	const maximum = uint64(9007199254740991)
	for _, value := range []*uint64{query.Cycles, query.Errors, query.LastSuccessMillis} {
		if value != nil && *value > maximum {
			return nil, failure()
		}
	}
	var result *ObservePollingResult
	err := s.WithCurrent(ctx, func(binding *port.TaskBinding) error {
		if binding == nil {
			return failure()
		}
		now := s.clock.Now().UnixMilli()
		if ctx.Err() != nil || now <= 0 || uint64(now) > maximum {
			return failure()
		}
		observed := &ObservePollingResult{State: PollingUnknown, ObservedAtMillis: uint64(now), Cycles: pollingCopy(query.Cycles), Errors: pollingCopy(query.Errors)}
		if last := query.LastSuccessMillis; last != nil {
			switch {
			case *last == 0:
				observed.State = PollingNoSuccess
			case *last <= uint64(now):
				age := uint64(now) - *last
				seconds := age / 1000
				observed.AgeSeconds = &seconds
				if age <= 90000 {
					observed.State = PollingRecent
				} else {
					observed.State = PollingStale
				}
			}
		}
		result = observed
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

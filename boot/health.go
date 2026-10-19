package boot

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/modules/computer/domain"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

// Inherited host pipe only. Health observations do not publish authority, renew
// approval, verify a connector or change an unknown effect or its lifetime.
func (s *computerConnector) healthMethod() desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerConnectorHealthRequest", request.Body) != nil {
			return invalidIngress()
		}
		var input wire.ComputerConnectorHealthRequest
		if json.Unmarshal(request.Body, &input) != nil {
			return invalidIngress()
		}
		snapshot, err := healthSnapshot(input.Snapshot)
		if err != nil {
			return invalidIngress()
		}
		if err := s.enter(ctx); err != nil {
			return ingressOutcome(nil, err)
		}
		defer func() { <-s.effects }()
		slot := s.current
		if slot == nil || slot.closing || slot.startupUncertain || input.Binding != slot.opened.Endpoint.Binding {
			return ingressOutcome(nil, computerUnavailable())
		}
		observed, err := slot.owner.ObserveHealth(ctx, connectorsvc.ObserveHealthQuery{
			ExpectedInstanceID: input.ExpectedInstanceId, Snapshot: snapshot,
		})
		if err != nil {
			return ingressOutcome(nil, err)
		}
		var sampleAt *string
		if input.Snapshot != nil {
			sampleAt = healthString(input.Snapshot.SnapshotAtMillis)
		}
		return ingressOutcome(&wire.ComputerConnectorHealthState{
			Binding: input.Binding, ExpectedInstanceId: input.ExpectedInstanceId, SampleAtMillis: sampleAt,
			State: observed.State, Reason: observed.Reason, LocalReady: observed.LocalReady,
			ObservedAtMillis:           pollingDecimal(observed.ObservedAtMillis),
			ValidUntilMillis:           pollingDecimal(observed.ValidUntilMillis),
			LastPollSuccessMillis:      pollingDecimal(observed.LastPollSuccessMillis),
			LastResponseAcceptedMillis: pollingDecimal(observed.LastResponseAcceptedMillis),
			NextRetryMillis:            pollingDecimal(observed.NextRetryMillis),
		}, nil)
	}}
}

type healthUintField struct {
	input  string
	output *uint64
}
type healthOptionalUintField struct {
	input  *string
	output **uint64
}
type healthSecondsField struct {
	input  string
	output *float64
}

// Map every supplied component before observation, including optional details
// that cannot contribute a positive result. A failed conversion drops the read.
func healthSnapshot(input *wire.ComputerConnectorHealthSnapshot) (*domain.ConnectionHealthSnapshot, error) {
	if input == nil {
		return nil, nil
	}
	result := &domain.ConnectionHealthSnapshot{
		RuntimeInstanceID: input.RuntimeInstanceId, RuntimeLifecycle: input.RuntimeLifecycle,
		RuntimeLimited: input.RuntimeLimited, Live: input.Live, Ready: input.Ready, Truncated: input.Truncated,
	}
	unsigned := []healthUintField{
		{input.SnapshotAtMillis, &result.SnapshotAtMillis},
		{input.RuntimeStartedAtMillis, &result.RuntimeStartedAtMillis},
	}
	var optional []healthOptionalUintField
	var seconds []healthSecondsField
	if value := input.ControlPlane; value != nil {
		poll := &domain.ControlPlaneHealth{Status: value.Status, State: value.State, Limited: value.Limited}
		result.ControlPlane = poll
		optional = append(optional, healthOptionalUintField{value.ObservedAtMillis, &poll.ObservedAtMillis})
		if value := value.Details; value != nil {
			details := &domain.ControlPlaneHealthDetails{
				FailureCategory: healthOptionalString(value.FailureCategory), HTTPStatus: healthHTTPStatus(value.HttpStatus),
			}
			poll.Details = details
			unsigned = append(unsigned, healthUintField{value.ConsecutiveFailures, &details.ConsecutiveFailures})
			optional = append(optional,
				healthOptionalUintField{value.LastAttemptMillis, &details.LastAttemptMillis},
				healthOptionalUintField{value.LastSuccessMillis, &details.LastSuccessMillis},
				healthOptionalUintField{value.LastErrorMillis, &details.LastErrorMillis},
				healthOptionalUintField{value.NextRetryMillis, &details.NextRetryMillis},
			)
			seconds = append(seconds,
				healthSecondsField{value.CurrentPollAgeSeconds, &details.CurrentPollAgeSeconds},
				healthSecondsField{value.ConfiguredWaitSeconds, &details.ConfiguredWaitSeconds},
				healthSecondsField{value.EffectiveWaitSeconds, &details.EffectiveWaitSeconds},
				healthSecondsField{value.DeadlineSeconds, &details.DeadlineSeconds},
			)
		}
	}
	if value := input.ResponseDelivery; value != nil {
		delivery := &domain.ResponseDeliveryHealth{Status: value.Status, State: value.State, Limited: value.Limited}
		result.ResponseDelivery = delivery
		optional = append(optional, healthOptionalUintField{value.ObservedAtMillis, &delivery.ObservedAtMillis})
		if value := value.Details; value != nil {
			details := &domain.ResponseDeliveryHealthDetails{
				Disposition: value.Disposition, FailureCategory: healthOptionalString(value.FailureCategory), HTTPStatus: healthHTTPStatus(value.HttpStatus),
			}
			delivery.Details = details
			unsigned = append(unsigned,
				healthUintField{value.InProgress, &details.InProgress},
				healthUintField{value.Attempts, &details.Attempts},
				healthUintField{value.Retries, &details.Retries},
				healthUintField{value.Accepted, &details.Accepted},
				healthUintField{value.Completed, &details.Completed},
				healthUintField{value.TerminalFailures, &details.TerminalFailures},
			)
			optional = append(optional,
				healthOptionalUintField{value.LastAcceptedMillis, &details.LastAcceptedMillis},
				healthOptionalUintField{value.LastCompletedMillis, &details.LastCompletedMillis},
				healthOptionalUintField{value.LastFailureMillis, &details.LastFailureMillis},
			)
		}
	}
	for _, field := range unsigned {
		value, err := strconv.ParseUint(field.input, 10, 64)
		if err != nil {
			return nil, err
		}
		*field.output = value
	}
	for _, field := range optional {
		value, err := pollingValue(field.input)
		if err != nil {
			return nil, err
		}
		*field.output = value
	}
	for _, field := range seconds {
		value, err := strconv.ParseFloat(field.input, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return nil, errors.New("invalid connector health seconds")
		}
		*field.output = value
	}
	return result, nil
}

func healthString(value string) *string { return &value }
func healthOptionalString(value *string) *string {
	if value == nil {
		return nil
	}
	return healthString(*value)
}
func healthHTTPStatus(value *uint32) *uint64 {
	if value == nil {
		return nil
	}
	result := uint64(*value)
	return &result
}

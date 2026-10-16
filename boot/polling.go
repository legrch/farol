package boot

import (
	"context"
	"encoding/json"
	"strconv"

	wire "github.com/legrch/farol/gen/desktop/v1"
	connectorsvc "github.com/legrch/farol/modules/computer/app/services/connector"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func pollingValue(value *string) (*uint64, error) {
	if value == nil {
		return nil, nil
	}
	number, err := strconv.ParseUint(*value, 10, 64)
	if err != nil {
		return nil, err
	}
	return &number, nil
}
func pollingDecimal(value *uint64) *string {
	if value == nil {
		return nil
	}
	text := strconv.FormatUint(*value, 10)
	return &text
}

// Inherited host pipe only. The external connector endpoint never receives
// this diagnostic input surface. It changes no journal, proof or lifetime.
func (s *computerConnector) pollingMethod() desktop.Method {
	return desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		if request.OperationID != "" || ipc.ValidateJSON(request.Body) != nil || wire.Validate("ComputerConnectorPollingRequest", request.Body) != nil {
			return invalidIngress()
		}
		var input wire.ComputerConnectorPollingRequest
		if json.Unmarshal(request.Body, &input) != nil {
			return invalidIngress()
		}
		cycles, err := pollingValue(input.Samples.Cycles)
		if err != nil {
			return invalidIngress()
		}
		errors, err := pollingValue(input.Samples.Errors)
		if err != nil {
			return invalidIngress()
		}
		last, err := pollingValue(input.Samples.LastSuccessMillis)
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
		observed, err := slot.owner.ObservePolling(ctx, connectorsvc.ObservePollingQuery{Cycles: cycles, Errors: errors, LastSuccessMillis: last})
		if err != nil {
			return ingressOutcome(nil, err)
		}
		return ingressOutcome(&wire.ComputerConnectorPollingState{Binding: input.Binding, State: string(observed.State), ObservedAtMillis: strconv.FormatUint(observed.ObservedAtMillis, 10), Cycles: pollingDecimal(observed.Cycles), Errors: pollingDecimal(observed.Errors), AgeSeconds: pollingDecimal(observed.AgeSeconds)}, nil)
	}}
}

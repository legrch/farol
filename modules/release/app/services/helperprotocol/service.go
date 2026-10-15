// Package helperprotocol binds existing helper frame values to one parsed
// request. It performs no IO, readiness publication, continuation admission or
// journal effect. The effect owner must still use its original one-shot channel.
package helperprotocol

import (
	"context"

	"github.com/legrch/farol/modules/release/app/port"
)

const (
	HandoffSchema          = "farol.installed-update-handoff/1"
	ContinueSchema         = "farol.installed-update-continue/1"
	WaitingForExit         = "waiting_for_exit"
	ClosedPredecessorReady = "closed_predecessor_ready"
	Refused                = "refused"
)

// Internal keeps unexpected adapter failure distinct from a known refusal.
// Neither value settles an application effect or permits retry.
type Failure struct {
	Code     string
	Internal bool
}

func (f *Failure) Error() string { return f.Code }

func failure(code string) error { return &Failure{Code: code} }
func internal() error           { return &Failure{Code: "internal", Internal: true} }

type Service struct {
	request port.HelperRequest
	codec   port.HelperProtocolCodec
}

// Bind parses one captured request through the existing input owner. It retains
// independent optional values and no parser/input aliases. Trusted composition
// supplies non-panicking codec/parser ports without typed-nil implementations.
func Bind(ctx context.Context, input []byte, parser port.HelperRequestParser, codec port.HelperProtocolCodec) (*Service, error) {
	if ctx == nil || parser == nil || codec == nil {
		return nil, internal()
	}
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	if len(input) < 1 || len(input) > 8192 {
		return nil, failure("input")
	}
	request, err := parser.Parse(ctx, append([]byte(nil), input...))
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	if err != nil {
		switch err.Error() {
		case "input", "acceptance":
			return nil, failure(err.Error())
		case "canceled":
			return nil, failure("canceled")
		default:
			return nil, internal()
		}
	}
	bound := &Service{request: copyRequest(request), codec: codec}
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	return bound, nil
}

func copyRequest(r port.HelperRequest) port.HelperRequest {
	if r.Predecessor != nil {
		v := *r.Predecessor
		r.Predecessor = &v
	}
	if r.LeaseIdentity != nil {
		v := *r.LeaseIdentity
		r.LeaseIdentity = &v
	}
	if r.InstallLocation != nil {
		v := *r.InstallLocation
		r.InstallLocation = &v
	}
	return r
}

func (s *Service) ready(ctx context.Context) error {
	if s == nil || s.codec == nil || ctx == nil {
		return internal()
	}
	if ctx.Err() != nil {
		return failure("canceled")
	}
	return nil
}

// Request returns a value copy, not native custody or an effect capability.
func (s *Service) Request(ctx context.Context) (port.HelperRequest, error) {
	if err := s.ready(ctx); err != nil {
		return port.HelperRequest{}, err
	}
	return copyRequest(s.request), nil
}

func correlation(request port.HelperRequest) port.HelperCorrelation {
	r := copyRequest(request)
	return port.HelperCorrelation{OperationID: r.OperationID, Action: r.Action, Source: r.Source, Target: r.Target, PID: r.PID, ProcessStart: r.ProcessStart, Predecessor: r.Predecessor, LeaseIdentity: r.LeaseIdentity}
}

// BuildHandoff prepares values only. The caller must obtain all actual custody,
// process, journal and readiness evidence before one channel Emit. Building a
// frame or receiving nil here never claims ACK delivery or grants normal Quit.
func (s *Service) BuildHandoff(ctx context.Context, phase string, code *string) ([]byte, error) {
	if err := s.ready(ctx); err != nil {
		return nil, err
	}
	closed := s.request.Predecessor != nil
	switch phase {
	case WaitingForExit:
		if closed || code != nil || (s.request.Action == "recover" && !s.request.Relaunch) {
			return nil, failure("handoff_phase")
		}
	case ClosedPredecessorReady:
		if !closed || code != nil {
			return nil, failure("handoff_phase")
		}
	case Refused:
		if code == nil || !validCode(*code) {
			return nil, failure("handoff_phase")
		}
	default:
		return nil, failure("handoff_phase")
	}
	frame := port.HelperHandoffFrame{Schema: HandoffSchema, Phase: phase, Correlation: correlation(s.request)}
	if code != nil {
		v := *code
		frame.Error = &v
	}
	out, err := s.codec.Handoff(frame)
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	if err != nil {
		if err.Error() == "helper_protocol_size" {
			return nil, failure("handoff_size")
		}
		return nil, internal()
	}
	if len(out) > 4096 {
		return nil, failure("handoff_size")
	}
	if len(out) < 1 {
		return nil, internal()
	}
	frameBytes := append([]byte(nil), out...)
	if ctx.Err() != nil {
		return nil, failure("canceled")
	}
	return frameBytes, nil
}

// ValidateContinuation compares a complete EOF-sealed channel frame to this
// immutable request. It is repeatable value validation, not an effect admission
// or replay permit; the channel and existing journal owner consume the effect.
func (s *Service) ValidateContinuation(ctx context.Context, input []byte) error {
	if err := s.ready(ctx); err != nil {
		return err
	}
	if s.request.Predecessor == nil || s.request.LeaseIdentity == nil {
		return failure("continue_identity")
	}
	if len(input) > 4096 {
		return failure("continue_size")
	}
	if len(input) < 1 {
		return failure("continue_invalid")
	}
	frame, err := s.codec.Continue(append([]byte(nil), input...))
	if ctx.Err() != nil {
		return failure("canceled")
	}
	if err != nil {
		if err.Error() == "helper_protocol_size" {
			return failure("continue_size")
		}
		if err.Error() == "helper_protocol_input" {
			return failure("continue_invalid")
		}
		return internal()
	}
	if frame.Schema != ContinueSchema || !sameCorrelation(correlation(s.request), frame.Correlation) {
		return failure("continue_identity")
	}
	if ctx.Err() != nil {
		return failure("canceled")
	}
	return nil
}

func sameCorrelation(a, b port.HelperCorrelation) bool {
	if a.OperationID != b.OperationID || a.Action != b.Action || a.Source != b.Source || a.Target != b.Target || a.PID != b.PID || a.ProcessStart != b.ProcessStart {
		return false
	}
	if (a.Predecessor == nil) != (b.Predecessor == nil) || (a.LeaseIdentity == nil) != (b.LeaseIdentity == nil) {
		return false
	}
	if a.Predecessor != nil && *a.Predecessor != *b.Predecessor {
		return false
	}
	return a.LeaseIdentity == nil || *a.LeaseIdentity == *b.LeaseIdentity
}

func validCode(s string) bool {
	if len(s) < 1 || len(s) > 80 || s[0] < 'a' || s[0] > 'z' {
		return false
	}
	for _, c := range s[1:] {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}

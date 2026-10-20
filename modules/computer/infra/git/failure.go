package git

import (
	"context"
	"errors"
)

// Failure preserves the original cause for trusted inspection through Unwrap,
// but never renders arbitrary transport, hook, config or credential text.
// Adapters may disclose Code and the separately observed Result.Stage.
type Failure struct {
	code  string
	cause error
}

func (f *Failure) Error() string { return f.code }
func (f *Failure) Code() string  { return f.code }
func (f *Failure) Unwrap() error { return f.cause }

func classified(err error) error {
	if err == nil {
		return nil
	}
	code := ErrPort.Error()
	var ended contextEnded
	var owner ownerFailure
	var refusal scopeRefusal
	switch {
	case errors.As(err, &ended): // the run's own context ended: it is the cause
		code = "GIT_TRANSPORT_CANCELLED"
		if errors.Is(ended.err, context.DeadlineExceeded) {
			code = "GIT_TRANSPORT_DEADLINE"
		}
	case errors.As(err, &owner): // an owner fault is a port failure, whatever it wraps
	case errors.As(err, &refusal):
		code = ErrScope.Error()
	default:
		for _, known := range []error{ErrProtocol, ErrLimit, ErrSource, ErrRemote, ErrScope, ErrReplay} {
			if errors.Is(err, known) {
				code = known.Error()
				break
			}
		}
	}
	return &Failure{code: code, cause: err}
}

// contextEnded marks that the run's own context had ended when it returned;
// a context error from anywhere else does not claim cancellation.
type contextEnded struct{ err error }

func (e contextEnded) Error() string { return e.err.Error() }
func (e contextEnded) Unwrap() error { return e.err }

// scopeRefusal is a custody refusal (the owner returned ErrScope).
type scopeRefusal struct{ err error }

func (e scopeRefusal) Error() string { return e.err.Error() }
func (e scopeRefusal) Unwrap() error { return e.err }

// custodyFailure keeps a custody refusal SCOPE and makes any other custody
// error a port fault, whatever sentinel or context error it wraps.
func custodyFailure(err error) error {
	if err == nil {
		return nil
	}
	if err == ErrScope { // exactly the refusal sentinel; a wrapped one is a fault report
		return scopeRefusal{err}
	}
	return ownerFailure{err}
}

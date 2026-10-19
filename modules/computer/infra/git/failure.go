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
	for _, known := range []error{ErrProtocol, ErrLimit, ErrSource, ErrRemote, ErrScope, ErrReplay} {
		if errors.Is(err, known) {
			code = known.Error()
			break
		}
	}
	if errors.Is(err, context.DeadlineExceeded) {
		code = "GIT_TRANSPORT_DEADLINE"
	}
	if errors.Is(err, context.Canceled) {
		code = "GIT_TRANSPORT_CANCELLED"
	}
	return &Failure{code: code, cause: err}
}

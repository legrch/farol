package journal

import (
	"errors"

	"github.com/legrch/farol/modules/release/app/port"
)

// Preserve original native/admission causes for classification without exposing
// filesystem paths or private diagnostics in the repository's public error text.
type failure struct {
	code  port.JournalCode
	cause error
}

func (f *failure) Error() string {
	if f == nil {
		return port.JournalUnavailable.Error()
	}
	return f.code.Error()
}

func (f *failure) Unwrap() []error {
	if f == nil {
		return nil
	}
	return []error{f.code, f.cause}
}

func journalFailure(code port.JournalCode, causes ...error) error {
	return &failure{code: code, cause: errors.Join(causes...)}
}

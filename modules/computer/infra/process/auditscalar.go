package process

import (
	"errors"
	"log/slog"
	"regexp"

	"github.com/m-mizutani/masq"
)

// NewScalarFilter masks the complete scalar when a supported credential shape
// matches. It does not claim to recognize arbitrary secrets or personal data.
func NewScalarFilter() func(string) (string, error) {
	filter := masq.New(
		masq.WithRegex(regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9_]{20,}\b`)),
		masq.WithRegex(regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{20,}\b`)),
		masq.WithRegex(regexp.MustCompile(`\bAKIA[A-Z0-9]{16}\b`)),
	)
	return func(value string) (string, error) {
		result := filter(nil, slog.String("value", value))
		if result.Key != "value" || result.Value.Kind() != slog.KindString {
			return "", errors.New("audit_filter_invalid")
		}
		return result.Value.String(), nil
	}
}

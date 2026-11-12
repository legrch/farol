// Package transitionboot supplies the kernel boot-session identity to the
// Go transition owner. This metadata scalar is not a workspace grant, cannot
// be provided by an RPC caller and is never inferred from a Farol run-marker.
package boot

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

var ErrUnavailable = errors.New("WORKSPACE_BOOT_IDENTITY_UNAVAILABLE")
var pattern = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func canonical(raw string) (string, error) {
	// sysctl may return a terminal NUL, but no other embedded controls.
	value := strings.ToLower(strings.TrimSuffix(raw, "\x00"))
	if !pattern.MatchString(value) || value == "00000000-0000-0000-0000-000000000000" {
		return "", ErrUnavailable
	}
	return value, nil
}

type Reader struct{}

func New() *Reader { return &Reader{} }
func (*Reader) Current(ctx context.Context) (string, error) {
	if ctx == nil || ctx.Err() != nil {
		return "", ErrUnavailable
	}
	raw, err := readKernelBootUUID()
	if err != nil || ctx.Err() != nil {
		return "", ErrUnavailable
	}
	return canonical(raw)
}

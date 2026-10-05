//go:build !darwin && !linux

package results

import (
	"context"
	"github.com/legrch/farol/modules/chat/app/port"
)

func NewNative(ctx, lifetime context.Context, root Root, scope port.JournalScope, limits Limits, mode string) (*Native, error) {
	if !validResultComposition(ctx, lifetime, root, scope, limits, mode) {
		return nil, Invalid
	}
	return nil, Unavailable
}

package planresponses

import (
	"context"
	"math"
	"time"

	"github.com/legrch/farol/modules/chat/app/services/inference"
)

// OperationDeadline bounds credential, journal and HTTP ports by the original
// absolute operation deadline while preserving earlier caller cancellation.
type OperationDeadline struct{}

func (OperationDeadline) Limit(ctx context.Context, millis uint64) (context.Context, context.CancelFunc, error) {
	if ctx == nil || millis == 0 || millis > math.MaxInt64 || ctx.Err() != nil {
		return nil, nil, inference.Cancelled
	}
	deadline := time.UnixMilli(int64(millis))
	if !time.Now().Before(deadline) {
		return nil, nil, inference.Cancelled
	}
	bounded, cancel := context.WithDeadline(ctx, deadline)
	return bounded, cancel, nil
}

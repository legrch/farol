package filesystem

import (
	"context"
	"errors"
	"sync"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// A malformed/late guard cannot replay the publication callback or turn a lost
// acknowledgement into a clean refusal. The mutex also closes callbacks retained
// past return; it is attempt-local, never a second authority owner.
func withMutationPublication(ctx context.Context, request port.MutationRequest, walk *mutationWalk, publish func() error) (bool, error) {
	if request.WithPublication == nil {
		return false, refusal("WORKSPACE_PATH_REFUSED")
	}
	var mu sync.Mutex
	open, attempted, calls := true, false, 0
	var result error
	err := request.WithPublication(ctx, func() error {
		mu.Lock()
		defer mu.Unlock()
		if !open {
			return refusal("WORKSPACE_PATH_REFUSED")
		}
		calls++
		if calls != 1 {
			return refusal("WORKSPACE_PATH_REFUSED")
		}
		if ctx == nil || ctx.Err() != nil {
			result = refusal("WORKSPACE_MUTATION_CANCELLED")
		} else if result = walk.check(); result == nil {
			attempted = true
			result = publish()
		}
		return result
	})
	mu.Lock()
	defer mu.Unlock()
	open = false
	if calls == 1 && (err == nil && result == nil || result != nil && samePublicationFailure(err, result)) {
		return false, result
	}
	if attempted {
		return true, mutationError("MUTATION_OUTCOME_UNKNOWN")
	}
	if err != nil {
		return false, err
	}
	return false, refusal("WORKSPACE_PATH_REFUSED")
}

// Application guards can copy classified failures at their boundary. Require
// the exact code/source/retry tuple; a changed or lost result stays unknown.
func samePublicationFailure(err, result error) bool {
	if errors.Is(err, result) {
		return true
	}
	var actual, expected *authority.Failure
	return errors.As(err, &actual) && errors.As(result, &expected) && *actual == *expected
}

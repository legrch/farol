// Package admission maps selected published Chat/Task owners to Computer ports.
// It owns no admission, authority cache, lifecycle, journal or native operation.
package admission

import (
	"context"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

func unavailable() error {
	return authority.Fail("COMPUTER_AUTHORITY_STORE_UNAVAILABLE", "authority-store")
}
func cancelled() error {
	return authority.Fail("WORKSPACE_REQUEST_CANCELLED", "native-workspace")
}
func mismatch() error {
	return authority.Fail("AUTHORITY_TASK_MISMATCH", "task-grant")
}

// Inspection stays inside the selected published owner's synchronous gate.
// Nothing calls Computer here: its qualified snapshot must already enclose this
// callback. Each invocation has private protocol state, never a positive cache.
func inspectCurrent(ctx context.Context, inspect func(*port.TaskBinding) error,
	call func(func(*port.TaskBinding) error) error, classify func(error) error) error {
	if ctx == nil || inspect == nil {
		return unavailable()
	}
	if ctx.Err() != nil {
		return cancelled()
	}
	calls := 0
	var rejected, broken error
	err := call(func(binding *port.TaskBinding) error {
		calls++
		if calls != 1 {
			broken = unavailable()
			return broken
		}
		if ctx.Err() != nil {
			rejected = cancelled()
			return rejected
		}
		rejected = inspect(binding)
		return rejected
	})
	// Preserve an original consumer rejection, including unknown, even if a
	// broken owner swallows it or subsequently returns another failure.
	if rejected != nil {
		return rejected
	}
	if broken != nil {
		return broken
	}
	if err != nil {
		return classify(err)
	}
	if calls != 1 {
		return unavailable()
	}
	if ctx.Err() != nil {
		return cancelled()
	}
	return nil
}

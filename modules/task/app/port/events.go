package port

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

// EventJournal appends bounded metadata to the EXISTING operation atomically.
// Unknown publication fences writes; repeating an effect is never authorized.
// Events cannot change receipt, lineage, task admission, pending or result state.
type EventJournal interface {
	RecordEvent(context.Context, task.ExecutionEvent) error
}

// RetainedLookup is selected task-local read access to older dispatches. It never
// renews the old admission or provides another operation's execution capability.
type RetainedLookup interface {
	LookupRetained(context.Context, string) (*Operation, error)
}

// ObservedProvider binds metadata to the same actual dispatch/connection. The
// optional seam preserves existing providers and never dispatches a second turn.
type ObservedProvider interface {
	DispatchObserved(context.Context, Dispatch, func(task.Reference) error, func(context.Context, task.ExecutionEvent) error) (task.Receipt, error)
}

package port

import "context"

// TaskSourceModelSelection is the complete saved model binding, never authority.
type TaskSourceModelSelection struct {
	Harness, ModelAlias, Model, ConfigSHA256 string
	Effort                                   *string
}

type TaskSourceModelResolution struct {
	Status    string
	Selection *TaskSourceModelSelection
}

// TaskSourceModelResolver explicitly selects Codex using the existing policy
// owner. It performs no IO, retains no input and is concurrency safe. Trusted
// composition supplies non-panicking adapters, never typed nil pointers.
type TaskSourceModelResolver interface {
	ResolveTaskSourceModel(context.Context, []byte) (TaskSourceModelResolution, error)
}

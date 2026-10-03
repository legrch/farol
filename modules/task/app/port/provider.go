package port

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

// CodexClient is the selected existing server connection supplied to the Codex
// adapter. It does not start a second daemon. Saved project/worktree and model
// catalogue qualification remain in Authority/Supports, not caller inference.
// Every call is one-shot with its durable OperationID; controls require the exact
// Expected identity while Create records the newly issued lineage,
// and all progress callbacks must complete before return. Unknown is binding.
type CodexClient interface {
	Supports(context.Context, task.Binding) (task.Capabilities, error)
	Create(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Continue(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Message(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Cancel(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Observe(context.Context, task.Binding, task.Reference) (Observation, error)
}

// ClaudeHost is injected through the accepted owning native-process contract.
// Resume is a new exact-session invocation, never active steering or a copied
// background session. Capabilities reflect this selected host; Cancel is usable
// only with real supported identity/cleanup evidence. No alternate HOME/model,
// auth copying, latest-session lookup or retry is authorized by this port.
type ClaudeHost interface {
	Supports(context.Context, task.Binding) (task.Capabilities, error)
	Create(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Resume(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Cancel(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Observe(context.Context, task.Binding, task.Reference) (Observation, error)
}

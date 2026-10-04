package port

import (
	"context"

	"github.com/legrch/farol/modules/task/domain"
)

type Selection struct {
	Provider                                   task.Provider
	ProjectID, WorkspaceID, ModelAlias, Effort string
}

// Resolve must use approved saved-project/worktree routing and selected model catalogue.
// Recheck measures the same physical roots and current grant before disclosure/effects.
type Authority interface {
	Resolve(context.Context, Selection) (task.Binding, error)
	Recheck(context.Context, task.Binding) error
	// RecheckParent verifies trusted initiating-chat authority; caller IDs alone
	// never authorize delivery to another root task.
	RecheckParent(context.Context, task.Parent) error
}
type Snapshot struct {
	Task     task.Task
	Revision uint64
	Pending  string
}
type Operation struct {
	// Missing in old records means no native reservation proof. Omit zero keeps
	// their canonical bytes and intent fingerprints unchanged.
	Reservation task.NativeReservation `json:",omitzero"`
	Events      task.EventLog          `json:",omitzero"`
	Intent      task.Intent
	Lineage     task.Reference
	Receipt     task.Receipt
	Settled     bool
}
type Admission struct {
	Operation Operation
	Snapshot  Snapshot
	Claimed   bool
}

// Every mutation below is atomic and durable before returning success. Errors may
// follow publication. None authorize dispatch/replay. No timestamps/PID lock stealing.
// Admit compares revision, rejects a pending intention, binds global operation ID
// to the full intent digest, and serializes changes to one task. On Create it also
// reserves TaskID. Admit also persists the prepared Task.Admission atomically
// with the intention; for a continuation it preserves the old provider result.
// An existing identical operation is returned without claiming. Finish persists
// the final admission state with its receipt. Observe may close, never activate
// admission; revoked state cannot be overwritten by late completion.
// Progress extends only the pending operation's same-session lineage. For a new
// continuation its new turn does not overwrite old retained result identity.
// Finish stores the receipt and snapshot together and clears Pending only for a
// known/rejected outcome. Uncertain outcomes keep the mutation fence. Observe
// compares revision and exact dispatch reference; it must not settle Pending.
// Observe also retains terminal evidence by DispatchID before a later follow-up
// replaces the latest task view. A later running observation cannot overwrite it.
type Journal interface {
	Lookup(context.Context, string) (*Operation, error)
	Read(context.Context, string) (*Snapshot, error)
	Admit(context.Context, task.Intent, uint64, task.Task) (*Admission, error)
	Progress(context.Context, string, task.Reference) error
	Finish(context.Context, string, task.Receipt, task.Task) error
	Observe(context.Context, Snapshot, task.Task) error
}
type Dispatch struct {
	Intent  task.Intent
	Message string
}
type Observation struct {
	Reference task.Reference
	Lifecycle task.Lifecycle
	Result    string
}

// A selected provider never retries or falls back. Supports is selected-host
// capability/model evidence, not a CLI-version inference or permission grant.
// Rejected receipts attest no effect; otherwise report uncertainty. Dispatch must
// finish all progress callbacks before returning. Callback failure is binding.
type Provider interface {
	Supports(context.Context, task.Binding) (task.Capabilities, error)
	Dispatch(context.Context, Dispatch, func(task.Reference) error) (task.Receipt, error)
	Observe(context.Context, task.Binding, task.Reference) (Observation, error)
}

// Delivery addresses the initiating parent's exact thread/turn. A provider final
// result is not this acknowledgement. Unknown delivery cannot be re-sent.
type Delivery interface {
	Send(context.Context, task.Parent, string, task.Reference, string) (task.Receipt, error)
}

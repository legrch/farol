package port

import "context"

// DTOs belong to this consuming application boundary. Native adapters must map
// their full accepted manifest/journal and retain exact identity behind Handle.
type Archive struct {
	Handle  string
	Version string
	BuildID string
	SHA256  string
}

// Restored is an observed presentation state, not admission to dispatch. A
// measured rollback version can coexist with a live original apply helper.
type Restored struct {
	Archive         *Archive
	RollbackVersion string
	RecoveryVersion string
}

type Discovery struct{ Available bool }

type Action uint8

const (
	Apply Action = iota + 1
	Recover
	Rollback
)

type Decision uint8

const (
	Accepted Decision = iota + 1
	Blocked
	Unknown
)

type Handoff struct {
	Decision Decision
	Code     string
}

// Failure is an explicit classified refusal. Unclassified adapter errors remain
// uncertain at any boundary at which staging or dispatch may have occurred.
type Failure struct {
	Code             string
	RecoveryRequired *bool
}

func (f *Failure) Error() string { return f.Code }

type Clock interface{ NowMilliseconds() int64 }

type Runtime interface {
	// Reconcile observes/reverifies the same retained operation. No dispatch,
	// network replay, helper relaunch, or deletion of unknown journals is allowed.
	Reconcile(context.Context) (*Restored, error)
	Discover(context.Context) (*Discovery, error)
	// Download owns its durable intent and physical verification/cleanup.
	Download(context.Context) (*Archive, error)
	// Retain belongs to the issued durable operation, independent of caller
	// cancellation. Its original native cleanup budget must remain bounded; it
	// returns only after the ready record and extraction cleanup settle.
	Retain(Archive) error
	// Apply/Restore must acquire fresh native admission even when Reconcile
	// offered a measured rollback version. They hold it through durable intent
	// and helper ACK; a still-held original-helper lease cannot be bypassed.
	// Blocked means proven no dispatch with confirmed admission release;
	// Accepted means exact helper readiness, never installed acceptance. Runtime
	// retains the same child and admission through app exit/reconciliation,
	// independently of this service returning or closing.
	Apply(context.Context, Archive) (*Handoff, error)
	Restore(context.Context, Action) (*Handoff, error)
	// CancelPending is an immediate local signal, not a synchronous network
	// drain. It stops only this lifetime's network. It must not kill a helper
	// or prevent durable retention/cleanup of an already completed download.
	CancelPending()
}

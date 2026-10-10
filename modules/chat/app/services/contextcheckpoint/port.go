// Package contextcheckpoint composes bounded selection with original Chat source
// observations. It does not own a database, grant, dispatcher or compaction RPC.
package contextcheckpoint

import (
	"context"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
)

type Source interface {
	// Read must return original immutable events under current disclosure authority.
	// Completed-only/text-only catalogues cannot satisfy this complete-source port.
	Read(context.Context, contextbudget.Binding) (contextbudget.Source, error)
	// Check pins the SAME activation, account, model and exact source head. It
	// never re-admits an old lease or derives authority from a SourceRef.
	Check(context.Context, contextbudget.SourceRef) error
}
type Digester interface{ Digest([]byte) (string, error) }
type PublishRequest struct {
	Checkpoint contextbudget.Checkpoint
	Expected   contextbudget.SourceRef
	SHA256     string
}
type Publication struct {
	CheckpointID, OperationID, SHA256 string
	Source                            contextbudget.SourceRef
}

// CheckpointStore is a requested narrow extension of the existing checkpoint
// owner, not a new store implementation. Publish must atomically check the exact
// source head/current lease and record the operation once. Observe never writes,
// acknowledges delivery or turns an uncertain publication into retry permission.
// PublishRefused with a nil receipt is permitted only with proof of no write;
// every other external error is conservatively publication UNKNOWN.
// Observe nil,nil means proven absence of an operation, including admission or
// UNKNOWN intent. Uncertain/missing bookkeeping must return error, never absence.
type CheckpointStore interface {
	Publish(context.Context, PublishRequest) (*Publication, error)
	Observe(context.Context, string, string) (*PublishRequest, error)
}
type SummaryRequest struct {
	CheckpointID, OperationID string
	Source                    contextbudget.SourceRef
	PromptVersion             string
	Events                    []contextbudget.Event
}

// Optional summaries are untrusted data. A network implementation must provide
// its own accepted durable one-shot admission and observation semantics and
// separately approved provider usage. None is composed by this package.
type Summarizer interface {
	Summarize(context.Context, SummaryRequest) (*contextbudget.Summary, error)
}

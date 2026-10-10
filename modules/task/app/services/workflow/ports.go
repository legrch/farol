// Package workflow coordinates a finite plan over the existing Task owner.
// It owns no journal, provider loop, authority issuer, or ambient scheduler.
package workflow

import (
	"context"
	"errors"

	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

var (
	ErrInvalid     = errors.New("WORKFLOW_INPUT_INVALID")
	ErrUnknown     = errors.New("WORKFLOW_OUTCOME_UNKNOWN")
	ErrIdentity    = errors.New("WORKFLOW_IDENTITY_MISMATCH")
	ErrUnavailable = errors.New("WORKFLOW_UNAVAILABLE")
	ErrState       = errors.New("WORKFLOW_STATE_REFUSED")
)

type Reference struct{ SessionID, ThreadID, TurnID, InvocationID string }
type ReceiptState string

const (
	Known   ReceiptState = "known"
	Unknown ReceiptState = "outcome_unknown"
	Refused ReceiptState = "refused"
)

// Record comes from the original Task operation, not a latest-task guess.
// Found=false is allowed only after a known successful missing-operation query.
type Record struct {
	Found                       bool
	TaskID, OperationID, Action string
	State                       ReceiptState
	Outcome                     wf.State
	Reference                   Reference
	Output                      string
	CancelRequested             bool
}
type Selection struct{ Provider, ProjectID, WorkspaceID, ModelAlias, Effort string }
type Launch struct {
	TaskID, OperationID, Message string
	Selection                    Selection
	Parent                       wf.Parent
}

// Target binds controls/delivery to the workflow's original dispatch. The
// adapter must check it atomically inside the existing Task mutation owner;
// a read-then-mutate comparison alone cannot guard a concurrent continuation.
type Target struct {
	TaskID, OperationID, ExpectedDispatchID string
	Reference                               Reference
}
type Followup struct {
	TaskID, OperationID, ExpectedDispatchID, Message string
	Resume                                           bool
}
type Result struct {
	TaskID, DispatchID string
	Reference          Reference
	Outcome            wf.State
	Output             string
	Retained           bool
}

// Tasks is consumer-owned. Boot maps the published control DTO facade on the
// SAME selected Task service used by admission, observation and delivery.
// Read never calls a provider. Observe may observe only the exact known running
// operation through Task. Mutations retain Task's intention-before-effect fence.
type Tasks interface {
	Read(context.Context, string, string) (Record, error)
	Resolve(context.Context, Selection) (map[wf.Capability]bool, error)
	Create(context.Context, Launch) (Record, error)
	Observe(context.Context, string) (Result, error)
	Cancel(context.Context, Target) (Record, error)
	Deliver(context.Context, Target) (Record, error)
	Followup(context.Context, Followup) (Record, error)
}

// Composer supplies transient input, separately from content-free plan identity.
// Only dependency outputs already accepted by this service are exposed.
type Composer interface {
	Compose(context.Context, wf.Step, map[string]string) (Selection, string, error)
}

// Admission belongs to the trusted runtime. It rechecks the exact parent and
// serializes global resource reservations at the actual launch boundary. It
// must reject paused/closed parents and enforce capacity across simultaneous
// callers/workflows. A policy budget in Tick alone is not an authority grant.
// Do invokes the callback at most once; errors after invocation stay unknown.
// The runtime retains unknown reservations until supported reconciliation.
type Admission interface {
	Do(context.Context, wf.Parent, string, func() error) error
}

type Service struct {
	tasks     Tasks
	composer  Composer
	admission Admission
}

func New(tasks Tasks, composer Composer, admission Admission) (*Service, error) {
	if tasks == nil || composer == nil || admission == nil {
		return nil, ErrUnavailable
	}
	return &Service{tasks, composer, admission}, nil
}

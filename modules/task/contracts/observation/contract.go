// Package observation publishes bounded Task execution metadata and retained
// result/delivery facts. It never captures events, dispatches or grants authority.
package observation

import (
	"context"
	"errors"
	tasksvc "github.com/legrch/farol/modules/task/app/services/task"
	"github.com/legrch/farol/modules/task/domain"
)

type Reference struct{ SessionID, ThreadID, TurnID, InvocationID string }
type Cursor struct {
	StreamID             string
	Generation, Sequence uint64
}
type Request struct {
	TaskID, DispatchID, DeliveryOperationID string
	Cursor                                  Cursor
	Limit                                   int
	IncludeResult                           bool
}
type Event struct {
	RunID, DispatchID, EventID, StreamID                  string
	Generation, SourceSequence, Sequence, TimestampMillis uint64
	Kind, Source                                          string
	ReportedLifecycle                                     string
	Reference                                             Reference
	ItemID                                                string
	HasExitCode                                           bool
	ExitCode                                              int
	PlanSteps, CompletedSteps                             uint16
}
type Response struct {
	TaskID, DispatchID                          string
	Reference                                   Reference
	Events                                      []Event
	Next                                        Cursor
	Gap, More, SourceGap, Pending, Retained     bool
	Lifecycle, Result, ResultEvidence, Delivery string
}
type Failure struct{ Code string }

func (e *Failure) Error() string { return e.Code }

type Contract struct{ service *tasksvc.Service }

func New(service *tasksvc.Service) (*Contract, error) {
	if service == nil {
		return nil, &Failure{"TASK_UNAVAILABLE"}
	}
	return &Contract{service}, nil
}
func reference(r task.Reference) Reference {
	return Reference{r.SessionID, r.ThreadID, r.TurnID, r.InvocationID}
}
func (c *Contract) Read(ctx context.Context, req Request) (*Response, error) {
	if c == nil || c.service == nil {
		return nil, &Failure{"TASK_UNAVAILABLE"}
	}
	out, err := c.service.Execution(ctx, tasksvc.ExecutionRequest{TaskID: req.TaskID, DispatchID: req.DispatchID, DeliveryOperationID: req.DeliveryOperationID, Cursor: task.EventCursor{StreamID: req.Cursor.StreamID, Generation: req.Cursor.Generation, Sequence: req.Cursor.Sequence}, Limit: req.Limit, IncludeResult: req.IncludeResult})
	if err != nil {
		code := "TASK_OBSERVATION_UNKNOWN"
		switch {
		case errors.Is(err, task.ErrInvalid):
			code = "TASK_INPUT_INVALID"
		case errors.Is(err, task.ErrIdentity):
			code = "TASK_IDENTITY_MISMATCH"
		case errors.Is(err, task.ErrNotFound):
			code = "TASK_NOT_FOUND"
		case errors.Is(err, task.ErrState), errors.Is(err, task.ErrUnavailable), errors.Is(err, task.ErrUnsupported):
			code = "TASK_UNAVAILABLE"
		}
		return nil, &Failure{code}
	}
	result := &Response{TaskID: out.TaskID, DispatchID: out.DispatchID, Reference: reference(out.Reference), Next: Cursor{out.Page.Next.StreamID, out.Page.Next.Generation, out.Page.Next.Sequence}, Gap: out.Page.Gap, More: out.Page.More, SourceGap: out.SourceGap, Pending: out.Pending, Retained: out.Retained, Lifecycle: string(out.Lifecycle), Result: out.Result, ResultEvidence: out.ResultEvidence, Delivery: out.Delivery}
	for _, e := range out.Page.Events {
		result.Events = append(result.Events, Event{RunID: e.RunID, DispatchID: e.DispatchID, EventID: e.EventID, StreamID: e.StreamID, Generation: e.Generation, SourceSequence: e.SourceSequence, Sequence: e.Sequence, TimestampMillis: e.TimestampMillis, Kind: string(e.Kind), Source: string(e.Source), ReportedLifecycle: string(e.ReportedLifecycle), Reference: reference(e.Reference), ItemID: e.ItemID, HasExitCode: e.HasExitCode, ExitCode: e.ExitCode, PlanSteps: e.PlanSteps, CompletedSteps: e.CompletedSteps})
	}
	return result, nil
}

package task

import (
	"errors"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
)

func TestExecutionProjectionRetainsOldDispatchWithoutPollingOrDelivering(t *testing.T) {
	s, j, _, p, d := setup(task.Codex)
	create(t, s, task.Codex)
	if _, err := s.Status(ctx, StatusRequest{"task-1"}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", Limit: 2})
	if err != nil || !result.Retained || result.Result != "" || result.ResultEvidence != "task_journal" || result.Delivery != "not_observed" {
		t.Fatal(result, err)
	}
	reads := p.reads
	if _, err := s.Deliver(ctx, DeliverRequest{"delivery", "task-1"}); err != nil {
		t.Fatal(err)
	}
	result, err = s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", DeliveryOperationID: "delivery", IncludeResult: true, Limit: 2})
	if err != nil || result.Delivery != "acknowledged" || result.Result != "final" || p.reads != reads || d.calls != 1 {
		t.Fatal(result, err)
	}
	snapshot := j.tasks["task-1"]
	snapshot.Task.Reference = reference(task.Codex, "turn-2")
	snapshot.Task.DispatchID = "later"
	snapshot.Task.Result = ""
	snapshot.Task.Lifecycle = task.Running
	j.tasks["task-1"] = snapshot
	result, err = s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", IncludeResult: true, Limit: 2})
	if err != nil || result.Reference.TurnID != "turn-1" || result.Result != "final" || p.reads != reads {
		t.Fatal(result, err)
	}
}
func TestExecutionRejectsForeignAndRevokedAndNeverTrustsTerminalNotification(t *testing.T) {
	s, j, a, p, _ := setup(task.Codex)
	create(t, s, task.Codex)
	op := j.ops["create-1"]
	e := task.ExecutionEvent{RunID: "task-1", DispatchID: "create-1", EventID: "terminal", StreamID: "stream", Generation: 1, SourceSequence: 1, TimestampMillis: 100, Kind: task.ProviderTerminal, Source: task.RuntimeEvidence, Reference: op.Lineage, ReportedLifecycle: task.Completed}
	op.Events, _ = op.Events.Append(e, task.Codex)
	j.ops["create-1"] = op
	result, err := s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", Limit: 2})
	if err != nil || result.Retained || result.Lifecycle != task.Running || p.reads != 0 {
		t.Fatal("notification became terminal", result, err)
	}
	if _, err := s.Execution(ctx, ExecutionRequest{TaskID: "other", DispatchID: "create-1", Limit: 2}); !errors.Is(err, task.ErrNotFound) {
		t.Fatal(err)
	}
	a.denied = true
	if _, err := s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", Limit: 2}); err == nil {
		t.Fatal("revoked disclosure")
	}
}
func TestRetainedResultDoesNotInventParentAckFromRejectedDelivery(t *testing.T) {
	s, _, _, _, d := setup(task.Codex)
	create(t, s, task.Codex)
	s.Status(ctx, StatusRequest{"task-1"})
	d.receipt = task.Receipt{State: task.Rejected, Code: "PARENT_REFUSED"}
	if _, err := s.Deliver(ctx, DeliverRequest{"delivery", "task-1"}); err != nil {
		t.Fatal(err)
	}
	result, err := s.Execution(ctx, ExecutionRequest{TaskID: "task-1", DispatchID: "create-1", DeliveryOperationID: "delivery", Limit: 2})
	if err != nil || !result.Retained || result.Delivery != "refused" {
		t.Fatal(result, err)
	}
}

func TestLateMetadataChecksAuthorityWithoutChangingTerminalResult(t *testing.T) {
	s, j, a, _, _ := setup(task.Codex)
	create(t, s, task.Codex)
	s.Status(ctx, StatusRequest{"task-1"})
	op := j.ops["create-1"]
	e := task.ExecutionEvent{RunID: "task-1", DispatchID: "create-1", EventID: "late", StreamID: "stream", Generation: 1, SourceSequence: 1, TimestampMillis: 100, Kind: task.ToolStarted, Source: task.RuntimeEvidence, Reference: op.Receipt.Reference, ItemID: "item"}
	if err := s.RecordExecution(ctx, e); err != nil {
		t.Fatal(err)
	}
	if len(j.ops["create-1"].Events.Events) != 0 || j.ops["create-1"].Receipt != op.Receipt {
		t.Fatal("late event changed terminal evidence")
	}
	a.denied = true
	if err := s.RecordExecution(ctx, e); err == nil {
		t.Fatal("late event bypassed revoked authority")
	}
}

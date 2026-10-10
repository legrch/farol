//go:build darwin || linux

package workflow_test

import (
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/workflow"
	task "github.com/legrch/farol/modules/task/domain"
)

func TestTraceLateCompletionCannotRepairPrematureRequestWitness(t *testing.T) {
	owner := newTracePlanOwner(t)
	f := newTraceComposition(t, owner)
	selection := app.Selection{Provider: "codex", ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}
	// Deliberately bypass workflow policy through the actual Task DTO consumer.
	// Task does not own this DAG: this is a bad scheduling counterexample for
	// the transient oracle, not a consumer defect or a shipping integration.
	if _, err := f.tasks.Create(testContext, app.Launch{TaskID: "task-c", OperationID: "create-c", Message: "A+B", Selection: selection, Parent: f.plan.Parent}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"a", "b"} {
		output := "A"
		if id == "b" {
			output = "B"
		}
		f.provider.immediate["task-"+id] = port.Observation{Lifecycle: task.Completed, Result: output}
		if _, err := f.tasks.Create(testContext, app.Launch{TaskID: "task-" + id, OperationID: "create-" + id, Message: output, Selection: selection, Parent: f.plan.Parent}); err != nil {
			t.Fatal(err)
		}
		op, err := f.journal.Lookup(testContext, "create-"+id)
		if err != nil || op == nil || !op.Settled || op.Receipt.State != task.Known || op.Receipt.Lifecycle != task.Completed {
			t.Fatalf("counterexample's later completion absent: %+v %v", op, err)
		}
	}
	if n, valid := f.trace.validRequests(); n != 1 || valid || countTraceEffects(f).provider["create-c"] != 1 {
		t.Fatalf("oracle accepted later completion as prior admission: requests=%d valid=%t effects=%+v", n, valid, countTraceEffects(f))
	}
}

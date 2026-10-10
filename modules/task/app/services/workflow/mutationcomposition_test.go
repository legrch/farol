//go:build darwin || linux

package workflow_test

import (
	"context"
	"reflect"
	"testing"

	app "github.com/legrch/farol/modules/task/app/services/workflow"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

type mutateCompositionRead struct {
	app.Tasks
	change func()
}

func (p *mutateCompositionRead) Read(ctx context.Context, taskID, operationID string) (app.Record, error) {
	if p.change != nil {
		change := p.change
		p.change = nil
		change()
	}
	return p.Tasks.Read(ctx, taskID, operationID)
}

func TestCompositionCapturedIdentitySurvivesPortYieldAndJournalReopen(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a", "b"}
	original, err := wf.Capture(p)
	if err != nil {
		t.Fatal(err)
	}
	f := newComposition(t, original)
	available := map[wf.Capability]bool{wf.CapabilityCreate: true}
	ports := &mutateCompositionRead{Tasks: f.tasks, change: func() {
		p.Steps[0].OperationID = "changed-create"
		p.Steps[1].ID = "changed-step"
		p.Steps[2].Dependencies[0] = "changed-dependency"
		available[wf.CapabilityCreate] = false
	}}
	service, err := app.New(ports, f.composer, f.admission)
	if err != nil {
		t.Fatal(err)
	}
	r, err := service.Tick(testContext, p, wf.Budget{Slots: 2, Available: available}, app.AdmitNew)
	if err != nil || !reflect.DeepEqual(r.Started, []string{"a", "b"}) || len(f.provider.dispatches) != 2 || f.provider.dispatches[0].Intent.OperationID != "create-a" {
		t.Fatalf("mutated identity entered actual Task: report=%+v dispatch=%+v err=%v", r, f.provider.dispatches, err)
	}
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.provider.settle("task-b", "create-b", task.Completed, "B")
	f.reopen() // Trusted owner supplies the original captured plan, not changed caller data.
	r = f.tick(2, app.AdmitNew)
	if !reflect.DeepEqual(r.Started, []string{"c"}) || len(f.provider.dispatches) != 3 || f.provider.dispatches[2].Message != "A+B" {
		t.Fatalf("reopen lost captured Task lineage: %+v", r)
	}
}

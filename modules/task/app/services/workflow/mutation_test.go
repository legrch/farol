package workflow

import (
	"context"
	"reflect"
	"testing"

	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

type mutateAtRead struct {
	*scripted
	change func()
}

func (f *mutateAtRead) Read(ctx context.Context, taskID, op string) (Record, error) {
	if f.change != nil {
		change := f.change
		f.change = nil
		change()
	}
	return f.scripted.Read(ctx, taskID, op)
}

type mutateComposer struct{}

func (mutateComposer) Compose(ctx context.Context, step wf.Step, deps map[string]string) (Selection, string, error) {
	if len(step.Required) != 0 {
		step.Required[0] = wf.CapabilityResume
	}
	return inputs{}.Compose(ctx, step, deps)
}

func TestCaptureCallerPlanAndBudgetBeforeFirstPortCall(t *testing.T) {
	p := smallPlan()
	b := budget(2)
	f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"a": true, "b": true}}
	ports := &mutateAtRead{scripted: f, change: func() {
		p.Steps[1].ID = "changed"
		p.Steps[1].OperationID = "changed-create"
		p.Steps[1].Dependencies = []string{"a"}
		b.Available[wf.CapabilityCreate] = false
	}}
	s, err := New(ports, inputs{}, guard{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Tick(context.Background(), p, b, AdmitNew)
	if err != nil || !reflect.DeepEqual(f.effects, []string{"create-a", "create-b"}) || out.Steps[1].StepID != "b" || out.Steps[1].OperationID != "create-b" {
		t.Fatalf("caller mutation crossed captured boundary: report=%+v effects=%v err=%v", out, f.effects, err)
	}
}

func TestComposerCannotMutateCapturedRequiredCapabilities(t *testing.T) {
	p := smallPlan()
	p.Steps[0].Required = []wf.Capability{wf.CapabilityCreate}
	f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"a": true, "b": true}}
	s, err := New(f, mutateComposer{}, guard{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.Tick(context.Background(), p, budget(1), AdmitNew)
	if err != nil || !reflect.DeepEqual(f.effects, []string{"create-a"}) || p.Steps[0].Required[0] != wf.CapabilityCreate {
		t.Fatalf("composer mutation altered policy/caller: report=%+v effects=%v required=%v err=%v", out, f.effects, p.Steps[0].Required, err)
	}
}

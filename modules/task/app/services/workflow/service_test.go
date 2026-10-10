package workflow

import (
	"context"
	"errors"
	"reflect"
	"testing"

	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

// These bounded boundary tests complement the real Task composition tests.
// They prove no native provider, persistence or runtime admission behavior.
type scripted struct {
	records             map[string]Record
	missing             bool
	resolves            map[string]bool
	effects             []string
	observed            Result
	readErr, observeErr error
}

func (f *scripted) Read(_ context.Context, _, op string) (Record, error) {
	if f.readErr != nil {
		return Record{}, f.readErr
	}
	return f.records[op], nil
}
func (f *scripted) Resolve(_ context.Context, s Selection) (map[wf.Capability]bool, error) {
	return map[wf.Capability]bool{wf.CapabilityCreate: f.resolves[s.ProjectID]}, nil
}
func (f *scripted) Create(_ context.Context, r Launch) (Record, error) {
	f.effects = append(f.effects, r.OperationID)
	out := Record{Found: true, TaskID: r.TaskID, OperationID: r.OperationID, Action: "create", State: Known, Outcome: wf.Running, Reference: Reference{ThreadID: r.TaskID, TurnID: r.OperationID}}
	f.records[r.OperationID] = out
	return out, nil
}
func (f *scripted) Observe(context.Context, string) (Result, error) { return f.observed, f.observeErr }
func (f *scripted) Cancel(context.Context, Target) (Record, error) {
	panic("unexpected cancellation")
}
func (f *scripted) Deliver(context.Context, Target) (Record, error) {
	panic("unexpected delivery")
}
func (f *scripted) Followup(context.Context, Followup) (Record, error) { panic("unexpected followup") }

type inputs struct{}

func (inputs) Compose(_ context.Context, s wf.Step, _ map[string]string) (Selection, string, error) {
	return Selection{Provider: "codex", ProjectID: s.ID}, "synthetic input", nil
}

type guard struct{ deny, twice bool }

func (g guard) Do(_ context.Context, _ wf.Parent, _ string, call func() error) error {
	if g.deny {
		return ErrState
	}
	if err := call(); err != nil {
		return err
	}
	if g.twice {
		return call()
	}
	return nil
}
func smallPlan() wf.Plan {
	return wf.Plan{ID: "plan", Parent: wf.Parent{ThreadID: "parent", TurnID: "turn"}, Steps: []wf.Step{{ID: "a", TaskID: "task-a", OperationID: "create-a", CancelOperationID: "cancel-a", DeliveryOperationID: "deliver-a", Output: wf.Output{Kind: wf.OutputText, MaxBytes: 64}}, {ID: "b", TaskID: "task-b", OperationID: "create-b", CancelOperationID: "cancel-b", DeliveryOperationID: "deliver-b", Output: wf.Output{Kind: wf.OutputText, MaxBytes: 64}}}}
}
func budget(slots int) wf.Budget {
	return wf.Budget{Slots: slots, Available: map[wf.Capability]bool{wf.CapabilityCreate: true}}
}
func serviceFor(t *testing.T, f *scripted, g guard) *Service {
	t.Helper()
	s, err := New(f, inputs{}, g)
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func TestUnavailableSelectedProviderCannotStarveLaterIndependentStep(t *testing.T) {
	f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"b": true}}
	out, err := serviceFor(t, f, guard{}).Tick(context.Background(), smallPlan(), budget(1), AdmitNew)
	if err != nil || !reflect.DeepEqual(f.effects, []string{"create-b"}) || out.Steps[0].State != wf.Unavailable || out.Steps[1].State != wf.Running {
		t.Fatalf("out=%+v effects=%v err=%v", out, f.effects, err)
	}
}
func TestObservationOnlyMissingChildAndZeroOrClosedBudgetNeverDispatch(t *testing.T) {
	for _, mode := range []Mode{Reconnect, AdmitNew} {
		for _, b := range []wf.Budget{budget(0), {Slots: 2, ParentClosed: true, Available: budget(2).Available}, {Slots: 2, Paused: true, Available: budget(2).Available}} {
			f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"a": true, "b": true}}
			out, err := serviceFor(t, f, guard{}).Tick(context.Background(), smallPlan(), b, mode)
			if err != nil || len(f.effects) != 0 {
				t.Fatalf("out=%+v effects=%v err=%v", out, f.effects, err)
			}
			if mode == Reconnect && out.Steps[0].State != wf.Unknown {
				t.Fatal("missing restored child became ready")
			}
		}
	}
}
func TestAdmissionRefusalOrRepeatedCallbackCannotProduceExtraEffects(t *testing.T) {
	for _, g := range []guard{{deny: true}, {twice: true}} {
		f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"a": true, "b": true}}
		out, err := serviceFor(t, f, g).Tick(context.Background(), smallPlan(), budget(1), AdmitNew)
		if err != nil {
			t.Fatal(err)
		}
		if g.deny && len(f.effects) != 0 {
			t.Fatal("effect after refusal")
		}
		if g.twice && (len(f.effects) != 1 || out.Steps[0].State != wf.Unknown) {
			t.Fatalf("duplicate callback: %+v %v", out, f.effects)
		}
	}
}
func TestUncertainForeignAndMalformedRecordsDoNotDispatchOrFeedSuccessors(t *testing.T) {
	for _, r := range []Record{
		{Found: true, TaskID: "task-a", OperationID: "create-a", Action: "create", State: Unknown},
		{Found: true, TaskID: "other", OperationID: "create-a", Action: "create", State: Known, Outcome: wf.Completed, Output: "value", Reference: Reference{ThreadID: "thread", TurnID: "turn"}},
		{Found: true, TaskID: "task-a", OperationID: "create-a", Action: "create", State: Known, Outcome: wf.Completed, Output: "value"},
	} {
		f := &scripted{records: map[string]Record{"create-a": r}, resolves: map[string]bool{"a": true, "b": true}}
		p := smallPlan()
		p.Steps[1].Dependencies = []string{"a"}
		out, err := serviceFor(t, f, guard{}).Tick(context.Background(), p, budget(2), AdmitNew)
		if err != nil || len(f.effects) != 0 || out.Steps[0].State != wf.Unknown || out.Steps[0].Accepted {
			t.Fatalf("out=%+v effects=%v err=%v", out, f.effects, err)
		}
	}
}
func TestResultMustMatchExactDispatchAndRetainedOperation(t *testing.T) {
	r := Record{Found: true, TaskID: "task-a", OperationID: "create-a", Action: "create", State: Known, Outcome: wf.Running, Reference: Reference{ThreadID: "thread", TurnID: "turn"}}
	for _, response := range []Result{
		{TaskID: "task-a", DispatchID: "old-epoch", Outcome: wf.Completed, Reference: r.Reference, Output: "value", Retained: true},
		{TaskID: "task-a", DispatchID: "create-a", Outcome: wf.Completed, Reference: Reference{ThreadID: "thread", TurnID: "old-turn"}, Output: "value", Retained: true},
		{TaskID: "task-a", DispatchID: "create-a", Outcome: wf.Completed, Reference: r.Reference, Output: "value", Retained: true},
	} {
		f := &scripted{records: map[string]Record{"create-a": r}, resolves: map[string]bool{"b": true}, observed: response}
		p := smallPlan()
		p.Steps[1].Dependencies = []string{"a"}
		out, err := serviceFor(t, f, guard{}).Tick(context.Background(), p, budget(2), AdmitNew)
		if err != nil || len(f.effects) != 0 || out.Steps[0].State != wf.Unknown {
			t.Fatalf("wrong result accepted %+v %v", out, err)
		}
	}
}
func TestBoundaryReadFailuresRemainUnknownAndContextCancellationStopsEffects(t *testing.T) {
	f := &scripted{records: map[string]Record{}, resolves: map[string]bool{"a": true, "b": true}, readErr: errors.New("private diagnostics")}
	out, err := serviceFor(t, f, guard{}).Tick(context.Background(), smallPlan(), budget(12), AdmitNew)
	if err != nil || len(f.effects) != 0 || out.Steps[0].State != wf.Unknown || out.Steps[0].Delivery != DeliveryUnknown {
		t.Fatalf("read failure %+v %v", out, err)
	}
	c, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := serviceFor(t, f, guard{}).Tick(c, smallPlan(), budget(12), AdmitNew); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
}

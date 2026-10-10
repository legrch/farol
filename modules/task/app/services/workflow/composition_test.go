//go:build darwin || linux

package workflow_test

import (
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	app "github.com/legrch/farol/modules/task/app/services/workflow"
	"github.com/legrch/farol/modules/task/contracts/control"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

func TestCompositionIndependentThenAggregateAndSeparateParentACK(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a", "b"}
	f := newComposition(t, p)
	first := f.tick(2, app.AdmitNew)
	if !reflect.DeepEqual(first.Started, []string{"a", "b"}) || len(f.provider.dispatches) != 2 {
		t.Fatalf("first round: %+v dispatches=%d", first, len(f.provider.dispatches))
	}
	if len(f.delivery.sends) != 0 {
		t.Fatal("dispatch fabricated parent delivery")
	}
	// B finishes first. A's unaccepted output cannot enter the aggregation.
	f.provider.settle("task-b", "create-b", task.Completed, "B")
	second := f.tick(2, app.AdmitNew)
	if len(second.Started) != 0 || !progress(t, second, "b").Accepted || progress(t, second, "a").Accepted {
		t.Fatalf("out of order result: %+v", second)
	}
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	third := f.tick(2, app.AdmitNew)
	if !reflect.DeepEqual(third.Started, []string{"c"}) || len(f.provider.dispatches) != 3 || f.provider.dispatches[2].Message != "A+B" {
		t.Fatalf("aggregation: %+v dispatches=%+v", third, f.provider.dispatches)
	}
	if progress(t, third, "a").Delivery != app.DeliveryPending || len(f.delivery.sends) != 0 {
		t.Fatal("terminal task was treated as delivered")
	}
	f.provider.settle("task-c", "create-c", task.Completed, "A+B")
	fourth := f.tick(2, app.Reconnect)
	if !progress(t, fourth, "c").Accepted {
		t.Fatalf("aggregation did not settle: %+v", fourth)
	}
	delivered, err := f.workflow.Deliver(testContext, p)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.delivery.sends) != 3 {
		t.Fatalf("sends=%+v", f.delivery.sends)
	}
	for _, row := range delivered.Steps {
		if row.Delivery != app.DeliveryAcknowledged {
			t.Fatalf("delivery state: %+v", delivered)
		}
	}
	for _, send := range f.delivery.sends {
		if send.parent != (task.Parent{ThreadID: p.Parent.ThreadID, TurnID: p.Parent.TurnID}) {
			t.Fatalf("incorrect parent: %+v", send)
		}
	}
	f.reopen()
	reads := f.provider.reads
	for range 3 {
		r := f.tick(2, app.AdmitNew)
		if len(r.Started) != 0 || !progress(t, r, "c").Accepted {
			t.Fatalf("reconnect: %+v", r)
		}
		if _, err := f.workflow.Deliver(testContext, p); err != nil {
			t.Fatal(err)
		}
	}
	if len(f.provider.dispatches) != 3 || len(f.delivery.sends) != 3 || f.provider.reads != reads {
		t.Fatal("restored completed work repeated an effect or provider observation")
	}
}

func TestCompositionLostDispatchACKNeverRedispatches(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.provider.lostDispatchACK["task-a"] = true
	initial := f.tick(1, app.AdmitNew)
	if progress(t, initial, "a").State != wf.Unknown || len(f.provider.dispatches) != 1 {
		t.Fatalf("lost ACK: %+v", initial)
	}
	// The provider could have completed, but a lost dispatch ACK leaves the
	// original intention pending. Even terminal-looking provider state is no grant.
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.reopen()
	for range 3 {
		if r := f.tick(1, app.AdmitNew); len(r.Started) != 0 || progress(t, r, "a").State != wf.Unknown {
			t.Fatalf("replay after ambiguity: %+v", r)
		}
	}
	if len(f.provider.dispatches) != 1 || f.provider.reads != 0 {
		t.Fatalf("dispatch=%d observation=%d", len(f.provider.dispatches), f.provider.reads)
	}
	snap, err := f.journal.Read(testContext, "task-a")
	if err != nil || snap.Pending != "create-a" {
		t.Fatalf("durable fence: %+v %v", snap, err)
	}
	var active bool
	if err := f.tasks.children["task-a"].route.WithCurrent(testContext, func(b *port.CurrentBinding) error { active = b != nil; return nil }); err != nil || active {
		t.Fatalf("reconstructed owner restored authority: active=%t err=%v", active, err)
	}
}

func TestCompositionCrashAfterDurableIntentBeforeProviderRequest(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.faults.admit = true
	if r := f.tick(1, app.AdmitNew); progress(t, r, "a").State != wf.Unknown {
		t.Fatalf("lost admit: %+v", r)
	}
	if len(f.provider.dispatches) != 0 {
		t.Fatal("provider called after lost admission ACK")
	}
	f.reopen()
	for _, mode := range []app.Mode{app.Reconnect, app.AdmitNew} {
		if r := f.tick(1, mode); len(r.Started) != 0 || progress(t, r, "a").State != wf.Unknown {
			t.Fatalf("reconstructed intention: %+v", r)
		}
	}
	if len(f.provider.dispatches) != 0 {
		t.Fatal("reconstruction dispatched pending intent")
	}
	snap, err := f.journal.Read(testContext, "task-a")
	if err != nil || snap.Pending != "create-a" {
		t.Fatalf("pending intention disappeared: %+v %v", snap, err)
	}
}

func TestCompositionLostFinishACKRetainsTerminalAcrossReconstruction(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.provider.immediate["task-a"] = port.Observation{Lifecycle: task.Completed, Result: "A"}
	f.faults.finish = true
	if r := f.tick(1, app.AdmitNew); progress(t, r, "a").State != wf.Unknown {
		t.Fatalf("outward finish ACK: %+v", r)
	}
	f.reopen()
	if r := f.tick(1, app.AdmitNew); !progress(t, r, "a").Accepted || len(r.Started) != 0 {
		t.Fatalf("durable terminal: %+v", r)
	}
	if len(f.provider.dispatches) != 1 || f.provider.reads != 0 {
		t.Fatal("retained terminal replayed provider")
	}
}

func TestCompositionLostObservationACKRetainsOriginalTerminal(t *testing.T) {
	p := fixturePlan("a", "c")
	p.Steps[1].Dependencies = []string{"a"}
	f := newComposition(t, p)
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.faults.observe = true
	if r := f.tick(1, app.AdmitNew); progress(t, r, "a").State != wf.Unknown || len(r.Started) != 0 {
		t.Fatalf("lost result ACK prematurely aggregated: %+v", r)
	}
	f.reopen()
	if r := f.tick(1, app.AdmitNew); !progress(t, r, "a").Accepted || !reflect.DeepEqual(r.Started, []string{"c"}) {
		t.Fatalf("retained original result: %+v", r)
	}
	if len(f.provider.dispatches) != 2 || f.provider.dispatches[1].Message != "A" {
		t.Fatalf("wrong aggregate: %+v", f.provider.dispatches)
	}
}

func TestCompositionLostDeliveryACKKeepsFenceAndNeverResends(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	f.delivery.lostACK = true
	r, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	if progress(t, r, "a").Delivery != app.DeliveryUnknown || !progress(t, r, "a").Accepted {
		t.Fatalf("child completion/delivery conflated: %+v", r)
	}
	f.reopen()
	for range 3 {
		r, err = f.workflow.Deliver(testContext, f.plan)
		if err != nil {
			t.Fatal(err)
		}
		if progress(t, r, "a").Delivery != app.DeliveryUnknown {
			t.Fatalf("unknown parent ACK fabricated: %+v", r)
		}
	}
	if len(f.delivery.sends) != 1 || len(f.provider.dispatches) != 1 {
		t.Fatal("ambiguous delivery was retried")
	}
	snap, err := f.journal.Read(testContext, "task-a")
	if err != nil || snap.Pending != "deliver-a" {
		t.Fatalf("delivery fence: %+v %v", snap, err)
	}
}

func TestCompositionLostDeliveryFinishACKReadsRetainedAcknowledgement(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	f.faults.finish = true
	r, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	if progress(t, r, "a").Delivery != app.DeliveryAcknowledged {
		t.Fatalf("durable parent ACK not read: %+v", r)
	}
	f.reopen()
	if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	if len(f.delivery.sends) != 1 {
		t.Fatal("retained acknowledged delivery repeated")
	}
}

func TestCompositionPartialFailureDoesNotStartDependent(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a", "b"}
	f := newComposition(t, p)
	f.tick(2, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Failed, "")
	f.provider.settle("task-b", "create-b", task.Completed, "B")
	r := f.tick(2, app.AdmitNew)
	if progress(t, r, "a").State != wf.Failed || !progress(t, r, "b").Accepted || len(r.Started) != 0 || len(f.provider.dispatches) != 2 {
		t.Fatalf("failure dependency: %+v", r)
	}
}

func TestCompositionBlockedInputAllowsIndependentSibling(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a"}
	f := newComposition(t, p)
	f.composer.blocked["a"] = true
	r := f.tick(2, app.AdmitNew)
	if progress(t, r, "a").State != wf.NeedsInput || !reflect.DeepEqual(r.Started, []string{"b"}) || len(f.provider.dispatches) != 1 {
		t.Fatalf("blocked sibling: %+v", r)
	}
	if f.provider.dispatches[0].Intent.TaskID != "task-b" {
		t.Fatal("dependent or blocked step dispatched")
	}
}

func TestCompositionTaskNeedsInputDoesNotOccupySiblingSlot(t *testing.T) {
	p := fixturePlan("a", "b", "c")
	p.Steps[2].Dependencies = []string{"a"}
	f := newComposition(t, p)
	f.provider.immediate["task-a"] = port.Observation{Lifecycle: task.NeedsInput}
	first := f.tick(1, app.AdmitNew)
	if progress(t, first, "a").State != wf.NeedsInput || !reflect.DeepEqual(first.Started, []string{"a"}) {
		t.Fatalf("Task approval hold: %+v", first)
	}
	second := f.tick(1, app.AdmitNew)
	if !reflect.DeepEqual(second.Started, []string{"b"}) || len(f.provider.dispatches) != 2 {
		t.Fatalf("approval consumed unrelated capacity: %+v", second)
	}
	if f.provider.dispatches[1].Intent.TaskID != "task-b" {
		t.Fatal("needs-input dependency dispatched")
	}
}

func TestCompositionParentRevokedStopsNewChildrenButRetainsResults(t *testing.T) {
	p := fixturePlan("a", "c")
	p.Steps[1].Dependencies = []string{"a"}
	f := newComposition(t, p)
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.authority.parentClosed = true
	r := f.tick(1, app.AdmitNew)
	if !progress(t, r, "a").Accepted || progress(t, r, "c").State != wf.Unavailable || len(f.provider.dispatches) != 1 {
		t.Fatalf("revoked parent: %+v", r)
	}
	if _, err := f.workflow.Deliver(testContext, p); err != nil {
		t.Fatal(err)
	}
	if len(f.delivery.sends) != 0 {
		t.Fatal("revoked parent received delivery")
	}
}

func TestCompositionCancellationACKIsNotTerminalAndNotResent(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	r, err := f.workflow.Cancel(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	if row := progress(t, r, "a"); row.State != wf.Running || !row.CancelRequested || row.Accepted {
		t.Fatalf("cancel acknowledged completion: %+v", row)
	}
	if len(f.provider.dispatches) != 2 || f.provider.dispatches[1].Intent.Action != task.Cancel {
		t.Fatalf("cancel dispatch: %+v", f.provider.dispatches)
	}
	f.reopen()
	if _, err := f.workflow.Cancel(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	if len(f.provider.dispatches) != 2 {
		t.Fatal("cancel request repeated")
	}
	f.provider.settle("task-a", "create-a", task.Interrupted, "")
	if row := progress(t, f.tick(1, app.Reconnect), "a"); row.State != wf.Cancelled || !row.CancelRequested || row.Accepted {
		t.Fatalf("terminal cancel: %+v", row)
	}
}

func TestCompositionExplicitContinueUsesNewSelectedEpochAndRetainsOriginal(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	request := app.Followup{TaskID: "task-a", OperationID: "continue-a", ExpectedDispatchID: "create-a", Message: "explicit continuation"}
	if _, err := f.workflow.Follow(testContext, f.plan, "a", request); !errors.Is(err, app.ErrState) {
		t.Fatalf("running followup permitted: %v", err)
	}
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	if _, err := f.workflow.Follow(testContext, f.plan, "a", request); !errors.Is(err, app.ErrState) {
		t.Fatalf("undelivered original followup permitted: %v", err)
	}
	if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	// A closed epoch cannot start another effect, even after a known completion.
	if _, err := f.workflow.Follow(testContext, f.plan, "a", request); !errors.Is(err, app.ErrUnknown) {
		t.Fatalf("old selected epoch: %v", err)
	}
	if len(f.provider.dispatches) != 1 {
		t.Fatal("old epoch dispatched followup")
	}
	f.selectFollowup("task-a", "continue-a", 2)
	r, err := f.workflow.Follow(testContext, f.plan, "a", request)
	if err != nil || r.State != app.Known || r.Action != "continue" || r.OperationID != "continue-a" {
		t.Fatalf("explicit followup: %+v %v", r, err)
	}
	if len(f.provider.dispatches) != 2 || f.provider.dispatches[1].Intent.Expected != (task.Reference{ThreadID: "provider-task-a", TurnID: "create-a"}) || f.provider.dispatches[1].Intent.Admission.TaskEpoch != 2 {
		t.Fatalf("followup identity: %+v", f.provider.dispatches)
	}
	for _, message := range []string{request.Message, "changed message", request.Message} {
		request.Message = message
		prior, err := f.workflow.Follow(testContext, f.plan, "a", request)
		if !errors.Is(err, app.ErrState) || prior.OperationID != "continue-a" {
			t.Fatalf("existing effect attributed to new input: %+v %v", prior, err)
		}
		retained, err := f.workflow.ReadFollowup(testContext, f.plan, "a", "continue-a", false)
		if err != nil || retained != prior {
			t.Fatalf("original followup observation: %+v %v", retained, err)
		}
	}
	if len(f.provider.dispatches) != 2 {
		t.Fatal("followup operation replayed")
	}
	old, err := f.tasks.Read(testContext, "task-a", "create-a")
	if err != nil || old.Output != "A" || old.Outcome != wf.Completed {
		t.Fatalf("original result overwritten: %+v %v", old, err)
	}
}

func TestCompositionInvalidDependencyOutputNeverReachesComposer(t *testing.T) {
	for _, tc := range []struct {
		name   string
		output string
		kind   wf.OutputKind
	}{
		{"too-large", strings.Repeat("x", 1025), wf.OutputText},
		{"wrong-type", "plain text", wf.OutputJSON},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := fixturePlan("a", "c")
			p.Steps[0].Output.Kind = tc.kind
			p.Steps[1].Dependencies = []string{"a"}
			f := newComposition(t, p)
			f.tick(1, app.AdmitNew)
			f.provider.settle("task-a", "create-a", task.Completed, tc.output)
			r := f.tick(1, app.AdmitNew)
			if progress(t, r, "a").State != wf.InvalidOutput || progress(t, r, "a").Accepted || len(r.Started) != 0 || len(f.provider.dispatches) != 1 {
				t.Fatalf("invalid output aggregation: %+v", r)
			}
			if _, err := f.workflow.Deliver(testContext, p); err != nil {
				t.Fatal(err)
			}
			if len(f.delivery.sends) != 0 {
				t.Fatal("unaccepted output delivered")
			}
		})
	}
}

func TestCompositionReconnectMissingChildrenCannotLaunch(t *testing.T) {
	f := newComposition(t, fixturePlan("a", "b"))
	r := f.tick(2, app.Reconnect)
	if len(r.Started) != 0 || len(f.provider.dispatches) != 0 || progress(t, r, "a").State != wf.Unknown || progress(t, r, "b").State != wf.Unknown {
		t.Fatalf("missing-child reconnect: %+v", r)
	}
}

func TestCompositionUnknownFollowupReadsOriginalAndNeverRepeatsEffect(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	f.selectFollowup("task-a", "continue-a", 2)
	f.provider.lostDispatchACK["task-a"] = true
	request := app.Followup{TaskID: "task-a", OperationID: "continue-a", ExpectedDispatchID: "create-a", Message: "explicit continuation"}
	r, err := f.workflow.Follow(testContext, f.plan, "a", request)
	if err != nil || r.State != app.Unknown {
		t.Fatalf("unknown followup: %+v %v", r, err)
	}
	// Rebuild the workflow service; selected Task routes remain the original
	// trusted selection. Neither same nor changed content can resend its intent.
	f.workflow, err = app.New(f.tasks, f.composer, f.admission)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range []string{request.Message, "changed message"} {
		request.Message = message
		prior, err := f.workflow.Follow(testContext, f.plan, "a", request)
		if !errors.Is(err, app.ErrState) || prior.State != app.Unknown {
			t.Fatalf("unknown effect repeated or changed: %+v %v", prior, err)
		}
		retained, err := f.workflow.ReadFollowup(testContext, f.plan, "a", "continue-a", false)
		if err != nil || retained.State != app.Unknown {
			t.Fatalf("unknown retained query: %+v %v", retained, err)
		}
	}
	if len(f.provider.dispatches) != 2 {
		t.Fatal("unknown followup redispatched")
	}
}

func TestCompositionOldDeliveryTargetRefusesCompletedExternalFollowup(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	// A different authorized caller can change the Task outside this workflow.
	// It uses the actual same Owner with a new selected epoch, without delivering
	// the workflow's original result. This is why adapter exact guards are needed.
	f.selectFollowup("task-a", "external-followup", 2)
	request := app.Followup{TaskID: "task-a", OperationID: "external-followup", ExpectedDispatchID: "create-a", Message: "external continuation"}
	if _, err := f.tasks.Followup(testContext, request); err != nil {
		t.Fatal(err)
	}
	f.provider.settle("task-a", "external-followup", task.Completed, "new result")
	if _, err := f.tasks.followupOperations["external-followup"].facade.Result(testContext, control.TaskRequest{TaskID: "task-a"}); err != nil {
		t.Fatal(err)
	}
	old, err := f.tasks.Read(testContext, "task-a", "create-a")
	if err != nil || old.Output != "A" {
		t.Fatalf("original result: %+v %v", old, err)
	}
	target := app.Target{TaskID: "task-a", OperationID: "deliver-a", ExpectedDispatchID: "create-a", Reference: old.Reference}
	if _, err := f.tasks.Deliver(testContext, target); !errors.Is(err, app.ErrIdentity) {
		t.Fatalf("old target sent newer result: %v", err)
	}
	if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	if len(f.delivery.sends) != 0 {
		t.Fatal("new dispatch delivered under old workflow delivery identity")
	}
}

func TestCompositionDocumentedExample(t *testing.T) {
	data, err := os.ReadFile("../../../../../docs/agent-workflows/example-plan.json")
	if err != nil {
		t.Fatal(err)
	}
	var p wf.Plan
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	if err := wf.Validate(p); err != nil {
		t.Fatalf("documented plan invalid: %v", err)
	}
	f := newComposition(t, p)
	if r := f.tick(2, app.AdmitNew); !reflect.DeepEqual(r.Started, []string{"a", "b"}) {
		t.Fatalf("documented fanout: %+v", r)
	}
	for _, step := range p.Steps {
		if step.ID == "a" || step.ID == "b" {
			f.provider.settle(step.TaskID, step.OperationID, task.Completed, strings.ToUpper(step.ID))
		}
	}
	if r := f.tick(2, app.AdmitNew); !reflect.DeepEqual(r.Started, []string{"c"}) || len(f.provider.dispatches) != 3 || f.provider.dispatches[2].Message != "A+B" {
		t.Fatalf("documented aggregation: %+v dispatches=%+v", r, f.provider.dispatches)
	}
	for _, step := range p.Steps {
		if step.ID == "c" {
			f.provider.settle(step.TaskID, step.OperationID, task.Completed, "A+B")
		}
	}
	if r := f.tick(2, app.Reconnect); !progress(t, r, "c").Accepted {
		t.Fatalf("documented aggregate result: %+v", r)
	}
}

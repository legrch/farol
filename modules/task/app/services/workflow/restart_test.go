//go:build darwin || linux

package workflow_test

import (
	"os"
	"path/filepath"
	"testing"

	app "github.com/legrch/farol/modules/task/app/services/workflow"
	task "github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
	repo "github.com/legrch/farol/modules/task/infra/repos/task"
)

func TestCompositionCorruptJournalRefusesRestartWithoutRepairOrEffect(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.fence()
	if err := f.journal.Close(); err != nil {
		t.Fatal(err)
	}
	f.journal = nil // Already closed; fixture cleanup still fences the old routes.
	path := filepath.Join(f.root.Path, "journal.json")
	// This is the test's private real Task journal, never an installed profile.
	if err := os.WriteFile(path, []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	store, err := repo.OpenFilesystem(f.root)
	if store != nil || err == nil {
		t.Fatalf("corrupt snapshot adopted: %v %v", store, err)
	}
	retained, err := os.ReadFile(path)
	if err != nil || string(retained) != "{" || len(f.provider.dispatches) != 1 {
		t.Fatalf("journal repaired or execution replayed: %q %v", retained, err)
	}
	// Fixture cleanup observes the already closed original journal; the failed
	// OpenFilesystem releases its own lease. No workflow owner is reconstructed.
}

func TestCompositionFailedResultDeliveryAllowsExplicitSupportedFollowup(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.settle("task-a", "create-a", task.Failed, "")
	report := f.tick(1, app.Reconnect)
	if progress(t, report, "a").Accepted {
		t.Fatal("failed output accepted for dependency")
	}
	delivered, err := f.workflow.Deliver(testContext, f.plan)
	if err != nil || progress(t, delivered, "a").Delivery != app.DeliveryAcknowledged {
		t.Fatalf("failure delivery: %+v %v", delivered, err)
	}
	request := app.Followup{TaskID: "task-a", OperationID: "continue-failed-a", ExpectedDispatchID: "create-a", Message: "synthetic recovery"}
	f.selectFollowup("task-a", request.OperationID, 2)
	r, err := f.workflow.Follow(testContext, f.plan, "a", request)
	if err != nil || r.State != app.Known || r.Outcome != wf.Running || len(f.provider.dispatches) != 2 {
		t.Fatalf("known failed follow-up: %+v %v", r, err)
	}
}

func TestCompositionLostCancellationACKIsUnknownNotRequestedOrTerminal(t *testing.T) {
	f := newComposition(t, fixturePlan("a"))
	f.tick(1, app.AdmitNew)
	f.provider.lostDispatchACK["task-a"] = true
	r, err := f.workflow.Cancel(testContext, f.plan)
	if err != nil {
		t.Fatal(err)
	}
	row := progress(t, r, "a")
	if row.CancelRequested || row.Cancellation != app.CancellationUnknown || row.State == wf.Cancelled {
		t.Fatalf("lost cancel ACK promoted: %+v", row)
	}
	f.reopen()
	for range 2 {
		r, err = f.workflow.Cancel(testContext, f.plan)
		if err != nil || progress(t, r, "a").Cancellation != app.CancellationUnknown {
			t.Fatalf("reconstructed cancellation: %+v %v", r, err)
		}
	}
	if len(f.provider.dispatches) != 2 {
		t.Fatal("ambiguous cancellation resent")
	}
}

func TestCompositionExplicitClaudeResumePreservesSessionAndNewInvocation(t *testing.T) {
	f := newCompositionFor(t, fixturePlan("a"), task.Claude)
	f.tick(1, app.AdmitNew)
	request := app.Followup{TaskID: "task-a", OperationID: "resume-a", ExpectedDispatchID: "create-a", Message: "synthetic resume", Resume: true}
	if _, err := f.workflow.Follow(testContext, f.plan, "a", request); err == nil {
		t.Fatal("active Claude invocation resumed")
	}
	f.provider.settle("task-a", "create-a", task.Completed, "A")
	f.tick(1, app.Reconnect)
	if _, err := f.workflow.Deliver(testContext, f.plan); err != nil {
		t.Fatal(err)
	}
	f.selectFollowup("task-a", request.OperationID, 2)
	r, err := f.workflow.Follow(testContext, f.plan, "a", request)
	if err != nil || r.State != app.Known || r.Reference.SessionID != "provider-task-a" || r.Reference.InvocationID != "resume-a" || r.Reference.ThreadID != "" || r.Reference.TurnID != "" {
		t.Fatalf("wrong resumed identity: %+v %v", r, err)
	}
	if len(f.provider.dispatches) != 2 || f.provider.dispatches[1].Intent.Action != task.Resume || f.provider.dispatches[1].Intent.Expected.InvocationID != "create-a" {
		t.Fatal("resume bypassed original Task control")
	}
	observed, err := f.workflow.ReadFollowup(testContext, f.plan, "a", request.OperationID, true)
	if err != nil || observed != r {
		t.Fatalf("resume observation: %+v %v", observed, err)
	}
}

package task

import (
	"bytes"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

func workflowCreate(child string) (task.Intent, task.Task) {
	i, next := filesystemCreate(task.Codex)
	i.TaskID, i.OperationID, i.Admission.TaskID = child, child+"-create", child
	next.ID, next.Admission.Binding = child, i.Admission
	return i, next
}
func TestWorkflowCapacityUnknownReservationBlocksOrdinaryCreateAfterRestart(t *testing.T) {
	j, m := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	workflowSave(t, j, p, 1)
	workflowReserve(t, j, p)
	before := bytes.Clone(m.data)
	reopened, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	i, next := workflowCreate("ordinary")
	if _, err := reopened.Admit(filesystemCtx, i, 0, next); !errors.Is(err, task.ErrState) {
		t.Fatal("missing original operation was released", err)
	}
	if !bytes.Equal(m.data, before) {
		t.Fatal("known capacity refusal wrote an intent")
	}
}
func TestWorkflowCapacitySerializesOrdinaryAndWorkflowOriginalLaunch(t *testing.T) {
	j, m := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	workflowSave(t, j, p, 1)
	var wg sync.WaitGroup
	results := make(chan string, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		if r, e := j.ReserveWorkflow(filesystemCtx, p.ID, "child", "child-create"); e == nil && r.Claimed {
			results <- "workflow"
		} else if !errors.Is(e, task.ErrState) {
			t.Error(r, e)
		}
	}()
	go func() {
		defer wg.Done()
		i, next := workflowCreate("ordinary")
		if a, e := j.Admit(filesystemCtx, i, 0, next); e == nil && a.Claimed {
			results <- "ordinary"
		} else if !errors.Is(e, task.ErrState) {
			t.Error(a, e)
		}
	}()
	wg.Wait()
	close(results)
	if len(results) != 1 || m.writes != 2 {
		t.Fatal("simultaneous paths oversubscribed", len(results), m.writes)
	}
}
func TestWorkflowReservedTaskCreatesWithinSameOccupiedSlot(t *testing.T) {
	j, _ := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	workflowSave(t, j, p, 1)
	workflowReserve(t, j, p)
	i, next := workflowCreate("child")
	a, err := j.Admit(filesystemCtx, i, 0, next)
	if err != nil || !a.Claimed {
		t.Fatal("reservation was counted twice", a, err)
	}
	other, prepared := workflowCreate("ordinary")
	if _, err := j.Admit(filesystemCtx, other, 0, prepared); !errors.Is(err, task.ErrState) {
		t.Fatal(err)
	}
}
func TestWorkflowCapacityReleasesOnlyOriginalKnownTerminalOrRefused(t *testing.T) {
	for _, mode := range []string{"running", "cancel-requested", "revoked", "needs-input", "completed", "refused"} {
		t.Run(mode, func(t *testing.T) {
			j, _ := filesystemFixture(t)
			p := workflowPlanFixture("workflow", "child")
			workflowSave(t, j, p, 1)
			workflowReserve(t, j, p)
			i, next := workflowCreate("child")
			if _, err := j.Admit(filesystemCtx, i, 0, next); err != nil {
				t.Fatal(err)
			}
			receipt := task.Receipt{State: task.Known, Reference: filesystemReference(task.Codex, i.OperationID), Lifecycle: task.Running}
			next.Reference, next.DispatchID, next.Lifecycle = receipt.Reference, i.OperationID, task.Running
			switch mode {
			case "refused":
				receipt = task.Receipt{State: task.Rejected, Code: "CONTROLLED_REFUSAL"}
				next.Reference = task.Reference{}
				next.DispatchID = ""
				next.Lifecycle = task.Refused
				next.Admission.State = task.AdmissionClosed
			case "needs-input":
				receipt.Lifecycle = task.NeedsInput
				next.Lifecycle = task.NeedsInput
				next.Admission.State = task.AdmissionClosed
			case "completed":
				receipt.Lifecycle = task.Completed
				next.Lifecycle = task.Completed
				next.Admission.State = task.AdmissionClosed
			}
			if err := j.Finish(filesystemCtx, i.OperationID, receipt, next); err != nil {
				t.Fatal(err)
			}
			if mode == "revoked" {
				before, _ := j.Read(filesystemCtx, "child")
				if err := j.Invalidate(filesystemCtx, *before); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "cancel-requested" {
				// Cancellation-requested/closed admission is not terminal completion.
				image, e := j.load(filesystemCtx)
				if e != nil {
					t.Fatal(e)
				}
				s := image.Tasks["child"]
				s.Task.CancelRequested = true
				s.Task.Admission.State = task.AdmissionRevoked
				image.Tasks["child"] = s
				if !workflowOccupied(image)["child"] {
					t.Fatal("cancellation released occupancy")
				}
			}
			other, prepared := workflowCreate("ordinary")
			a, err := j.Admit(filesystemCtx, other, 0, prepared)
			released := mode == "needs-input" || mode == "completed" || mode == "refused"
			if released && (err != nil || !a.Claimed) || !released && !errors.Is(err, task.ErrState) {
				t.Fatal(a, err)
			}
		})
	}
}
func TestWorkflowCapacityReservationUnknownBlocksFollowupAndNoIdentityAdoption(t *testing.T) {
	j, m := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	workflowSave(t, j, p, 1)
	workflowReserve(t, j, p)
	before := m.writes
	for _, mode := range []string{"parent", "operation", "reserved-task-without-reservation"} {
		i, next := workflowCreate("child")
		if mode == "parent" {
			i.Parent.TurnID = "foreign"
			next.Parent = i.Parent
		}
		if mode == "operation" {
			i.OperationID = "foreign"
		}
		if mode == "reserved-task-without-reservation" {
			i.OperationID = "child-cancel"
		}
		if _, err := j.Admit(filesystemCtx, i, 0, next); !errors.Is(err, task.ErrIdentity) {
			t.Fatal(mode, err)
		}
	}
	if m.writes != before {
		t.Fatal("identity refusal mutated durable state")
	}
	if _, err := j.ReserveWorkflow(filesystemCtx, p.ID, "child", "foreign"); !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
}

var _ port.AdmissionJournal = (*Filesystem)(nil)

func TestWorkflowPlanOperationNamespaceRejectsForeignTaskAndWrongAction(t *testing.T) {
	for _, operation := range []string{"child-create", "child-cancel", "child-deliver"} {
		t.Run(operation, func(t *testing.T) {
			j, m := filesystemFixture(t)
			workflowSave(t, j, workflowPlanFixture("workflow", "child"), 2)
			before := bytes.Clone(m.data)
			i, next := workflowCreate("ordinary")
			i.OperationID = operation
			if _, err := j.Admit(filesystemCtx, i, 0, next); !errors.Is(err, task.ErrIdentity) {
				t.Fatalf("planned operation was adopted by another task: %v", err)
			}
			if !bytes.Equal(m.data, before) {
				t.Fatal("identity refusal published")
			}
		})
	}
}

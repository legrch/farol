package task

// These tests use the existing atomic image storage fault seam. They qualify
// durable policy/format semantics, not physical fsync, Darwin lease, or providers.
import (
	"bytes"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/domain"
	wf "github.com/legrch/farol/modules/task/domain/workflow"
)

func workflowPlanFixture(id, child string) wf.Plan {
	return wf.Plan{ID: id, Parent: wf.Parent{ThreadID: "parent", TurnID: "parent-turn"}, Steps: []wf.Step{{ID: child, TaskID: child, OperationID: child + "-create", CancelOperationID: child + "-cancel", DeliveryOperationID: child + "-deliver", Output: wf.Output{Kind: wf.OutputText, MaxBytes: 1024}, Required: []wf.Capability{wf.CapabilityCreate}}}}
}
func workflowSave(t *testing.T, j *Filesystem, p wf.Plan, capacity int) *WorkflowPlan {
	t.Helper()
	out, err := j.SaveWorkflow(filesystemCtx, p, capacity)
	if err != nil || out == nil || out.Plan.ID != p.ID || len(out.SHA256) != 64 {
		t.Fatalf("save workflow: %+v %v", out, err)
	}
	return out
}
func workflowReserve(t *testing.T, j *Filesystem, p wf.Plan) *WorkflowReservation {
	t.Helper()
	out, err := j.ReserveWorkflow(filesystemCtx, p.ID, p.Steps[0].TaskID, p.Steps[0].OperationID)
	if err != nil || out == nil || !out.Claimed {
		t.Fatalf("reserve workflow: %+v %v", out, err)
	}
	return out
}

func TestWorkflowOriginalPlanRestartIsolationAndFixedCapacity(t *testing.T) {
	j, m := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	out := workflowSave(t, j, p, 1)
	before := bytes.Clone(m.data)
	out.Plan.Steps[0].Required[0] = wf.CapabilityCancel
	p.Steps[0].TaskID = "mutated-caller"
	reopened, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	read, err := reopened.ReadWorkflow(filesystemCtx, "workflow")
	if err != nil || read.Plan.Steps[0].TaskID != "child" || read.Plan.Steps[0].Required[0] != wf.CapabilityCreate {
		t.Fatal(read, err)
	}
	if !bytes.Equal(m.data, before) || m.writes != 1 {
		t.Fatal("read/restart mutated or activated workflow")
	}
	original := workflowPlanFixture("workflow", "child")
	if _, err := reopened.SaveWorkflow(filesystemCtx, original, 1); err != nil || m.writes != 1 {
		t.Fatal("identical save must be retained read", err)
	}
	for _, variant := range []string{"plan", "capacity", "parent", "operation"} {
		t.Run(variant, func(t *testing.T) {
			changed := workflowPlanFixture("workflow", "child")
			capacity := 1
			switch variant {
			case "plan":
				changed.Steps[0].Output.MaxBytes++
			case "capacity":
				capacity++
			case "parent":
				changed.Parent.TurnID = "other-turn"
			case "operation":
				changed.Steps[0].OperationID = "another-create"
			}
			if _, err := reopened.SaveWorkflow(filesystemCtx, changed, capacity); !errors.Is(err, task.ErrConflict) || m.writes != 1 {
				t.Fatal("immutable owner policy changed", err)
			}
		})
	}
}
func TestWorkflowReservationOriginalCallbackConsumedExactlyOnce(t *testing.T) {
	j, m := filesystemFixture(t)
	p := workflowPlanFixture("workflow", "child")
	workflowSave(t, j, p, 1)
	var wg sync.WaitGroup
	var mu sync.Mutex
	claimed := 0
	for range 16 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := j.ReserveWorkflow(filesystemCtx, p.ID, "child", "child-create")
			if err != nil {
				t.Error(err)
				return
			}
			if r.Claimed {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if claimed != 1 || m.writes != 2 {
		t.Fatal(claimed, m.writes)
	}
	reopened, err := newFilesystem(m, "dev")
	if err != nil {
		t.Fatal(err)
	}
	r, err := reopened.ReserveWorkflow(filesystemCtx, p.ID, "child", "child-create")
	if err != nil || r.Claimed || m.writes != 2 {
		t.Fatal(r, err)
	}
}
func TestWorkflowUnknownSaveOrReservePublicationNeverBecomesAnotherPermit(t *testing.T) {
	for _, kind := range []string{"save", "reserve"} {
		for _, after := range []bool{false, true} {
			t.Run(kind+"/"+map[bool]string{false: "before", true: "after"}[after], func(t *testing.T) {
				j, m := filesystemFixture(t)
				p := workflowPlanFixture("workflow", "child")
				if kind == "reserve" {
					workflowSave(t, j, p, 1)
				}
				m.failBefore, m.failAfter = !after, after
				var err error
				if kind == "save" {
					_, err = j.SaveWorkflow(filesystemCtx, p, 1)
				} else {
					_, err = j.ReserveWorkflow(filesystemCtx, p.ID, "child", "child-create")
				}
				if !errors.Is(err, task.ErrUnknown) {
					t.Fatal(err)
				}
				writes := m.writes
				m.failBefore, m.failAfter, m.uncertain = false, false, false
				if kind == "save" {
					_, err = j.SaveWorkflow(filesystemCtx, p, 1)
					if after && err != nil || !after && !errors.Is(err, task.ErrUnknown) {
						t.Fatal(err)
					}
				} else {
					r, e := j.ReserveWorkflow(filesystemCtx, p.ID, "child", "child-create")
					if after && (e != nil || r.Claimed) || !after && !errors.Is(e, task.ErrUnknown) {
						t.Fatal(r, e)
					}
				}
				if m.writes != writes {
					t.Fatal("unknown publication retried")
				}
			})
		}
	}
}
func TestWorkflowOldCanonicalBytesAndMalformedExtension(t *testing.T) {
	image := filesystemEmpty("dev")
	data, err := filesystemEncode(image)
	if err != nil || bytes.Contains(data, []byte("Workflows")) {
		t.Fatal(string(data), err)
	}
	decoded, err := filesystemDecode(data)
	if err != nil {
		t.Fatal(err)
	}
	again, err := filesystemEncode(decoded)
	if err != nil || !bytes.Equal(data, again) {
		t.Fatal("old v1 bytes changed")
	}
	j, m := filesystemFixture(t)
	workflowSave(t, j, workflowPlanFixture("workflow", "child"), 1)
	decoded, err = filesystemDecode(m.data)
	if err != nil {
		t.Fatal(err)
	}
	decoded.Workflows.Plans["workflow"] = WorkflowPlan{Plan: workflowPlanFixture("workflow", "child"), SHA256: "wrong"}
	if _, err := filesystemEncode(decoded); !errors.Is(err, task.ErrInvalid) {
		t.Fatal("corrupt plan accepted", err)
	}
}

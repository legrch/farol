package control_test

import (
	"testing"

	"github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
)

func TestFacadeMessageExactDelegatesToOriginalActiveOwnerAndBindsReplay(t *testing.T) {
	f := newFixture(t, task.Codex)
	f.provider.caps.Message = true
	created := f.create()
	reference := ref(task.Codex, "turn-1", "create-1")
	f.provider.steps = append(f.provider.steps, step{action: task.Message, operation: "steer", message: "adjust", expected: reference, reference: reference, lifecycle: task.Running})
	req := control.MessageExactRequest{OperationID: "steer", TaskID: "task", Message: "adjust", ExpectedDispatchID: "create-1"}
	out, err := f.facade.MessageExact(ctx, req)
	if err != nil || out.Receipt.State != control.Known || out.Receipt.Reference != created.Receipt.Reference || out.Receipt.Lifecycle != control.Running || out.Receipt.Result != "" {
		t.Fatal(out, err)
	}
	supports := f.provider.supports
	if replay, err := f.facade.MessageExact(ctx, req); err != nil || *replay != *out {
		t.Fatal(replay, err)
	}
	changed := req
	changed.ExpectedDispatchID = "steer"
	_, err = f.facade.MessageExact(ctx, changed)
	requireFailure(t, err, "TASK_OPERATION_CONFLICT")
	_, err = f.facade.Message(ctx, control.FollowupRequest{req.OperationID, req.TaskID, req.Message})
	requireFailure(t, err, "TASK_OPERATION_CONFLICT")
	if f.provider.effects != 2 || f.provider.supports != supports || f.provider.reads != 0 || f.delivery.calls != 0 {
		t.Fatal("replay created extra work or result proof")
	}
}

func TestFacadeMessageExactRefusesStaleDispatchAndUnqualifiedCapability(t *testing.T) {
	for _, dispatch := range []string{"", "foreign", "create-1"} {
		t.Run(dispatch, func(t *testing.T) {
			f := newFixture(t, task.Codex)
			f.create()
			_, err := f.facade.MessageExact(ctx, control.MessageExactRequest{"steer", "task", "adjust", dispatch})
			want := "TASK_IDENTITY_MISMATCH"
			if dispatch == "" {
				want = "TASK_INPUT_INVALID"
			} else if dispatch == "create-1" {
				want = "TASK_CAPABILITY_UNAVAILABLE"
			}
			requireFailure(t, err, want)
			if f.provider.effects != 1 || f.provider.reads != 0 || f.delivery.calls != 0 {
				t.Fatal("refusal manufactured provider authority")
			}
		})
	}
}

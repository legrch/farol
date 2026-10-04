package boot

import (
	"context"
	"testing"

	controlct "github.com/legrch/farol/modules/task/contracts/control"
)

func TestTaskSelectorCannotSubstituteAnotherActiveChatTask(t *testing.T) {
	for _, cancelOriginal := range []bool{false, true} {
		name := "original-active"
		if cancelOriginal {
			name = "original-cancelled"
		}
		t.Run(name, func(t *testing.T) {
			s, f, h, g := taskSelectorSetup(t, false)
			ctx := context.Background()
			if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "original parent task"}); err != nil {
				t.Fatal(err)
			}
			f.task.pipe.complete("turn-1")
			if _, err := g.Observe(ctx); err != nil {
				t.Fatal(err)
			}
			if cancelOriginal {
				if err := f.parent.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			}
			f.chat.physical.distinctViews = true
			other := f.chat.start(t, "unrelated-parent", chatComputerInput(true))
			if other.binding.TaskID == f.parent.binding.TaskID || other.binding.ParticipantID == f.parent.binding.ParticipantID {
				t.Fatal("fixture did not create an independent Chat task")
			}
			routes := len(f.profile.routes)
			next, err := s.ContinueCodex(ctx, *h, "create", other.id)
			if next != nil && err == nil {
				// Demonstrate the downstream physical consequence in the original
				// controlled provider; this is not an installed/live operation.
				follow, sendErr := s.surface.handles[next.HandleId].Continue(ctx, "foreign-follow", TaskIngressContinueRequest{DispatchID: "create", Message: "must never use unrelated Chat authority"})
				t.Fatalf("foreign Chat task selected: receipt=%+v error=%v threadStarts=%d turnStarts=%d", follow, sendErr, f.task.pipe.count("thread/start"), f.task.pipe.count("turn/start"))
			}
			if len(f.profile.routes) != routes || len(s.records) != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
				t.Fatal("foreign parent changed scope or provider effects")
			}
		})
	}
}

func TestTaskSelectorAcceptsFreshTurnOfOriginalChatTask(t *testing.T) {
	s, f, h, g := taskSelectorSetup(t, false)
	ctx := context.Background()
	created, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "first coding task turn"})
	if err != nil {
		t.Fatal(err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := g.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	f.chat.finish(t, f.parent)
	input := chatComputerInput(true)
	input.PreviousHandle = &f.parent.id
	parent := f.chat.start(t, "parent-follow", input)
	if parent.binding.TaskID != f.parent.binding.TaskID || parent.binding.ParticipantID != f.parent.binding.ParticipantID || parent.binding.TurnID == f.parent.binding.TurnID || parent.binding.TurnGeneration != f.parent.binding.TurnGeneration+1 {
		t.Fatal("fixture did not follow the original Chat task")
	}
	next, err := s.ContinueCodex(ctx, *h, "create", parent.id)
	if err != nil {
		t.Fatal(err)
	}
	follow, err := s.surface.handles[next.HandleId].Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create", Message: "same Chat and coding thread"})
	if err != nil || follow.Receipt.State != controlct.Known || follow.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || follow.Receipt.Reference.TurnID != "turn-2" || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 2 {
		t.Fatal("valid parent continuation was lost", follow, err)
	}
}

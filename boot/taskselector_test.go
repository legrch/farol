package boot

// The selector uses real Root/Chat/Task owners with existing memory journal and
// net.Pipe Codex doubles. This does not qualify saved settings or native startup.
import (
	"context"
	"sync"
	"testing"

	wire "github.com/legrch/farol/gen/desktop/v1"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
)

func taskSelectorSetup(t *testing.T, drop bool) (*TaskSelector, *taskProfileTestFixture, *wire.TaskHandle, *TaskIngress) {
	t.Helper()
	f := taskProfileTestSetup(t, drop)
	surface, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	selector, err := NewTaskSelector(surface)
	if err != nil {
		t.Fatal(err)
	}
	in := f.input
	h, err := selector.BeginCodex(context.Background(), CodexTaskSource{Selection: in.Selection, Followup: in.Followup, Authority: in.Authority, Delivery: in.Delivery, ChatHandle: in.ChatHandle, Parent: in.Parent})
	if err != nil {
		t.Fatal(err)
	}
	return selector, f, h, surface.handles[h.HandleId]
}

func TestTaskSelectorIndependentIdentityAndExactCompletedFollowup(t *testing.T) {
	s, f, h, g := taskSelectorSetup(t, false)
	ctx := context.Background()
	first := s.records[h.HandleId].input.Scope
	chat := f.parent.binding
	if first.OwnerID != f.profile.owner || first.TaskEpoch != 1 || first.SessionID == chat.SessionID || first.TaskID == chat.TaskID || first.ParticipantID == chat.ParticipantID || first.TurnID == chat.TurnID || f.task.store.snapshot != nil || f.task.pipe.launches.Load() != 0 {
		t.Fatal("coding scope reused Chat authority or selected provider", first)
	}
	created, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "independent coding task"})
	if err != nil || created.Receipt.State != controlct.Known {
		t.Fatal(created, err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := g.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	before, err := f.task.store.Read(ctx, first.TaskID)
	if err != nil {
		t.Fatal(err)
	}
	next, err := s.ContinueCodex(ctx, *h, "create", f.input.ChatHandle)
	if err != nil {
		t.Fatal(err)
	}
	second := s.records[next.HandleId].input.Scope
	if first.OwnerID != second.OwnerID || first.SessionID != second.SessionID || first.TaskID != second.TaskID || first.ParticipantID != second.ParticipantID || second.TaskEpoch != 2 || first.TurnID == second.TurnID || next.HandleId == h.HandleId || len(f.profile.clients) != 1 {
		t.Fatal("follow-up changed original identity/lifetime", second)
	}
	after, err := f.task.store.Read(ctx, first.TaskID)
	if err != nil || *before != *after || after.Task.Admission.State != task.AdmissionClosed {
		t.Fatal("selection published admission", after, err)
	}
	g2 := s.surface.handles[next.HandleId]
	followed, err := g2.Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create", Message: "same exact provider thread"})
	if err != nil || followed.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || followed.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(followed, err)
	}
	retained, err := g2.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create"})
	if err != nil || !retained.Retained || retained.Text != "retained turn-1" {
		t.Fatal(retained, err)
	}
	if retry, err := s.ContinueCodex(ctx, *h, "create", f.input.ChatHandle); err == nil || retry != nil {
		t.Fatal("old selected scope advanced again")
	}
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 2 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("selector substituted a provider lifetime")
	}
}

func TestTaskSelectorRefusesActiveUnknownAndForeignDispatch(t *testing.T) {
	for _, cut := range []string{"active", "unknown", "foreign-dispatch", "foreign-handle", "parent-cancelled", "host-changed", "overflow"} {
		t.Run(cut, func(t *testing.T) {
			s, f, h, g := taskSelectorSetup(t, cut == "unknown")
			ctx := context.Background()
			if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "one original task"}); err != nil {
				t.Fatal(err)
			}
			if cut != "active" && cut != "unknown" {
				f.task.pipe.complete("turn-1")
				if _, err := g.Observe(ctx); err != nil {
					t.Fatal(err)
				}
			}
			dispatch, prior := "create", *h
			switch cut {
			case "foreign-dispatch":
				dispatch = "other"
			case "foreign-handle":
				prior.HandleId = "other"
			case "parent-cancelled":
				if err := f.parent.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
			case "host-changed":
				f.task.authority.errorRead = task.ErrIdentity
			case "overflow":
				s.records[h.HandleId].input.Scope.TaskEpoch = ^uint64(0)
			}
			routes, owners := len(f.profile.routes), len(f.profile.tasks)
			if next, err := s.ContinueCodex(ctx, prior, dispatch, f.input.ChatHandle); err == nil || next != nil {
				t.Fatal("unqualified scope was advanced", next, err)
			}
			if len(f.profile.routes) != routes || len(f.profile.tasks) != owners || len(s.records) != 1 || f.task.pipe.launches.Load() != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
				t.Fatal("refused selection created another route/owner/provider effect")
			}
		})
	}
}

func TestTaskSelectorConcurrentFollowupPublishesOnlyOneAddress(t *testing.T) {
	s, f, h, g := taskSelectorSetup(t, false)
	ctx := context.Background()
	if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "completed task"}); err != nil {
		t.Fatal(err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := g.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	ready := make(chan struct{})
	results := make(chan bool, 2)
	var work sync.WaitGroup
	for range 2 {
		work.Add(1)
		go func() {
			defer work.Done()
			<-ready
			next, err := s.ContinueCodex(ctx, *h, "create", f.input.ChatHandle)
			results <- next != nil && err == nil
		}()
	}
	close(ready)
	work.Wait()
	count := 0
	for range 2 {
		if <-results {
			count++
		}
	}
	if count != 1 || len(s.records) != 2 || len(f.profile.routes) != 2 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("concurrent selection duplicated a facade or started a turn")
	}
}

package boot

// Root source composition with the actual Chat/Task owners and Codex adapter.
// Settings, physical host, journal and provider remain labelled CPU doubles.
import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	controlct "github.com/legrch/farol/modules/task/contracts/control"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
)

type taskSourceTestCurrent struct {
	mu       sync.Mutex
	snapshot codexclient.AuthoritySnapshot
}

func (c *taskSourceTestCurrent) read(context.Context) (codexclient.AuthoritySnapshot, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshot, nil
}
func (c *taskSourceTestCurrent) withdraw() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.snapshot.Approved = false
}

func taskSourceSetup(t *testing.T) (*TaskSelector, *taskProfileTestFixture, CurrentCodexTaskSource, *taskSourceTestCurrent) {
	t.Helper()
	f := taskProfileTestSetup(t, false)
	surface, err := NewTaskSurface(f.profile)
	if err != nil {
		t.Fatal(err)
	}
	selector, err := NewTaskSelector(surface)
	if err != nil {
		t.Fatal(err)
	}
	x := f.input.Selection
	snap := codexclient.AuthoritySnapshot{
		State: codexclient.AuthorityReady, Selection: x,
		HostGeneration: 3, ComputerGeneration: 7, GrantHostGeneration: 3, GrantComputerGeneration: 7,
		Approved: true, Access: codexclient.WorkspaceWrite,
		VerifiedWorkspaceID: x.Binding.WorkspaceID, VerifiedComputerGeneration: 7,
		Handoff: codexclient.HandoffQualification{ExecutablePath: x.ExecutablePath,
			ExecutableSHA256: x.ExecutableSHA256, Protocol: x.Protocol, SchemaSHA256: x.SchemaSHA256,
			HostGeneration: 3, ProjectBoundCreateStatus: true}, Followup: f.input.Followup,
	}
	current := &taskSourceTestCurrent{snapshot: snap}
	input := CurrentCodexTaskSource{Authority: codexclient.SelectionAuthorityOptions{
		Selected: snap, ReadCurrent: current.read, Verifier: f.task.pipe,
		Now: func() time.Time { return x.GrantedAt.Add(time.Minute) },
	}, ChatHandle: f.input.ChatHandle, Parent: f.input.Parent}
	return selector, f, input, current
}

func TestCurrentCodexSourceRetainsAuthorityAcrossSameChatFollowup(t *testing.T) {
	s, f, input, current := taskSourceSetup(t)
	ctx := context.Background()
	h, err := s.BeginCurrentCodex(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("source selection caused an effect")
	}
	first := s.surface.handles[h.HandleId]
	created, err := first.Create(ctx, "create", TaskIngressCreateRequest{Message: "actual current authority"})
	if err != nil || created.Receipt.State != controlct.Known {
		t.Fatal(created, err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := first.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	f.chat.finish(t, f.parent)
	nextChat := chatComputerInput(true)
	nextChat.PreviousHandle = &f.parent.id
	parent := f.chat.start(t, "next-parent", nextChat)
	next, err := s.ContinueCodex(ctx, *h, "create", parent.id)
	if err != nil {
		t.Fatal(err)
	}
	original := s.records[h.HandleId].input.Authority.(*codexTaskSourceAuthority)
	renewed := s.records[next.HandleId].input.Authority.(*codexTaskSourceAuthority)
	if original == renewed || original.selection != renewed.selection || original.parent == renewed.parent {
		t.Fatal("follow-up replaced grant authority or retained stale parent peer")
	}
	second := s.surface.handles[next.HandleId]
	continued, err := second.Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create", Message: "same coding thread"})
	if err != nil || continued.Receipt.State != controlct.Known || continued.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || continued.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(continued, err)
	}
	if f.task.pipe.launches.Load() != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 2 {
		t.Fatal("provider lifetime replaced")
	}
	prior, err := second.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create"})
	if err != nil || !prior.Retained || prior.Text != "retained turn-1" {
		t.Fatal(prior, err)
	}
	// Both facades still read the same live authority; a fresh parent must not
	// turn immutable selection evidence into a new permission after withdrawal.
	current.withdraw()
	if err := renewed.Recheck(ctx, input.Authority.Selected.Selection.Binding); err == nil {
		t.Fatal("new turn lost current authority")
	}
	if err := original.Recheck(ctx, input.Authority.Selected.Selection.Binding); err == nil {
		t.Fatal("original client grant remained cached")
	}
}

func TestCurrentCodexSourceRechecksGrantAndParentAfterProviderWait(t *testing.T) {
	for _, cut := range []string{"settings", "parent"} {
		t.Run(cut, func(t *testing.T) {
			s, f, input, current := taskSourceSetup(t)
			ctx := context.Background()
			h, err := s.BeginCurrentCodex(ctx, input)
			if err != nil {
				t.Fatal(err)
			}
			var catalogues atomic.Int32
			var cutReached atomic.Bool
			f.task.pipe.notifications = func(req taskIngressTestRPC) [][]byte {
				if req.Method == "model/list" && catalogues.Add(1) == 2 {
					if cut == "settings" {
						current.withdraw()
					} else if err := f.parent.handle.Cancel(ctx); err != nil {
						t.Error(err)
					}
					cutReached.Store(true)
				}
				return nil
			}
			out, err := s.surface.handles[h.HandleId].Create(ctx, "create", TaskIngressCreateRequest{Message: "must not send after withdrawal"})
			if !cutReached.Load() || (err == nil && out != nil && out.Receipt.State == controlct.Known) || f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
				t.Fatal("withdrawn current source sent", out, err, catalogues.Load())
			}
		})
	}
}

func TestCurrentCodexSourceMissingWitnessCannotSelectOwner(t *testing.T) {
	s, f, input, _ := taskSourceSetup(t)
	input.Authority.Selected.Handoff = codexclient.HandoffQualification{}
	if h, err := s.BeginCurrentCodex(context.Background(), input); err == nil || h != nil {
		t.Fatal("missing handoff witness selected")
	}
	if len(f.profile.tasks) != 0 || len(s.records) != 0 || f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("unqualified source acquired owner or effect")
	}
}

package boot

// Root lifetime + real current Chat owner + Task service/repository owner and
// concrete Codex RPC client. CPU journal and net.Pipe provider remain controlled;
// OpenTaskProfile/native storage, account, app selection and live Send are not run.
import (
	"context"
	"errors"
	codexclient "github.com/legrch/farol/modules/task/infra/clients/codex"
	"sync/atomic"
	"testing"
	"time"

	"github.com/legrch/farol/modules/task/app/port"
	controlct "github.com/legrch/farol/modules/task/contracts/control"
	"github.com/legrch/farol/modules/task/domain"
)

type taskProfileTestFixture struct {
	profile *TaskProfile
	chat    *chatComputerFixture
	parent  chatHandle
	task    *taskIngressTestFixture
	input   CodexTaskTurn
	closed  atomic.Int32
}

func taskProfileTestSetup(t *testing.T, drop bool) *taskProfileTestFixture {
	t.Helper()
	chat := newChatComputerFixture(t)
	parent := chat.start(t, "parent", chatComputerInput(true))
	f := taskIngressTestSetupProfile(t, drop, chat.ingress.peer.ProfileId)
	x := &taskProfileTestFixture{chat: chat, parent: parent, task: f}
	x.profile = newTaskProfile(chat.ingress.peer, "owner", chat.ingress, f.store, func() error { x.closed.Add(1); return nil })
	followup := codexclient.FollowupQualification{Selection: f.pipe.selection, Witness: codexclient.FollowupSchemaWitness{Kind: codexclient.FollowupSchemaKind, Protocol: f.pipe.selection.Protocol, BaseSchemaSHA256: f.pipe.selection.SchemaSHA256, SchemaSHA256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"}}
	x.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
		return codexclient.New(codexclient.Options{Selection: selection, Followup: q, Boundary: f.pipe, Now: func() time.Time { return selection.GrantedAt.Add(time.Minute) }, Recheck: grant, RecheckDispatch: dispatch})
	}
	x.input = CodexTaskTurn{Scope: f.route.Selection(), Selection: f.pipe.selection, Followup: followup, Authority: f.authority, ChatHandle: parent.id, Parent: controlct.Parent{ThreadID: "parent", TurnID: "parent-turn"}}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		_ = x.profile.Close(ctx)
	})
	return x
}
func (f *taskProfileTestFixture) selectTurn(t *testing.T, epoch uint64) *TaskIngress {
	t.Helper()
	in := f.input
	in.Scope.TaskEpoch = epoch
	if epoch > 1 {
		in.Scope.TurnID = "task-follow-up"
	}
	g, err := f.profile.SelectCodex(context.Background(), in)
	if err != nil {
		t.Fatal(err)
	}
	return g
}
func TestTaskProfileOneOwnerAndOriginalClientAcrossExactFollowup(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	ctx := context.Background()
	first := f.selectTurn(t, 1)
	owner := f.profile.tasks["task"].owner
	if f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
		t.Fatal("selection created provider/admission")
	}
	created, err := first.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "profile-owned task"})
	if err != nil || created.Receipt.State != controlct.Known {
		t.Fatal(created, err)
	}
	f.task.pipe.complete("turn-1")
	if _, err = first.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	second := f.selectTurn(t, 2)
	if f.profile.tasks["task"].owner != owner || len(f.profile.tasks) != 1 || len(f.profile.clients) != 1 {
		t.Fatal("new owner/client selected")
	}
	follow, err := second.Continue(ctx, "follow-2", TaskIngressContinueRequest{DispatchID: "create-1", Message: "same exact thread"})
	if err != nil || follow.Receipt.Reference.ThreadID != created.Receipt.Reference.ThreadID || follow.Receipt.Reference.TurnID != "turn-2" {
		t.Fatal(follow, err)
	}
	result, err := second.Result(ctx, TaskIngressDispatchRequest{DispatchID: "create-1"})
	if err != nil || result.Text != "retained turn-1" || result.Delivery != "not_observed" {
		t.Fatal(result, err)
	}
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 2 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("wrong original lifetime")
	}
	if err = f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = second.Resolve(ctx); err == nil {
		t.Fatal("closed facade still exposed")
	}
	if _, err = f.profile.SelectCodex(ctx, f.input); err == nil {
		t.Fatal("closed profile selected replacement")
	}
	if err = f.profile.Close(ctx); err != nil || f.closed.Load() != 1 {
		t.Fatal("close repeated", err, f.closed.Load())
	}
}
func TestTaskProfileRejectsSubstitutedSelectionBeforeProvider(t *testing.T) {
	for _, change := range []string{"profile", "owner", "parent", "model", "connection", "followup", "duplicate", "missing-parent-handle"} {
		t.Run(change, func(t *testing.T) {
			f := taskProfileTestSetup(t, false)
			_ = f.selectTurn(t, 1)
			in := f.input
			in.Scope.TaskEpoch = 2
			in.Scope.TurnID = "next"
			switch change {
			case "profile":
				in.Selection.Binding.ProfileID = "other-profile"
			case "owner":
				in.Scope.OwnerID = "other-owner"
			case "parent":
				in.Parent.TurnID = "other-parent"
			case "model":
				in.Selection.Binding.Model = "other-model"
			case "connection":
				in.Selection.SocketPath = "/fixture/other.sock"
			case "followup":
				in.Followup.Witness.SchemaSHA256 = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
			case "duplicate":
				in = f.input
			case "missing-parent-handle":
				in.ChatHandle = "missing"
			}
			if _, err := f.profile.SelectCodex(context.Background(), in); err == nil {
				t.Fatal("substitution admitted")
			}
			if len(f.profile.routes) != 1 || len(f.profile.tasks) != 1 || f.task.pipe.launches.Load() != 0 || f.task.store.snapshot != nil {
				t.Fatal("substitution changed owner or effects")
			}
		})
	}
}
func TestTaskProfileCurrentChatCancellationAndHostRecheckRemainIndependent(t *testing.T) {
	for _, cut := range []string{"parent-before-selection", "parent-after-selection", "host-after-selection"} {
		t.Run(cut, func(t *testing.T) {
			f := taskProfileTestSetup(t, false)
			ctx := context.Background()
			if cut == "parent-before-selection" {
				if err := f.parent.handle.Cancel(ctx); err != nil {
					t.Fatal(err)
				}
				if _, err := f.profile.SelectCodex(ctx, f.input); err == nil {
					t.Fatal("inactive parent selected")
				}
				return
			}
			g := f.selectTurn(t, 1)
			if cut == "host-after-selection" {
				f.task.authority.errorRead = task.ErrIdentity
			} else if err := f.parent.handle.Cancel(ctx); err != nil {
				t.Fatal(err)
			}
			if _, err := g.Create(ctx, "create-1", TaskIngressCreateRequest{Message: "must not send"}); err == nil {
				t.Fatal("withdrawn authority dispatched")
			}
			if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 || f.task.store.snapshot != nil {
				t.Fatal("effect after withdrawal")
			}
		})
	}
}
func TestTaskProfileUnknownOriginalEffectCannotSelectReplacementLifetime(t *testing.T) {
	f := taskProfileTestSetup(t, true)
	ctx := context.Background()
	first := f.selectTurn(t, 1)
	unknown, err := first.Create(ctx, "lost-create", TaskIngressCreateRequest{Message: "one original effect"})
	if err != nil || unknown.Receipt.State != controlct.Uncertain {
		t.Fatal(unknown, err)
	}
	second := f.selectTurn(t, 2)
	if out, err := second.Create(ctx, "new-create", TaskIngressCreateRequest{Message: "no replacement"}); err == nil && out.Receipt.State == controlct.Known {
		t.Fatal(out)
	}
	if f.task.pipe.launches.Load() != 1 || f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 {
		t.Fatal("unknown effect restarted")
	}
}
func TestTaskProfileCloseUninitializedAndRetainedAfterCancellation(t *testing.T) {
	if err := (&TaskProfile{}).Close(context.Background()); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal(err)
	}
	f := taskProfileTestSetup(t, false)
	if err := f.profile.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := f.profile.Close(ctx); err != nil || f.closed.Load() != 1 {
		t.Fatal("retained cleanup replaced by cancelled read", err)
	}
}
func TestTaskProfileCloseFencesBeforeJournalRetirementAndRetainsError(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	ctx := context.Background()
	if _, err := g.Create(ctx, "create", TaskIngressCreateRequest{Message: "running"}); err != nil {
		t.Fatal(err)
	}
	original := errors.New("controlled-journal-close-unknown")
	f.profile.closeJournal = func() error {
		f.closed.Add(1)
		if err := f.profile.routes[0].WithCurrent(ctx, func(b *port.CurrentBinding) error {
			if b != nil {
				t.Fatal("journal closed before admission fenced")
			}
			return nil
		}); err == nil {
			t.Fatal("route not fenced")
		}
		return original
	}
	if err := f.profile.Close(ctx); !errors.Is(err, original) {
		t.Fatal(err)
	}
	if err := f.profile.Close(ctx); !errors.Is(err, original) || f.closed.Load() != 1 {
		t.Fatal("unknown close retried", err)
	}
	if _, err := g.Create(ctx, "second", TaskIngressCreateRequest{Message: "blocked"}); err == nil {
		t.Fatal("closed facade dispatched")
	}
	if f.task.pipe.count("thread/start") != 1 {
		t.Fatal("extra provider effect")
	}
}

type taskProfileBlockedAdmission struct {
	*taskRuntimeTestMemory
	entered chan struct{}
	release chan struct{}
}

func (j *taskProfileBlockedAdmission) Admit(ctx context.Context, i task.Intent, r uint64, next task.Task) (*port.Admission, error) {
	out, err := j.taskRuntimeTestMemory.Admit(ctx, i, r, next)
	close(j.entered)
	<-j.release
	return out, err
}
func TestTaskProfileCloseDefeatsLateAdmissionWithoutProviderSend(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	j := &taskProfileBlockedAdmission{taskRuntimeTestMemory: f.task.store, entered: make(chan struct{}), release: make(chan struct{})}
	f.profile.journal = j
	g := f.selectTurn(t, 1)
	done := make(chan error, 1)
	go func() {
		_, err := g.Create(context.Background(), "create", TaskIngressCreateRequest{Message: "held admission"})
		done <- err
	}()
	select {
	case <-j.entered:
	case <-time.After(time.Second):
		t.Fatal("admission not entered")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := f.profile.Close(ctx); err != nil {
		t.Fatal(err)
	}
	close(j.release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("late admission accepted")
		}
	case <-time.After(time.Second):
		t.Fatal("late admission did not settle")
	}
	if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
		t.Fatal("provider dispatched after close")
	}
}

func TestTaskProfileParentWithdrawalDuringProviderQualificationPreventsSend(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	var catalogues atomic.Int32
	f.task.pipe.notifications = func(q taskIngressTestRPC) [][]byte {
		// First catalogue is Service.Resolve/Supports. The second is inside
		// concrete Client.Create after Task's durable admission and final check.
		if q.Method == "model/list" && catalogues.Add(1) == 2 {
			if err := f.parent.handle.Cancel(context.Background()); err != nil {
				t.Errorf("controlled parent cancellation: %v", err)
			}
		}
		return nil
	}
	out, err := g.Create(context.Background(), "create", TaskIngressCreateRequest{Message: "must not send after parent withdrawal"})
	if catalogues.Load() != 2 {
		t.Fatalf("did not reach concrete post-admission qualification: %d", catalogues.Load())
	}
	if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
		t.Fatalf("parent revoked during concrete qualification still dispatched: thread=%d turn=%d out=%+v err=%v", f.task.pipe.count("thread/start"), f.task.pipe.count("turn/start"), out, err)
	}
}

func TestTaskProfileParentWithdrawalBetweenCreateWritesRetainsOriginalThread(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	g := f.selectTurn(t, 1)
	f.task.pipe.notifications = func(q taskIngressTestRPC) [][]byte {
		if q.Method == "thread/start" {
			if err := f.parent.handle.Cancel(context.Background()); err != nil {
				t.Errorf("controlled parent cancellation: %v", err)
			}
		}
		return nil
	}
	_, _ = g.Create(context.Background(), "create", TaskIngressCreateRequest{Message: "thread created, parent withdrawn before turn"})
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 0 {
		t.Fatalf("new turn after withdrawn parent: thread=%d turn=%d", f.task.pipe.count("thread/start"), f.task.pipe.count("turn/start"))
	}
	op, err := f.task.store.Lookup(context.Background(), "create")
	if err != nil || op == nil || op.Intent.OperationID != "create" || op.Receipt.State != task.Uncertain || op.Settled || op.Lineage.ThreadID != "thread-exact" {
		t.Fatal("original partial effect lost", op, err)
	}
	_, _ = g.Create(context.Background(), "changed-id", TaskIngressCreateRequest{Message: "no replay"})
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("replacement effect or client")
	}
}

func TestTaskProfileParentWithdrawalDuringContinueHistoryPreventsNewTurn(t *testing.T) {
	f := taskProfileTestSetup(t, false)
	ctx := context.Background()
	first := f.selectTurn(t, 1)
	if _, err := first.Create(ctx, "create", TaskIngressCreateRequest{Message: "original"}); err != nil {
		t.Fatal(err)
	}
	f.task.pipe.complete("turn-1")
	if _, err := first.Observe(ctx); err != nil {
		t.Fatal(err)
	}
	second := f.selectTurn(t, 2)
	f.task.pipe.notifications = func(q taskIngressTestRPC) [][]byte {
		if q.Method == "thread/turns/list" {
			if err := f.parent.handle.Cancel(ctx); err != nil {
				t.Errorf("controlled parent cancellation: %v", err)
			}
		}
		return nil
	}
	_, _ = second.Continue(ctx, "follow", TaskIngressContinueRequest{DispatchID: "create", Message: "same thread, parent must remain current"})
	if f.task.pipe.count("thread/start") != 1 || f.task.pipe.count("turn/start") != 1 || f.task.pipe.launches.Load() != 1 {
		t.Fatal("follow-up dispatched after parent withdrawal")
	}
	op, err := f.task.store.Lookup(ctx, "follow")
	if err != nil || op == nil || op.Receipt.State != task.Uncertain || op.Intent.Expected.ThreadID != "thread-exact" || op.Intent.Expected.TurnID != "turn-1" {
		t.Fatal("original exact parent lost", op, err)
	}
}

func TestTaskProfileDispatchGuardRejectsCrossedOriginalIntent(t *testing.T) {
	for _, field := range []string{"task", "turn", "operation", "parent", "digest", "action"} {
		t.Run(field, func(t *testing.T) {
			f := taskProfileTestSetup(t, false)
			factory := f.profile.newClient
			f.profile.newClient = func(selection codexclient.Selection, q codexclient.FollowupQualification, grant func(context.Context, task.Binding) error, dispatch func(context.Context, task.Intent) error) (*codexclient.Client, error) {
				return factory(selection, q, grant, func(ctx context.Context, original task.Intent) error {
					changed := original
					switch field {
					case "task":
						changed.TaskID = "other-task"
						changed.Admission.TaskID = "other-task"
					case "turn":
						changed.Admission.TurnID = "other-turn"
					case "operation":
						changed.OperationID = "other-operation"
					case "parent":
						changed.Parent.TurnID = "other-parent"
					case "digest":
						changed.Digest = "other-digest"
					case "action":
						changed.Action = task.Continue
					}
					return dispatch(ctx, changed)
				})
			}
			g := f.selectTurn(t, 1)
			_, _ = g.Create(context.Background(), "create", TaskIngressCreateRequest{Message: "bound original intent"})
			if f.task.pipe.count("thread/start") != 0 || f.task.pipe.count("turn/start") != 0 {
				t.Fatal("crossed intent reached provider write")
			}
			op, err := f.task.store.Lookup(context.Background(), "create")
			if err != nil || op == nil || op.Intent.OperationID != "create" || op.Intent.TaskID != "task" || op.Receipt.State != task.Uncertain {
				t.Fatal("original intent replaced or made repeatable", op, err)
			}
		})
	}
}

package boot

// Actual publication/selector/TaskSurface and common framed transport. Existing
// memory journals, synthetic authority and Codex net.Pipe remain CPU fixtures;
// this is integration coverage, not native or live-provider qualification.
import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	"github.com/legrch/farol/modules/task/domain"
	"github.com/legrch/farol/pkg/ipc"
	"github.com/legrch/farol/transport/desktop"
)

func TestTaskPublicationTransportRetainsOriginalHandleClientAndEpoch(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	ctx := context.Background()
	before, err := p.read()
	if err != nil {
		t.Fatal(err)
	}
	h, err := p.selector.BeginPublishedCodex(ctx, p.input)
	if err != nil {
		t.Fatal(err)
	}
	s := p.selector.surface
	record := p.selector.records[h.HandleId]
	first := s.handles[h.HandleId]
	scope := record.input.Scope
	owned := p.f.profile.tasks[scope.TaskID]
	client := owned.client
	if first == nil || first.scope.TaskEpoch != 1 || scope.TaskEpoch != 1 || record.input.Selection != before.Selection || record.input.Parent != p.input.Parent || owned.turns[scope].route != record.route || len(p.f.profile.clients) != 1 || p.f.task.pipe.launches.Load() != 0 || p.f.task.store.snapshot != nil {
		t.Fatal("published selection changed the original lazy scope/client")
	}
	peer := taskWireTestConnectMethods(t, s.Methods(), p.f.profile.peer)
	resolved := taskWireTestData[wire.TaskResolution](t, peer.call("task.resolve", "", taskSurfaceBody(t, h, nil)), "TaskResolution")
	if !resolved.Capabilities.Create || !resolved.Capabilities.Continue || resolved.Binding.ProjectId != p.metadata.ProjectId || resolved.Binding.HostId != p.input.HostID || resolved.Binding.Model != p.metadata.Model || resolved.Binding.ConfigDigest != p.metadata.ConfigDigest {
		t.Fatal("framed resolution did not use the published selection", resolved)
	}
	created := taskWireTestData[wire.TaskMutation](t, peer.call("task.create", "published-create", taskSurfaceBody(t, h, wire.TaskCreate{Message: "published framed task"})), "TaskMutation")
	op, err := p.f.task.store.Lookup(ctx, "published-create")
	expected := task.AdmissionBinding{OwnerID: scope.OwnerID, SessionID: scope.SessionID, TaskID: scope.TaskID, TaskEpoch: 1, ParticipantID: scope.ParticipantID, TurnID: scope.TurnID}
	if err != nil || op == nil || op.Intent.Admission != expected || op.Intent.Binding != before.Selection.Binding || op.Intent.Parent != (task.Parent{ThreadID: p.input.Parent.ThreadID, TurnID: p.input.Parent.TurnID}) || created.TaskId != scope.TaskID || created.OperationId != "published-create" || created.Receipt.Reference.ThreadId == nil || created.Receipt.Reference.TurnId == nil {
		t.Fatal("framed Create substituted the original admission/lineage", created, op, err)
	}
	p.f.task.pipe.complete(*created.Receipt.Reference.TurnId)
	_ = taskWireTestData[wire.TaskStatus](t, peer.call("task.observe", "", taskSurfaceBody(t, h, nil)), "TaskStatus")
	p.publish(t, &p.metadata)
	after, err := p.read()
	if err != nil || after != before || s.handles[h.HandleId] != first || p.f.profile.tasks[scope.TaskID] != owned || owned.client != client {
		t.Fatal("identical publication replaced the original facade/client", err)
	}
	p.f.chat.finish(t, p.f.parent)
	nextChat := chatComputerInput(true)
	nextChat.PreviousHandle = &p.f.parent.id
	parent := p.f.chat.start(t, "published-follow-parent", nextChat)
	next, err := p.selector.ContinueCodex(ctx, *h, "published-create", parent.id)
	if err != nil {
		t.Fatal(err)
	}
	nextScope := p.selector.records[next.HandleId].input.Scope
	expectedScope := scope
	expectedScope.TaskEpoch = 2
	expectedScope.TurnID = nextScope.TurnID
	if next.HandleId == h.HandleId || nextScope != expectedScope || nextScope.TurnID == scope.TurnID || p.f.profile.tasks[scope.TaskID] != owned || owned.client != client || len(p.f.profile.clients) != 1 {
		t.Fatal("follow-up replaced the selected owner/client or epoch")
	}
	follow := taskWireTestData[wire.TaskMutation](t, peer.call("task.continue", "published-follow", taskSurfaceBody(t, next, wire.TaskContinue{DispatchId: "published-create", Message: "same published task"})), "TaskMutation")
	if follow.TaskId != scope.TaskID || follow.Receipt.Reference.ThreadId == nil || *follow.Receipt.Reference.ThreadId != *created.Receipt.Reference.ThreadId || follow.Receipt.Reference.TurnId == nil || *follow.Receipt.Reference.TurnId != "turn-2" {
		t.Fatal("framed Continue lost exact original lineage", follow)
	}
	retained := taskWireTestData[wire.TaskDispatch](t, peer.call("task.result", "", taskSurfaceBody(t, next, wire.TaskDispatchRequest{DispatchId: "published-create"})), "TaskDispatch")
	if retained.TaskId != scope.TaskID || !retained.Retained || retained.Text != "retained turn-1" || p.f.task.pipe.launches.Load() != 1 || p.f.task.pipe.count("thread/start") != 1 || p.f.task.pipe.count("turn/start") != 2 {
		t.Fatal("framed result/continuation replaced the provider lifetime", retained)
	}
}

func taskPublicationTransportRead(t *testing.T, peer *taskWireTestPeer) wire.Response {
	t.Helper()
	raw, err := ipc.ReadFrame(peer.out)
	if err != nil || ipc.ValidateJSON(raw) != nil || wire.Validate("Response", raw) != nil {
		t.Fatal("invalid framed publication response", string(raw), err)
	}
	var response wire.Response
	if err := json.Unmarshal(raw, &response); err != nil {
		t.Fatal(err)
	}
	return response
}

func TestTaskPublicationTransportWithdrawalFencesQueuedEffect(t *testing.T) {
	p := newTaskPublicationFixture(t)
	p.publish(t, &p.metadata)
	h, err := p.selector.BeginPublishedCodex(context.Background(), p.input)
	if err != nil {
		t.Fatal(err)
	}
	methods := p.selector.surface.Methods()
	original := methods["task.resolve"]
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	defer unblock()
	methods["task.resolve"] = desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
		close(entered)
		select {
		case <-release:
			return original.Handle(ctx, request)
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}}
	peer := taskWireTestConnectMethods(t, methods, p.f.profile.peer)
	holder := wire.Request{Jsonrpc: "2.0", Id: "publication-queue-holder", Method: "task.resolve", Params: wire.Call{Context: &peer.scope, Body: json.RawMessage(taskSurfaceBody(t, h, nil))}}
	raw, err := json.Marshal(holder)
	if err != nil || ipc.WriteFrame(peer.in, raw) != nil {
		t.Fatal("queue holder frame", err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("serialized owner did not hold the queue")
	}
	operation := "published-queued-create"
	queued := wire.Request{Jsonrpc: "2.0", Id: "publication-queued-request", Method: "task.create", Params: wire.Call{Context: &peer.scope, OperationId: &operation, Body: json.RawMessage(taskSurfaceBody(t, h, wire.TaskCreate{Message: "withdraw before queued execution"}))}}
	raw, err = json.Marshal(queued)
	if err != nil {
		t.Fatal(err)
	}
	writeStarted, writeDone := make(chan struct{}), make(chan error, 1)
	go func() {
		close(writeStarted)
		writeDone <- ipc.WriteFrame(peer.in, raw)
	}()
	<-writeStarted
	if _, err := p.ingress.Deactivate(context.Background(), "withdraw-queued-publication"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.read(); !errors.Is(err, task.ErrUnavailable) {
		t.Fatal("withdrawn publication remained current", err)
	}
	unblock()
	first := taskPublicationTransportRead(t, peer)
	if first.Id == nil || *first.Id != holder.Id {
		t.Fatal("lost serialized holder response", first)
	}
	if err := <-writeDone; err != nil {
		t.Fatal("queued frame delivery", err)
	}
	response := taskPublicationTransportRead(t, peer)
	if response.Id == nil || *response.Id != queued.Id || response.Result == nil || response.Result.Status == "ok" || response.Result.OperationId == nil || *response.Result.OperationId != operation {
		t.Fatalf("withdrawal did not fence exact queued operation: response=%+v provider thread=%d turn=%d", response, p.f.task.pipe.count("thread/start"), p.f.task.pipe.count("turn/start"))
	}
	if p.f.task.store.snapshot != nil || p.f.task.pipe.launches.Load() != 0 || p.f.task.pipe.count("thread/start") != 0 || p.f.task.pipe.count("turn/start") != 0 {
		t.Fatal("withdrawn queued effect reached admission/provider")
	}
}

func TestTaskPublicationTransportLostReplyReadsOriginalOperationWithoutReplay(t *testing.T) {
	for _, providerReplyLost := range []bool{false, true} {
		t.Run(map[bool]string{false: "desktop-reply", true: "provider-and-desktop-reply"}[providerReplyLost], func(t *testing.T) {
			p := newTaskPublicationFixture(t)
			p.f.task.pipe.dropTurn = providerReplyLost
			p.publish(t, &p.metadata)
			h, err := p.selector.BeginPublishedCodex(context.Background(), p.input)
			if err != nil {
				t.Fatal(err)
			}
			s := p.selector.surface
			first := s.handles[h.HandleId]
			scope := p.selector.records[h.HandleId].input.Scope
			owned := p.f.profile.tasks[scope.TaskID]
			client := owned.client
			methods := s.Methods()
			original := methods["task.create"]
			prepared, delivered := make(chan *desktop.Outcome, 1), make(chan bool, 1)
			release := make(chan struct{})
			var once sync.Once
			unblock := func() { once.Do(func() { close(release) }) }
			defer unblock()
			methods["task.create"] = desktop.Method{Handle: func(ctx context.Context, request desktop.Request) (*desktop.Outcome, error) {
				out, err := original.Handle(ctx, request)
				prepared <- out
				select {
				case <-release:
					return out, err
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}, AfterReply: func(_ desktop.Request, ok bool) { delivered <- ok }}
			peer := taskWireTestConnectMethods(t, methods, p.f.profile.peer)
			operation := "published-lost-reply"
			request := wire.Request{Jsonrpc: "2.0", Id: "published-lost-request", Method: "task.create", Params: wire.Call{Context: &peer.scope, OperationId: &operation, Body: json.RawMessage(taskSurfaceBody(t, h, wire.TaskCreate{Message: "one original published effect"}))}}
			raw, err := json.Marshal(request)
			if err != nil || ipc.WriteFrame(peer.in, raw) != nil {
				t.Fatal("lost-reply request frame", err)
			}
			var out *desktop.Outcome
			select {
			case out = <-prepared:
			case <-time.After(time.Second):
				t.Fatal("original operation did not reach reply delivery")
			}
			wantStatus, wantReceipt := "ok", "known"
			if providerReplyLost {
				wantStatus, wantReceipt = "unknown", "outcome_unknown"
			}
			if out == nil || out.Status != wantStatus {
				t.Fatal("original outcome changed before transport loss", out)
			}
			before, err := p.f.task.store.Lookup(context.Background(), operation)
			if err != nil || before == nil || before.Intent.OperationID != operation || before.Intent.Admission.TaskEpoch != 1 || before.Intent.TaskID != scope.TaskID {
				t.Fatal("original operation was not retained before lost reply", before, err)
			}
			// Close the exact response reader before the server can write any
			// reply. This loses desktop delivery after the original effect owner.
			if err := peer.out.Close(); err != nil {
				t.Fatal(err)
			}
			unblock()
			select {
			case ok := <-delivered:
				if ok {
					t.Fatal("closed response stream reported delivery")
				}
			case <-time.After(time.Second):
				t.Fatal("lost reply did not settle original transport")
			}
			reconnected := taskWireTestConnectMethods(t, s.Methods(), p.f.profile.peer)
			for i := 0; i < 2; i++ {
				retained := taskWireTestData[wire.TaskOperation](t, reconnected.call("task.operation.status", "", taskSurfaceBody(t, h, wire.TaskOperationRequest{OperationId: operation})), "TaskOperation")
				if retained.OperationId != operation || retained.TaskId != scope.TaskID || retained.Action != "create" || retained.Receipt.State != wantReceipt || retained.Lineage.ThreadId == nil || *retained.Lineage.ThreadId != "thread-exact" {
					t.Fatal("reconnect replaced or upgraded original operation", retained)
				}
			}
			after, err := p.f.task.store.Lookup(context.Background(), operation)
			if err != nil || !reflect.DeepEqual(before, after) || s.handles[h.HandleId] != first || first.scope.TaskEpoch != 1 || p.f.profile.tasks[scope.TaskID] != owned || owned.client != client || len(p.f.profile.clients) != 1 || p.f.task.pipe.launches.Load() != 1 || p.f.task.pipe.count("thread/start") != 1 || p.f.task.pipe.count("turn/start") != 1 {
				t.Fatal("operation read changed original scope/client/journal or replayed effect", err)
			}
		})
	}
}

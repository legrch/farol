package task

// These providers and atomic in-memory journals prove application policy only.
// They do not qualify durable filesystem publication, a native host or a provider.
import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/task/app/port"
	"github.com/legrch/farol/modules/task/domain"
)

var ctx = context.Background()

type fakeJournal struct {
	mu                                 sync.Mutex
	tasks                              map[string]port.Snapshot
	ops                                map[string]port.Operation
	lineage                            map[string]task.Reference
	failAdmit, failFinish, failObserve bool
}

func journal() *fakeJournal {
	return &fakeJournal{tasks: map[string]port.Snapshot{}, ops: map[string]port.Operation{}, lineage: map[string]task.Reference{}}
}
func (j *fakeJournal) Lookup(_ context.Context, id string) (*port.Operation, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	op, ok := j.ops[id]
	if !ok {
		return nil, nil
	}
	return &op, nil
}
func (j *fakeJournal) Read(_ context.Context, id string) (*port.Snapshot, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	s, ok := j.tasks[id]
	if !ok {
		return nil, nil
	}
	return &s, nil
}
func (j *fakeJournal) Admit(_ context.Context, i task.Intent, revision uint64, initial task.Task) (*port.Admission, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if op, ok := j.ops[i.OperationID]; ok {
		return &port.Admission{Operation: op, Snapshot: j.tasks[i.TaskID]}, nil
	}
	snapshot, exists := j.tasks[i.TaskID]
	if (i.Action == task.Create && exists) || (i.Action != task.Create && !exists) || snapshot.Revision != revision {
		return nil, task.ErrConflict
	}
	if snapshot.Pending != "" {
		return nil, task.ErrUnknown
	}
	if !exists {
		snapshot.Task = initial
	}
	snapshot.Pending = i.OperationID
	snapshot.Revision++
	op := port.Operation{Intent: i, Receipt: task.Receipt{State: task.Uncertain}}
	j.ops[i.OperationID] = op
	j.tasks[i.TaskID] = snapshot
	if j.failAdmit {
		return nil, errors.New("lost admit acknowledgement")
	}
	return &port.Admission{Operation: op, Snapshot: snapshot, Claimed: true}, nil
}
func (j *fakeJournal) Progress(_ context.Context, id string, ref task.Reference) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op := j.ops[id]
	s := j.tasks[op.Intent.TaskID]
	if s.Pending != id || !j.lineage[id].Extend(ref, op.Intent.Binding.Provider) {
		return task.ErrIdentity
	}
	j.lineage[id] = ref
	op.Lineage = ref
	j.ops[id] = op
	return nil
}
func (j *fakeJournal) Finish(_ context.Context, id string, r task.Receipt, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	op := j.ops[id]
	s := j.tasks[op.Intent.TaskID]
	if s.Pending != id || op.Settled {
		return task.ErrConflict
	}
	if r.State == task.Known && op.Intent.Action != task.Deliver && !j.lineage[id].Extend(r.Reference, op.Intent.Binding.Provider) {
		return task.ErrIdentity
	}
	op.Receipt = r
	op.Settled = true
	s.Task = next
	s.Pending = ""
	s.Revision++
	j.ops[id] = op
	j.tasks[next.ID] = s
	if j.failFinish {
		return errors.New("lost finish acknowledgement")
	}
	return nil
}
func (j *fakeJournal) Observe(_ context.Context, before port.Snapshot, next task.Task) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	s := j.tasks[next.ID]
	if j.failObserve || s.Revision != before.Revision || s.Pending != "" || s.Task.Reference != next.Reference {
		return task.ErrConflict
	}
	s.Task = next
	s.Revision++
	j.tasks[next.ID] = s
	if next.Lifecycle.Terminal() {
		op := j.ops[next.DispatchID]
		op.Receipt.Lifecycle, op.Receipt.Result = next.Lifecycle, next.Result
		j.ops[next.DispatchID] = op
	}
	return nil
}

type fakeAuthority struct {
	parentDenied   bool
	mu             sync.Mutex
	binding        task.Binding
	denied         bool
	checks, denyAt int
}

func binding(p task.Provider) task.Binding {
	return task.Binding{Provider: p, ProfileID: "dev", HostID: "host-A", ProjectID: "project", WorkspaceID: "writer", Project: task.Root{Path: "/fixture/project", Device: "1", Inode: "2", GitCommonDirectory: "/fixture/project/.git"}, Writer: task.Root{Path: "/fixture/writer", Device: "1", Inode: "3", GitCommonDirectory: "/fixture/project/.git"}, ModelAlias: "selected", Model: "installed-model", Effort: "high", ConfigDigest: "config-A"}
}
func (a *fakeAuthority) Resolve(context.Context, port.Selection) (task.Binding, error) {
	return a.binding, nil
}
func (a *fakeAuthority) Recheck(context.Context, task.Binding) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.checks++
	if a.denied || (a.denyAt > 0 && a.checks >= a.denyAt) {
		return task.ErrState
	}
	return nil
}

type fakeProvider struct {
	calls, reads        int
	caps                task.Capabilities
	receipt             task.Receipt
	dispatchErr         error
	observation         port.Observation
	progress            []task.Reference
	ignoreProgressError bool
}

func (p *fakeProvider) Supports(context.Context, task.Binding) (task.Capabilities, error) {
	return p.caps, nil
}
func (p *fakeProvider) Dispatch(_ context.Context, _ port.Dispatch, progress func(task.Reference) error) (task.Receipt, error) {
	p.calls++
	for _, r := range p.progress {
		if err := progress(r); err != nil && !p.ignoreProgressError {
			return task.Receipt{}, err
		}
	}
	return p.receipt, p.dispatchErr
}
func (p *fakeProvider) Observe(context.Context, task.Binding, task.Reference) (port.Observation, error) {
	p.reads++
	return p.observation, nil
}

type fakeDelivery struct {
	calls   int
	err     error
	receipt task.Receipt
	parent  task.Parent
}

func (d *fakeDelivery) Send(_ context.Context, p task.Parent, _ string, _ task.Reference, _ string) (task.Receipt, error) {
	d.calls++
	d.parent = p
	return d.receipt, d.err
}
func setup(p task.Provider) (*Service, *fakeJournal, *fakeAuthority, *fakeProvider, *fakeDelivery) {
	ref := reference(p, "turn-1")
	provider := &fakeProvider{caps: task.Capabilities{Create: true, Continue: p == task.Codex, Resume: p == task.Claude, Message: p == task.Codex, Cancel: p == task.Codex}, receipt: task.Receipt{State: task.Known, Reference: ref, Lifecycle: task.Running}, observation: port.Observation{Reference: ref, Lifecycle: task.Completed, Result: "final"}}
	j := journal()
	a := &fakeAuthority{binding: binding(p)}
	d := &fakeDelivery{receipt: task.Receipt{State: task.Known, Reference: ref}}
	return New(j, a, map[task.Provider]port.Provider{p: provider}, d), j, a, provider, d
}
func reference(p task.Provider, turn string) task.Reference {
	if p == task.Codex {
		return task.Reference{ThreadID: "thread", TurnID: turn}
	}
	invocation := turn
	if turn == "turn-1" {
		invocation = "create-1"
	}
	if turn == "turn-2" {
		invocation = "follow-up"
	}
	return task.Reference{SessionID: "session", InvocationID: invocation}
}
func request(p task.Provider) CreateRequest {
	return CreateRequest{OperationID: "create-1", TaskID: "task-1", Message: "bounded task", Selection: port.Selection{Provider: p, ProjectID: "project", WorkspaceID: "writer", ModelAlias: "selected", Effort: "high"}, Parent: task.Parent{ThreadID: "parent", TurnID: "parent-turn"}}
}
func create(t *testing.T, s *Service, p task.Provider) {
	t.Helper()
	r, err := s.Create(ctx, request(p))
	if err != nil || r.Receipt.State != task.Known {
		t.Fatalf("create: %+v %v", r, err)
	}
}
func complete(t *testing.T, s *Service) {
	t.Helper()
	r, err := s.Result(ctx, ResultRequest{"task-1"})
	if err != nil || !r.Retained || r.Text != "final" {
		t.Fatalf("result: %+v %v", r, err)
	}
}
func TestCreateRetainsExactBindingAndReplaysWithoutProvider(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			s, j, a, f, _ := setup(p)
			create(t, s, p)
			a.binding.Model = "different-current-model"
			create(t, s, p)
			snapshot, _ := j.Read(ctx, "task-1")
			if f.calls != 1 || snapshot.Task.Binding.Model != "installed-model" || snapshot.Task.Parent.ThreadID != "parent" {
				t.Fatal("binding/replay changed")
			}
			req := request(p)
			req.Message = "changed"
			if _, err := s.Create(ctx, req); !errors.Is(err, task.ErrConflict) {
				t.Fatal(err)
			}
		})
	}
}
func TestLostAcknowledgementsNeverDispatchAgain(t *testing.T) {
	for _, window := range []string{"admit", "dispatch", "finish"} {
		t.Run(window, func(t *testing.T) {
			s, j, a, f, _ := setup(task.Codex)
			switch window {
			case "admit":
				j.failAdmit = true
			case "dispatch":
				f.dispatchErr = errors.New("lost provider acknowledgement")
			case "finish":
				j.failFinish = true
			}
			_, _ = s.Create(ctx, request(task.Codex))
			calls := f.calls
			reconnect := New(j, a, map[task.Provider]port.Provider{task.Codex: f}, nil)
			r, err := reconnect.Create(ctx, request(task.Codex))
			if err != nil {
				t.Fatal(err)
			}
			want := task.Uncertain
			if window == "finish" {
				want = task.Known
			}
			if r.Receipt.State != want || f.calls != calls {
				t.Fatalf("replay %+v calls=%d", r, f.calls)
			}
			req := request(task.Codex)
			req.OperationID = "different-key"
			_, _ = reconnect.Create(ctx, req)
			if f.calls != calls {
				t.Fatal("fresh key duplicated task")
			}
		})
	}
}
func TestConcurrentClaimHasOneWinner(t *testing.T) {
	j := journal()
	intent := task.Intent{OperationID: "op", TaskID: "task", Digest: "digest", Action: task.Create, Binding: binding(task.Codex)}
	initial := task.Task{ID: "task"}
	wins := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	for n := 0; n < 24; n++ {
		wg.Go(func() {
			a, err := j.Admit(ctx, intent, 0, initial)
			if err != nil {
				t.Error(err)
			}
			if a.Claimed {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if wins != 1 {
		t.Fatal(wins)
	}
}
func TestUnsupportedAndWrongProviderControlHaveNoEffect(t *testing.T) {
	s, _, _, f, _ := setup(task.Claude)
	create(t, s, task.Claude)
	for _, action := range []task.Action{task.Message, task.Cancel, task.Continue} {
		_, err := s.Control(ctx, MutationRequest{"control-" + string(action), "task-1", "follow-up", action})
		if err == nil {
			t.Fatal(action)
		}
	}
	if f.calls != 1 {
		t.Fatal(f.calls)
	}
	_, err := s.Control(ctx, MutationRequest{"resume", "task-1", "follow-up", task.Resume})
	if !errors.Is(err, task.ErrState) {
		t.Fatal(err)
	}
}
func TestContinuationMustKeepSessionAndChangeTurn(t *testing.T) {
	for _, p := range []task.Provider{task.Codex, task.Claude} {
		t.Run(string(p), func(t *testing.T) {
			s, j, _, f, _ := setup(p)
			create(t, s, p)
			complete(t, s)
			action := task.Continue
			if p == task.Claude {
				action = task.Resume
			}
			f.receipt.Reference = reference(p, "turn-2")
			r, err := s.Control(ctx, MutationRequest{"follow-up", "task-1", "next message", action})
			if err != nil || r.Receipt.State != task.Known {
				t.Fatalf("%+v %v", r, err)
			}
			snapshot, _ := j.Read(ctx, "task-1")
			if snapshot.Task.Reference != reference(p, "turn-2") || snapshot.Task.DispatchID != "follow-up" || snapshot.Task.Result != "" {
				t.Fatal(snapshot)
			}
			// Repeat the earlier create/result receipt after a later turn: historical proof.
			create(t, s, p)
			if f.calls != 2 {
				t.Fatal(f.calls)
			}
		})
	}
	for _, ref := range []task.Reference{{ThreadID: "foreign", TurnID: "turn-2"}, {ThreadID: "thread", TurnID: "turn-1"}} {
		s, _, _, f, _ := setup(task.Codex)
		create(t, s, task.Codex)
		complete(t, s)
		f.receipt.Reference = ref
		r, err := s.Control(ctx, MutationRequest{"follow-up", "task-1", "next", task.Continue})
		if err != nil || r.Receipt.State != task.Uncertain {
			t.Fatalf("%+v %v", r, err)
		}
		_, err = s.Control(ctx, MutationRequest{"new-key", "task-1", "next", task.Continue})
		if !errors.Is(err, task.ErrUnknown) || f.calls != 2 {
			t.Fatal(err, f.calls)
		}
	}
}
func TestCancelAcknowledgementIsNotTerminal(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	f.receipt.CancelRequested = true
	r, err := s.Control(ctx, MutationRequest{"cancel", "task-1", "", task.Cancel})
	if err != nil || !r.Receipt.CancelRequested {
		t.Fatal(r, err)
	}
	f.observation.Lifecycle = task.Running
	f.observation.Result = ""
	status, err := s.Status(ctx, StatusRequest{"task-1"})
	if err != nil || status.Task.Lifecycle != task.Running || !status.Task.CancelRequested {
		t.Fatal(status, err)
	}
	f.observation.Lifecycle = task.Interrupted
	result, err := s.Result(ctx, ResultRequest{"task-1"})
	if err != nil || result.Lifecycle != task.Interrupted || !result.Retained {
		t.Fatal(result, err)
	}
}
func TestMessageMustAcknowledgeExactActiveTurn(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	f.receipt.Reference.TurnID = "foreign"
	r, err := s.Control(ctx, MutationRequest{"steer", "task-1", "adjust task", task.Message})
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
	_, err = s.Control(ctx, MutationRequest{"another-steer", "task-1", "adjust task", task.Message})
	if !errors.Is(err, task.ErrUnknown) || f.calls != 2 {
		t.Fatal(err, f.calls)
	}
}
func TestAuthorityRevocationBeforeEffectAndBeforeDisclosure(t *testing.T) {
	for _, denyAt := range []int{1, 2, 3} {
		t.Run(string(rune('0'+denyAt)), func(t *testing.T) {
			s, _, a, f, _ := setup(task.Codex)
			a.denyAt = denyAt
			_, _ = s.Create(ctx, request(task.Codex))
			if f.calls != 0 {
				t.Fatal("effect after authority loss")
			}
		})
	}
	s, _, a, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	a.denied = true
	_, err := s.Result(ctx, ResultRequest{"task-1"})
	if err == nil || f.reads != 0 {
		t.Fatal("disclosed revoked task")
	}
}
func TestObserveRejectsForeignTurnAndDoesNotPersistFalseTerminal(t *testing.T) {
	s, j, _, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	f.observation.Reference.TurnID = "foreign"
	_, err := s.Result(ctx, ResultRequest{"task-1"})
	if !errors.Is(err, task.ErrIdentity) {
		t.Fatal(err)
	}
	snapshot, _ := j.Read(ctx, "task-1")
	if snapshot.Task.Lifecycle != task.Running {
		t.Fatal(snapshot)
	}
}
func TestTerminalResultPersistsAcrossServiceReconnect(t *testing.T) {
	s, j, a, f, _ := setup(task.Claude)
	create(t, s, task.Claude)
	complete(t, s)
	reconnect := New(j, a, nil, nil)
	r, err := reconnect.Result(ctx, ResultRequest{"task-1"})
	if err != nil || !r.Retained || f.reads != 1 {
		t.Fatal(r, err, f.reads)
	}
}
func TestResultPersistenceLossRemainsUnknown(t *testing.T) {
	s, j, _, _, _ := setup(task.Codex)
	create(t, s, task.Codex)
	j.failObserve = true
	_, err := s.Result(ctx, ResultRequest{"task-1"})
	if !errors.Is(err, task.ErrUnknown) {
		t.Fatal(err)
	}
}
func TestDeliveryIsSeparateFromCompletionAndLostAckCannotResend(t *testing.T) {
	s, j, a, f, d := setup(task.Codex)
	create(t, s, task.Codex)
	complete(t, s)
	if d.calls != 0 {
		t.Fatal("completion delivered implicitly")
	}
	d.err = errors.New("lost parent acknowledgement")
	r, err := s.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
	reconnect := New(j, a, map[task.Provider]port.Provider{task.Codex: f}, d)
	r, err = reconnect.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
	if err != nil || r.Receipt.State != task.Uncertain || d.calls != 1 {
		t.Fatal(r, err, d.calls)
	}
	_, err = reconnect.Deliver(ctx, DeliverRequest{"other-delivery", "task-1"})
	if !errors.Is(err, task.ErrUnknown) || d.calls != 1 || d.parent != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		t.Fatal(err, d)
	}
}
func TestDeliveryAcknowledgementReplaysWithoutSending(t *testing.T) {
	s, _, _, _, d := setup(task.Claude)
	create(t, s, task.Claude)
	complete(t, s)
	for n := 0; n < 2; n++ {
		r, err := s.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
		if err != nil || r.Receipt.State != task.Known {
			t.Fatal(r, err)
		}
	}
	if d.calls != 1 {
		t.Fatal(d.calls)
	}
}
func TestProgressSurvivesLostProviderAck(t *testing.T) {
	s, j, _, f, _ := setup(task.Codex)
	f.progress = []task.Reference{{ThreadID: "thread"}, reference(task.Codex, "turn-1")}
	f.dispatchErr = errors.New("lost terminal acknowledgement")
	r, err := s.Create(ctx, request(task.Codex))
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
	if j.lineage["create-1"] != reference(task.Codex, "turn-1") {
		t.Fatal(j.lineage)
	}
	createReq := request(task.Codex)
	_, _ = s.Create(ctx, createReq)
	if f.calls != 1 {
		t.Fatal(f.calls)
	}
}

func TestDisclosureRechecksAfterEffect(t *testing.T) {
	s, j, a, f, _ := setup(task.Codex)
	a.denyAt = 4
	r, err := s.Create(ctx, request(task.Codex))
	if err == nil || r != nil || f.calls != 1 {
		t.Fatal(r, err, f.calls)
	}
	op, _ := j.Lookup(ctx, "create-1")
	if !op.Settled {
		t.Fatal("lost durable receipt after disclosure refusal")
	}
}
func TestFailedProgressCannotBeIgnoredByProvider(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	f.progress = []task.Reference{{ThreadID: "foreign"}, reference(task.Codex, "turn-1")}
	f.ignoreProgressError = true
	r, err := s.Create(ctx, request(task.Codex))
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
}
func TestDeliveredResultCannotBeSentWithAnotherKey(t *testing.T) {
	s, _, _, _, d := setup(task.Codex)
	create(t, s, task.Codex)
	complete(t, s)
	_, err := s.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Deliver(ctx, DeliverRequest{"different-delivery", "task-1"})
	if !errors.Is(err, task.ErrState) || d.calls != 1 {
		t.Fatal(err, d.calls)
	}
}
func TestTerminalEvidenceSurvivesLaterFollowUp(t *testing.T) {
	s, j, _, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	complete(t, s)
	f.receipt.Reference = reference(task.Codex, "turn-2")
	_, err := s.Control(ctx, MutationRequest{"follow-up", "task-1", "next", task.Continue})
	if err != nil {
		t.Fatal(err)
	}
	op, _ := j.Lookup(ctx, "create-1")
	if op.Receipt.Result != "final" || op.Receipt.Reference != reference(task.Codex, "turn-1") {
		t.Fatal(op)
	}
}

func TestConcurrentCreatesDispatchOnceThroughService(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	var wg sync.WaitGroup
	for n := 0; n < 24; n++ {
		wg.Go(func() {
			r, err := s.Create(ctx, request(task.Codex))
			if err != nil {
				t.Error(err)
			} else if r.Receipt.State != task.Known && r.Receipt.State != task.Uncertain {
				t.Error(r)
			}
		})
	}
	wg.Wait()
	if f.calls != 1 {
		t.Fatal(f.calls)
	}
}
func TestClaudeNeverInventsProviderTurnIdentity(t *testing.T) {
	s, _, _, f, _ := setup(task.Claude)
	f.receipt.Reference = task.Reference{SessionID: "session", TurnID: "invented-turn"}
	r, err := s.Create(ctx, request(task.Claude))
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
}

func (a *fakeAuthority) RecheckParent(_ context.Context, p task.Parent) error {
	if a.parentDenied || p != (task.Parent{ThreadID: "parent", TurnID: "parent-turn"}) {
		return task.ErrState
	}
	return nil
}
func TestUntrustedParentCannotReceiveTaskResult(t *testing.T) {
	s, _, a, f, d := setup(task.Codex)
	req := request(task.Codex)
	req.Parent.ThreadID = "unrelated-root"
	_, err := s.Create(ctx, req)
	if err == nil || f.calls != 0 {
		t.Fatal(err, f.calls)
	}
	create(t, s, task.Codex)
	complete(t, s)
	a.parentDenied = true
	_, err = s.Deliver(ctx, DeliverRequest{"delivery", "task-1"})
	if err == nil || d.calls != 0 {
		t.Fatal(err, d.calls)
	}
}

func TestReconnectQueriesOperationWithoutSubmittingMutation(t *testing.T) {
	for _, window := range []string{"admit", "dispatch", "finish"} {
		t.Run(window, func(t *testing.T) {
			s, j, a, f, _ := setup(task.Codex)
			switch window {
			case "admit":
				j.failAdmit = true
			case "dispatch":
				f.dispatchErr = errors.New("lost ACK")
			case "finish":
				j.failFinish = true
			}
			_, _ = s.Create(ctx, request(task.Codex))
			calls := f.calls
			reconnect := New(j, a, nil, nil)
			r, err := reconnect.Operation(ctx, OperationRequest{"create-1"})
			if err != nil || r.Action != task.Create || f.calls != calls {
				t.Fatal(r, err, f.calls)
			}
			want := task.Uncertain
			if window == "finish" {
				want = task.Known
			}
			if r.Receipt.State != want {
				t.Fatal(r)
			}
		})
	}
}
func TestCancelledCallerCannotDispatchNewEffect(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err := s.Create(cancelled, request(task.Codex))
	if !errors.Is(err, context.Canceled) || f.calls != 0 {
		t.Fatal(err, f.calls)
	}
}
func TestCancelReceiptCannotPretendTerminalProof(t *testing.T) {
	s, _, _, f, _ := setup(task.Codex)
	create(t, s, task.Codex)
	f.receipt.CancelRequested = true
	f.receipt.Lifecycle = task.Interrupted
	r, err := s.Control(ctx, MutationRequest{"cancel", "task-1", "", task.Cancel})
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatal(r, err)
	}
}

func TestClaudeCancelNeedsExplicitCapabilityAndSameInvocation(t *testing.T) {
	s, _, _, f, _ := setup(task.Claude)
	create(t, s, task.Claude)
	f.caps.Cancel = true
	f.receipt.CancelRequested = true
	r, err := s.Control(ctx, MutationRequest{"cancel", "task-1", "", task.Cancel})
	if err != nil || r.Receipt.State != task.Known || r.Receipt.Reference.InvocationID != "create-1" {
		t.Fatal(r, err)
	}
}

func TestRejectionAfterLineageCannotReleaseFence(t *testing.T) {
	s, j, _, f, _ := setup(task.Codex)
	f.progress = []task.Reference{{ThreadID: "thread"}}
	f.receipt = task.Receipt{State: task.Rejected, Code: "TASK_PROVIDER_REFUSED"}
	r, err := s.Create(ctx, request(task.Codex))
	if err != nil || r.Receipt.State != task.Uncertain {
		t.Fatalf("contradictory receipt: %+v %v", r, err)
	}
	snapshot, _ := j.Read(ctx, "task-1")
	if snapshot.Pending != "create-1" || j.lineage["create-1"].ThreadID != "thread" {
		t.Fatal("lost uncertain lineage", snapshot)
	}
	query, err := s.Operation(ctx, OperationRequest{"create-1"})
	if err != nil || query.Lineage.ThreadID != "thread" || query.Receipt.State != task.Uncertain {
		t.Fatal("lost query lineage", query, err)
	}
	_, _ = s.Create(ctx, request(task.Codex))
	if f.calls != 1 {
		t.Fatal("replayed uncertain effect")
	}
}

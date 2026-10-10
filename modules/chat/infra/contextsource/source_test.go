package contextsource_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/domain/contextbudget"
	"github.com/legrch/farol/modules/chat/infra/contextsource"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
)

// Actual lifecycle/queue/output/results/context selector and materializer. Only
// disk journal, Browser observations and selected disclosure are controlled;
// no live credentials, native durability, provider call or shipping is proved.
type journal struct{ revision uint64 }

func (*journal) OpenFresh(_ context.Context, scope port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: scope, Root: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 1000}}, nil
}
func (j *journal) Commit(_ context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	if w.PreviousRevision != j.revision || w.Revision != j.revision+1 {
		return nil, errors.New("fixture CAS conflict")
	}
	j.revision = w.Revision
	return &port.JournalReceipt{Write: w}, nil
}

type browser struct {
	events []port.BrowserObservation
	sent   int
}

func (*browser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	state, id := port.ProviderHome, ""
	if r.Target.Mode == port.OwnedSaved {
		state, id = port.ProviderBound, r.Target.ConversationID
	}
	return &port.PrepareResponse{Readiness: port.Ready, Saved: state == port.ProviderBound, Binding: port.BrowserBinding{ProviderState: state, ConversationID: id, Lease: r.Lease, ViewID: "view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration}}, nil
}
func (*browser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	facts := port.SelectionFacts{ObservedAtMillis: 1, Model: port.ControlFact{Value: r.Requested.ModelID, Literal: "Model", Source: port.FactPublicControl}, Effort: port.ControlFact{Value: r.Requested.Effort, Literal: "Effort", Source: port.FactPublicControl}}
	return &port.SendVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: facts, IntentDigest: r.IntentDigest, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, EvidenceID: "verify-" + r.Binding.Lease.Identity.OperationID}, nil
}
func (b *browser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sent++
	return &port.SendResponse{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: port.Submitted}, nil
}
func (b *browser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	if r.AfterSequence >= uint64(len(b.events)) {
		return &port.ObserveResponse{}, nil
	}
	e := b.events[r.AfterSequence]
	e.Binding, e.Sequence = r.Binding, r.AfterSequence+1
	if e.Kind == port.Accepted && r.Binding.ProviderState == port.ProviderHome {
		e.ProviderConversationID = "original-provider-conversation"
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{e}}, nil
}
func (*browser) Cancel(r port.CancelRequest) (*port.CancelResponse, error) {
	return &port.CancelResponse{Binding: r.Binding, Status: port.CancelUnknown}, nil
}
func (*browser) Dispose(r port.DisposeRequest) (*port.DisposeResponse, error) {
	return &port.DisposeResponse{Lease: r.Lease, Confirmed: true}, nil
}

type disclosure struct {
	mu        sync.Mutex
	binding   contextbudget.Binding
	revoked   bool
	callbacks int
}

func (d *disclosure) WithCurrent(ctx context.Context, inspect func(contextbudget.Binding) error) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if ctx.Err() != nil || d.revoked {
		return contextbudget.Stale
	}
	n := d.callbacks
	if n < 0 {
		return nil
	}
	if n == 0 {
		n = 1
	}
	for range n {
		if err := inspect(d.binding); err != nil {
			return err
		}
	}
	return nil
}

type estimate struct{}

func (estimate) EstimateTokens(raw string) (int, error) { return len(raw), nil }
func inputs() (port.ConversationInput, contextbudget.Binding) {
	b := port.TurnBinding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 1, ParticipantID: "participant", TurnID: "turn-original-1", OperationID: "operation-original-1", TurnGeneration: 1}
	s := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}
	return port.ConversationInput{Binding: b, Selection: s, Required: port.RequiredControls{Model: true, Effort: true}, Prompt: "original user prompt <α>"}, contextbudget.Binding{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration, OwnerID: b.OwnerID, AccountID: s.AccountID, Provider: s.Provider, ModelID: s.ModelID, Effort: s.Effort, CapabilityEpoch: "capability-original"}
}
func owner(t *testing.T) (*lifecycle.Service, *browser, port.ConversationInput, contextbudget.Binding) {
	t.Helper()
	ctx := context.Background()
	i, binding := inputs()
	scope := port.JournalScope{ProfileID: i.Binding.ProfileID, BackendGeneration: i.Binding.BackendGeneration}
	retained, err := results.NewMemory(ctx, scope, results.TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	browser := &browser{}
	s, err := lifecycle.New(ctx, scope, lifecycle.Dependencies{Gate: gate.New(), Journal: &journal{}, Browser: browser, Results: retained, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	return s, browser, i, binding
}
func complete(t *testing.T, s *lifecycle.Service, b *browser, i port.ConversationInput) (*lifecycle.Conversation, port.ConversationInput) {
	t.Helper()
	ctx := context.Background()
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	b.events = []port.BrowserObservation{{Kind: port.Accepted, UserTurnID: "provider-user-original"}, {Kind: port.AnswerDelta, UserTurnID: "provider-user-original", ReplyID: "provider-reply-original", SegmentID: "segment-original", Text: "original answer β"}, {Kind: port.Completed, UserTurnID: "provider-user-original", ReplyID: "provider-reply-original"}, {Kind: port.Quiescent, UserTurnID: "provider-user-original", ReplyID: "provider-reply-original"}}
	if err = c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		if err = c.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	result, err := c.Result(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err = c.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if err = c.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	next := i
	next.Binding.TurnID = "turn-original-2"
	next.Binding.OperationID = "operation-original-2"
	next.Binding.TurnGeneration = 2
	next.Prompt = "current original user intent γ"
	return c, next
}
func adapter(t *testing.T, c *lifecycle.Conversation, binding contextbudget.Binding) (*contextsource.Source, *disclosure) {
	t.Helper()
	lease, err := c.CaptureContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	d := &disclosure{binding: binding}
	source, err := contextsource.New(context.Background(), lease, d, binding, intent.SHA256{})
	if err != nil {
		t.Fatal(err)
	}
	return source, d
}
func TestActualLifecycleOriginalContextMaterializesPlan(t *testing.T) {
	s, b, i, binding := owner(t)
	first, next := complete(t, s, b, i)
	latest, err := s.FollowConversation(context.Background(), first, next)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := adapter(t, latest, binding)
	selector, err := contextcheckpoint.New(contextcheckpoint.Dependencies{Gate: gate.New(), Source: source, Digests: intent.SHA256{}, Estimator: estimate{}})
	if err != nil {
		t.Fatal(err)
	}
	policy := contextbudget.Policy{Limit: contextbudget.Metrics{Bytes: 65536, CodePoints: 65536, EstimatedTokens: 65536}, Reserve: contextbudget.Metrics{Bytes: 100, CodePoints: 100, EstimatedTokens: 100}}
	prepared, err := selector.Prepare(context.Background(), binding, "checkpoint-original", "context-operation-original", policy)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := selector.MaterializePlan(context.Background(), prepared, binding)
	if err != nil {
		t.Fatal(err)
	}
	view, err := plan.View(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Items) != 3 || view.Items[0].Content != i.Prompt || view.Items[1].Content != "original answer β" || view.Items[2].Content != next.Prompt {
		t.Fatalf("original history lost: %+v", view.Items)
	}
	if view.Window.Events[0].ID != "provider-user-original" || view.Window.Events[1].ID != "provider-reply-original" || view.Window.Events[2].ID != next.Binding.TurnID || view.Window.Events[0].Turn.OperationID != i.Binding.OperationID || view.Window.Events[2].Turn.OperationID != next.Binding.OperationID {
		t.Fatal("original event/turn identities lost")
	}
	if view.Receipt.Source.Binding != binding || view.Receipt.Policy != policy || view.Receipt.IdentityHash == view.Receipt.InputHash || b.sent != 1 {
		t.Fatal("correlation/budget or effect invariant")
	}
	copy, err := source.Read(context.Background(), binding)
	if err != nil {
		t.Fatal(err)
	}
	copy.Events[0].Text = "mutated copy"
	copy.Events[0].ID = "mutated"
	if err = source.Check(context.Background(), view.Receipt.Source); err != nil {
		t.Fatal(err)
	}
	copy, err = source.Read(context.Background(), binding)
	if err != nil || copy.Events[0].Text != i.Prompt {
		t.Fatal("read changed retained source")
	}
	for _, edit := range []func(*contextbudget.SourceRef){func(r *contextbudget.SourceRef) { r.SHA256 = strings.Repeat("0", 64) }, func(r *contextbudget.SourceRef) { r.Revision++ }, func(r *contextbudget.SourceRef) { r.FirstEventID = "foreign" }, func(r *contextbudget.SourceRef) { r.Binding.CapabilityEpoch = "fresh" }} {
		r := view.Receipt.Source
		edit(&r)
		if err = source.Check(context.Background(), r); !errors.Is(err, contextbudget.Stale) {
			t.Fatal("partial source identity accepted")
		}
	}
}
func TestOriginalDisclosureLeaseNeverReacquired(t *testing.T) {
	for _, change := range []string{"revoked", "account", "epoch", "zero-callback", "duplicate-callback", "cancelled"} {
		t.Run(change, func(t *testing.T) {
			s, _, i, binding := owner(t)
			c, err := s.CreateConversation(context.Background(), i)
			if err != nil {
				t.Fatal(err)
			}
			source, d := adapter(t, c, binding)
			ctx := context.Background()
			d.mu.Lock()
			switch change {
			case "revoked":
				d.revoked = true
			case "account":
				d.binding.AccountID = "other"
			case "epoch":
				d.binding.CapabilityEpoch = "fresh"
			case "zero-callback":
				d.callbacks = -1
			case "duplicate-callback":
				d.callbacks = 2
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			d.mu.Unlock()
			if _, err = source.Read(ctx, binding); !errors.Is(err, contextbudget.Stale) {
				t.Fatalf("original disclosure became current: %v", err)
			}
		})
	}
}
func TestOriginalSourceLeaseRejectsLateFollowAndFreeze(t *testing.T) {
	s, b, i, binding := owner(t)
	first, next := complete(t, s, b, i)
	source, _ := adapter(t, first, binding)
	latest, err := s.FollowConversation(context.Background(), first, next)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = source.Read(context.Background(), binding); !errors.Is(err, contextbudget.Stale) {
		t.Fatal("late follow did not fence original source")
	}
	latestSource, _ := adapter(t, latest, binding)
	if err = s.FreezeAdmissions(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err = latestSource.Read(context.Background(), binding); !errors.Is(err, contextbudget.Stale) {
		t.Fatal("frozen source exposed")
	}
}
func TestSourceRefusesCrossedSelectionBeforeDisclosure(t *testing.T) {
	s, _, i, binding := owner(t)
	c, err := s.CreateConversation(context.Background(), i)
	if err != nil {
		t.Fatal(err)
	}
	lease, err := c.CaptureContext(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"profile", "backend", "owner", "account", "provider", "model", "effort"} {
		t.Run(change, func(t *testing.T) {
			crossed := binding
			switch change {
			case "profile":
				crossed.ProfileID = "other"
			case "backend":
				crossed.BackendGeneration = "other"
			case "owner":
				crossed.OwnerID = "other"
			case "account":
				crossed.AccountID = "other"
			case "provider":
				crossed.Provider = "other"
			case "model":
				crossed.ModelID = "other"
			case "effort":
				crossed.Effort = "other"
			}
			if _, err = contextsource.New(context.Background(), lease, &disclosure{binding: crossed}, crossed, intent.SHA256{}); !errors.Is(err, contextbudget.Stale) {
				t.Fatalf("crossed source qualified: %v", err)
			}
		})
	}
}

func TestActualSourceGateHoldsOriginalOwnerAndPreservesCallbackFailure(t *testing.T) {
	s, _, i, binding := owner(t)
	c, err := s.CreateConversation(context.Background(), i)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := adapter(t, c, binding)
	selector, err := contextcheckpoint.New(contextcheckpoint.Dependencies{Gate: gate.New(), Source: source, Digests: intent.SHA256{}, Estimator: estimate{}})
	if err != nil {
		t.Fatal(err)
	}
	policy := contextbudget.Policy{Limit: contextbudget.Metrics{Bytes: 65536, CodePoints: 65536, EstimatedTokens: 65536}}
	prepared, err := selector.Prepare(context.Background(), binding, "checkpoint-gate", "operation-gate", policy)
	if err != nil {
		t.Fatal(err)
	}
	window, err := selector.Window(context.Background(), prepared)
	if err != nil {
		t.Fatal(err)
	}
	exactFailure := errors.New("original callback failure")
	calls := 0
	if err = source.WithCurrent(context.Background(), window.Source, func() error { calls++; return exactFailure }); err != exactFailure || calls != 1 {
		t.Fatalf("callback wasn't exact: %v / %d", err, calls)
	}
	started := make(chan struct{})
	completed := make(chan error, 1)
	if err = source.WithCurrent(context.Background(), window.Source, func() error {
		// The callback performs no owner reentry. A separate goroutine requests
		// the ordinary owner action; it cannot finish until this guard exits.
		go func() { close(started); completed <- s.FreezeAdmissions(context.Background()) }()
		<-started
		select {
		case <-completed:
			t.Error("source fence did not retain original owner gate")
		default:
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err = <-completed; err != nil {
		t.Fatal(err)
	}
	calls = 0
	if err = source.WithCurrent(context.Background(), window.Source, func() error { calls++; return nil }); err == nil || calls != 0 {
		t.Fatal("frozen source invoked guarded consumer")
	}
	foreign := window.Source
	foreign.SHA256 = strings.Repeat("a", 64)
	if err = source.WithCurrent(context.Background(), foreign, func() error { t.Fatal("partial reference entered source"); return nil }); err == nil {
		t.Fatal("foreign source accepted")
	}
}

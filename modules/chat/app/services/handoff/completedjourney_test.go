package handoff

import (
	"context"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Real lifecycle and handoff owners with CPU browser, storage, terminal and
// host-drain fixtures. This is not native/provider/restart qualification.
type completedBrowser struct{ sends int }

func (*completedBrowser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	b := port.BrowserBinding{ProviderState: port.ProviderHome, Lease: r.Lease, ViewID: "view", ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration}
	saved := r.Target.Mode == port.OwnedSaved
	if saved {
		b.ProviderState, b.ConversationID = port.ProviderBound, r.Target.ConversationID
	}
	return &port.PrepareResponse{Binding: b, Readiness: port.Ready, Saved: saved}, nil
}
func (*completedBrowser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	return &port.SendVerification{Binding: r.Binding, Pinned: r.Requested, Required: r.Required, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID, IntentDigest: r.IntentDigest, EvidenceID: "verify-" + r.Binding.Lease.Identity.OperationID, Observed: port.SelectionFacts{Model: port.ControlFact{Value: r.Requested.ModelID, Literal: "Model", Source: port.FactPublicControl}, ObservedAtMillis: 1}}, nil
}
func (b *completedBrowser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sends++
	return &port.SendResponse{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: port.Submitted}, nil
}
func (*completedBrowser) Observe(r port.ObserveRequest) (*port.ObserveResponse, error) {
	e := port.BrowserObservation{Binding: r.Binding, Sequence: r.AfterSequence + 1, UserTurnID: "user-" + r.Binding.Lease.Identity.OperationID}
	switch r.AfterSequence {
	case 0:
		e.Kind = port.Accepted
		if r.Binding.ProviderState == port.ProviderHome {
			e.ProviderConversationID = "provider-conversation"
		}
	case 1:
		e.Kind, e.ReplyID, e.SegmentID, e.Text = port.AnswerDelta, "reply-"+r.Binding.Lease.Identity.OperationID, "segment", "retained answer"
	case 2:
		e.Kind, e.ReplyID = port.Completed, "reply-"+r.Binding.Lease.Identity.OperationID
	case 3:
		e.Kind, e.ReplyID = port.Quiescent, "reply-"+r.Binding.Lease.Identity.OperationID
	default:
		return &port.ObserveResponse{}, nil
	}
	return &port.ObserveResponse{Events: []port.BrowserObservation{e}}, nil
}
func (*completedBrowser) Cancel(port.CancelRequest) (*port.CancelResponse, error) {
	panic("unexpected cancellation")
}
func (*completedBrowser) Dispose(port.DisposeRequest) (*port.DisposeResponse, error) {
	panic("unexpected disposal")
}

type completedResults struct {
	root         port.JournalRoot
	records      map[string]port.RetainRequest
	publications map[string]port.ResultPublication
	reads        int
}

func (s *completedResults) Retain(_ context.Context, r port.RetainRequest) (*port.RetainReceipt, error) {
	key := r.Binding.OperationID
	p := port.ResultPublication{Version: 1, Root: s.root, StorageRoot: port.JournalRoot{Device: s.root.Device, Inode: s.root.Inode + 1, OwnerUID: s.root.OwnerUID}, Digest: [32]byte{byte(len(s.records) + 1)}, EncodedBytes: 1024}
	r.Payload = append([]byte(nil), r.Payload...)
	s.records[key], s.publications[key] = r, p
	return &port.RetainReceipt{Binding: r.Binding, Result: r.Result, Bytes: len(r.Payload), Conversation: r.Conversation, Publication: p}, nil
}
func (s *completedResults) Read(_ context.Context, r port.ResultRead) (*port.RetainRequest, error) {
	s.reads++
	v, ok := s.records[r.Binding.OperationID]
	if !ok || v.Binding != r.Binding || v.Result != r.Result || s.publications[r.Binding.OperationID] != r.Publication {
		return nil, Refused
	}
	v.Payload = append([]byte(nil), v.Payload...)
	return &v, nil
}
func (*completedResults) Fence(context.Context) error { panic("unexpected uncertainty") }

func TestActualTwoTurnRetirementCarriesDurableResultsThroughHandoff(t *testing.T) {
	ctx := context.Background()
	bound := binding()
	j := &withdrawalJournal{liveJournal: liveJournal{root: bound.ChatRoot}}
	b := &completedBrowser{}
	results := &completedResults{root: bound.ChatRoot, records: make(map[string]port.RetainRequest), publications: make(map[string]port.ResultPublication)}
	s, err := lifecycle.New(ctx, receipt(bound).Write.Scope, lifecycle.Dependencies{Gate: &sync.Mutex{}, Journal: j, Browser: b, Results: results, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	i := port.ConversationInput{Binding: cancelledReceipt(bound).Write.Turns[0].Binding, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}, Required: port.RequiredControls{Model: true}, Prompt: "synthetic handoff prompt"}
	c, err := s.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 2; n++ {
		if _, err := s.PrepareNext(ctx, 100); err != nil {
			t.Fatal(err)
		}
		if err := c.Send(ctx, 100); err != nil {
			t.Fatal(err)
		}
		for k := 0; k < 3; k++ {
			if err := c.Observe(ctx, 100); err != nil {
				t.Fatal(err)
			}
		}
		r, err := c.Result(ctx)
		if err != nil || !r.Complete {
			t.Fatal("missing completed result", err)
		}
		if err := c.Acknowledge(ctx, r.ResultID); err != nil {
			t.Fatal(err)
		}
		if err := c.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
		if n == 0 {
			i.Binding.OperationID, i.Binding.TurnID = "operation-2", "turn-2"
			i.Binding.TurnGeneration++
			c, err = s.FollowConversation(ctx, c, i)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	origin, err := s.Retire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if b.sends != 2 || results.reads != 2 {
		t.Fatal("retirement lost result or repeated provider work")
	}
	store := &memoryStore{}
	handoff, _ := New(store)
	p, err := handoff.Capture(ctx, bound, "handoff", origin)
	if err != nil {
		t.Fatal(err)
	}
	want := port.CopyRetirement(store.head.Record.Receipt.Write)
	if len(want.Turns) != 2 {
		t.Fatal("incomplete retired registry")
	}
	for _, v := range want.Turns {
		if v.ResultPublication != results.publications[v.Binding.OperationID] || j.writes[v.AcknowledgedRevision-1].Entry.Kind != "acknowledge" || j.writes[v.SettledRevision-1].Entry.Kind != "settle" || j.writes[v.ReleasedRevision-1].Entry.Kind != "release" {
			t.Fatal("original publication or cleanup revision lost")
		}
	}
	ack, err := handoff.Acknowledge(ctx, port.HandoffACK{Publication: *p})
	if err != nil {
		t.Fatal(err)
	}
	if err := handoff.ObserveTerminal(ctx, terminal(*p, ack)); err != nil {
		t.Fatal(err)
	}
	next, err := handoff.Consume(ctx, *p, consumption())
	if err != nil {
		t.Fatal(err)
	}
	if err := next.Proof.WithRetirement(ctx, func(r *port.RetirementReceipt) error {
		if !port.SameRetirement(r.Write, want) {
			t.Fatal("consumed proof changed results")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if b.sends != 2 || len(results.records) != 2 {
		t.Fatal("handoff executed replacement work")
	}
}

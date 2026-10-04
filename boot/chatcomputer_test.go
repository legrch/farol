package boot

// Controlled aggregate: real Chat lifecycle, browser adapter and result store;
// only journal persistence and the physical browser boundary are scripted.
// This is not native storage, DOM, installed-provider or delivery acceptance.
import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	wire "github.com/legrch/farol/gen/desktop/v1"
	chatport "github.com/legrch/farol/modules/chat/app/port"
	chatlifecycle "github.com/legrch/farol/modules/chat/app/services/lifecycle"
	chatct "github.com/legrch/farol/modules/chat/contracts/admission"
	conversation "github.com/legrch/farol/modules/chat/contracts/conversation"
	browser "github.com/legrch/farol/modules/chat/infra/browser"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	"github.com/legrch/farol/modules/chat/infra/results"
	"github.com/legrch/farol/modules/computer/domain/authority"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

type chatComputerJournal struct {
	revision uint64
	entries  []chatport.JournalEntry
	fail     string
}

func (j *chatComputerJournal) OpenFresh(_ context.Context, s chatport.JournalScope) (*chatport.JournalHead, error) {
	return &chatport.JournalHead{Scope: s}, nil
}
func (j *chatComputerJournal) Commit(_ context.Context, w chatport.JournalWrite) (*chatport.JournalReceipt, error) {
	if w.PreviousRevision != j.revision {
		return nil, errors.New("controlled revision conflict")
	}
	j.revision = w.Revision
	j.entries = append(j.entries, w.Entry)
	if w.Entry.Kind == j.fail {
		return nil, errors.New("controlled publication ACK lost")
	}
	return &chatport.JournalReceipt{Write: w}, nil
}

type chatComputerClock struct{}

func (chatComputerClock) NowMillis() uint64 { return 1 }

type chatComputerPhysical struct {
	account       browser.AccountObservation
	sends         int
	observes      int
	prepares      int
	distinctViews bool
	verifyHook    func()
}

func (p *chatComputerPhysical) Exchange(_ context.Context, c browser.Command) (browser.Reply, error) {
	switch r := c.(type) {
	case browser.PrepareCommand:
		p.prepares++
		view := "view"
		if p.distinctViews {
			view = fmt.Sprintf("view-%d", r.Lease.SlotOrdinal)
		}
		state, cid := "home", ""
		if r.Target.Mode == "owned-saved" {
			state, cid = "bound", r.Target.ConversationID
		}
		return browser.PreparedReply{Readiness: "ready", Saved: state == "bound", Binding: browser.Binding{ProviderState: state, Lease: r.Lease, ViewID: view, ViewGeneration: r.Lease.SlotGeneration, DocumentGeneration: r.Lease.SlotGeneration, ConversationID: cid}}, nil
	case browser.VerifySendCommand:
		if p.verifyHook != nil {
			p.verifyHook()
		}
		fact := func(value string) browser.ControlFact {
			return browser.ControlFact{Value: value, Literal: value, Source: "public-control"}
		}
		connector := browser.ControlFact{Source: "unknown"}
		if r.Requested.ToolsEnabled {
			connector = fact(r.Requested.ConnectorID)
		}
		return browser.VerifiedReply{Verification: browser.Verification{Account: p.account, Binding: r.Binding, Pinned: r.Requested, Required: r.Required, Observed: browser.SelectionFacts{Model: fact(r.Requested.ModelID), Effort: fact(r.Requested.Effort), Mode: fact(r.Requested.Mode), Connector: connector, ObservedAtMillis: 1}, IntentDigest: r.IntentDigest, EvidenceID: "proof-" + r.Binding.Lease.Identity.OperationID, PreviousUserTurnID: r.PreviousUserTurnID, PreviousReplyID: r.PreviousReplyID}}, nil
	case browser.SendCommand:
		p.sends++
		return browser.SentReply{Binding: r.Binding, VerificationID: r.Verification.EvidenceID, Status: "submitted"}, nil
	case browser.ObserveCommand:
		p.observes++
		e := browser.Observation{Binding: r.Binding, Sequence: r.AfterSequence + 1, ObservedAtMillis: 1, UserTurnID: "user-" + r.Binding.Lease.Identity.TurnID, ReplyID: "reply-" + r.Binding.Lease.Identity.TurnID}
		switch r.AfterSequence {
		case 0:
			e.Kind = "accepted"
			if r.Binding.ProviderState == "home" {
				e.ProviderConversationID = "conversation-" + r.Binding.Lease.Identity.TaskID
			}
		case 1:
			e.Kind, e.SegmentID, e.Text = "answer-delta", "first", "Useful before tool. "
		case 2:
			e.Kind, e.SegmentID, e.Text = "answer-delta", "after", "Continued after read."
		case 3:
			e.Kind = "completed"
		case 4:
			e.Kind = "quiescent"
		default:
			return browser.ObservedReply{}, nil
		}
		return browser.ObservedReply{Events: []browser.Observation{e}}, nil
	default:
		return nil, errors.New("unexpected controlled browser command")
	}
}

type chatComputerFixture struct {
	ingress  *ChatIngress
	service  *chatlifecycle.Service
	journal  *chatComputerJournal
	physical *chatComputerPhysical
}

func newChatComputerFixture(t *testing.T) *chatComputerFixture {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	scope := chatport.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
	physical := &chatComputerPhysical{}
	adapter, err := browser.New(ctx, browser.Scope{ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, physical, chatComputerClock{})
	if err != nil {
		t.Fatal(err)
	}
	retained, err := results.NewMemory(ctx, scope, results.TextLimits())
	if err != nil {
		t.Fatal(err)
	}
	journal := &chatComputerJournal{}
	service, err := chatlifecycle.New(ctx, scope, chatlifecycle.Dependencies{Gate: gate.New(), Journal: journal, Browser: adapter, Results: retained, ResultBytesLimit: chatlifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
	if err != nil {
		t.Fatal(err)
	}
	ingress, err := NewChatIngress(conversation.New(service), wire.Context{ProfileId: scope.ProfileID, BackendGeneration: scope.BackendGeneration}, "owner")
	if err != nil {
		t.Fatal(err)
	}
	return &chatComputerFixture{ingress: ingress, service: service, journal: journal, physical: physical}
}
func chatComputerInput(tools bool) wire.ChatCreate {
	selection := wire.BrowserSelection{Provider: "farol", Alias: "chatgpt", AccountId: "controlled-account", ModelId: "controlled-model", Effort: "low", Mode: "standard", ToolsEnabled: tools}
	if tools {
		selection.ConnectorId = "connector"
		selection.ConnectorGrantId = "grant"
	}
	return wire.ChatCreate{Required: wire.BrowserRequiredControls{Model: true, Effort: true, Mode: true, Connector: tools}, SessionId: "session", Prompt: "Controlled useful conversation", Selection: selection, Resolution: wire.BrowserResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", RequestedMode: "standard", ConfigSHA256: strings.Repeat("a", 64), TranslationId: "configured", Resolved: selection}}
}
func TestChatComputerIndependentConversationsDoNotReuseParticipant(t *testing.T) {
	f := newChatComputerFixture(t)
	participants := map[string]bool{}
	tasks := map[string]bool{}
	for n := 0; n < 5; n++ {
		h, err := f.ingress.create(context.Background(), fmt.Sprintf("create-%d", n), chatComputerInput(true))
		if err != nil {
			t.Fatal(err)
		}
		if participants[h.Binding.ParticipantId] || h.Binding.ParticipantId == h.Binding.OwnerId || tasks[h.Binding.TaskId] {
			t.Fatal("independent conversation reused a Computer participant", h.Binding)
		}
		participants[h.Binding.ParticipantId] = true
		tasks[h.Binding.TaskId] = true
	}
	if f.physical.sends != 0 || len(f.journal.entries) != 10 {
		t.Fatal("admission dispatched browser or lost journal")
	}
}

func (f *chatComputerFixture) start(t *testing.T, operation string, input wire.ChatCreate) chatHandle {
	t.Helper()
	ctx := context.Background()
	h, err := f.ingress.create(ctx, operation, input)
	if err != nil {
		t.Fatal(err)
	}
	p, err := f.ingress.facade.PrepareNext(ctx, 10000)
	if err != nil || p.Binding.TaskID != h.Binding.TaskId {
		t.Fatal("prepare", p, err)
	}
	actual, err := f.ingress.get(h.HandleId)
	if err != nil {
		t.Fatal(err)
	}
	if err = actual.handle.Send(ctx, 10000); err != nil {
		t.Fatal("send", err)
	}
	for n := 0; n < 2; n++ {
		if err = actual.handle.Observe(ctx, 10000); err != nil {
			t.Fatal("observe before tool", err)
		}
	}
	frames, err := actual.handle.Events(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	useful := false
	for _, frame := range frames {
		if frame.Type == "response.completed" {
			t.Fatal("premature completion")
		}
		if frame.Type == "response.output_text.delta" && strings.Contains(string(frame.JSON), "Useful before tool") {
			useful = true
		}
	}
	if !useful {
		t.Fatal("missing useful text before terminal")
	}
	return actual
}
func (f *chatComputerFixture) finish(t *testing.T, h chatHandle) *conversation.Result {
	t.Helper()
	ctx := context.Background()
	for n := 0; n < 2; n++ {
		if err := h.handle.Observe(ctx, 10000); err != nil {
			t.Fatal("observe after tool", err)
		}
	}
	result, err := h.handle.Result(ctx)
	if err != nil || !result.Complete || result.Acknowledged {
		t.Fatal("result", result, err)
	}
	if err = h.handle.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal("result ACK", err)
	}
	if err = h.handle.Observe(ctx, 10000); err != nil {
		t.Fatal("quiescence", err)
	}
	return result
}
func TestChatComputerFollowupPreservesTaskParticipant(t *testing.T) {
	f := newChatComputerFixture(t)
	first := f.start(t, "create-first", chatComputerInput(true))
	result := f.finish(t, first)
	next := chatComputerInput(true)
	next.PreviousHandle = &first.id
	next.Prompt = "Same conversation follow-up"
	second := f.start(t, "create-follow", next)
	again := f.finish(t, second)
	if first.binding.TaskID != second.binding.TaskID || first.binding.ParticipantID != second.binding.ParticipantID || first.binding.TurnID == second.binding.TurnID || second.binding.TurnGeneration != 2 || result.ConversationID != again.ConversationID || f.physical.sends != 2 {
		t.Fatal("follow-up lost owned identity", first.binding, second.binding)
	}
	retained, err := first.handle.Result(context.Background())
	if err != nil || retained.Text != result.Text || f.physical.sends != 2 {
		t.Fatal("historical result changed or sent again", err)
	}
}

// Only native publication/Store persistence is doubled. Derive/Create, the
// actual repository snapshot, execution lease and workspace service all run.
type chatComputerStore struct {
	*accessrepo.Repository
	approval   authority.Approval
	clock      *computerClockFixture
	revision   uint64
	admits     int
	afterAdmit func()
	fault      string
	entries    []authority.Admission
}

func (s *chatComputerStore) Status(context.Context) (accessrepo.Status, error) {
	if s.fault == "status-after" && s.admits > 0 {
		return accessrepo.Status{}, errors.New("controlled status unavailable")
	}
	return accessrepo.Status{Revision: s.revision, Generation: s.approval.Generation, ApprovalPresent: true}, nil
}
func (*chatComputerStore) UpdateApproval(context.Context, uint64, authority.Approval) error {
	return errors.New("unexpected publication")
}
func (s *chatComputerStore) Admit(ctx context.Context, revision uint64, in authority.Admission, who authority.ParticipantAdmission) (*authority.Participant, error) {
	s.admits++
	if ctx.Err() != nil || revision != s.revision {
		return nil, errors.New("controlled stale revision")
	}
	if s.fault == "refused" {
		return nil, authority.Fail("AUTHORITY_CAPABILITY_DENIED", "task-grant")
	}
	grant, err := authority.Derive(s.approval, in, s.clock.Now())
	if err != nil {
		return nil, err
	}
	participant, err := authority.Create(*grant, who)
	if err != nil {
		return nil, err
	}
	s.entries = append(s.entries, in)
	s.PutParticipant(*participant)
	s.revision++
	if s.afterAdmit != nil {
		s.afterAdmit()
	}
	switch s.fault {
	case "unknown":
		return nil, &accessrepo.CommitFailure{Unknown: true}
	case "nil":
		return nil, nil
	case "crossed":
		out := participant.Clone()
		out.ParticipantID = "foreign"
		return &out, nil
	case "unchanged-revision":
		s.revision--
	}
	return participant, nil
}
func (f *chatComputerFixture) computer(t *testing.T) (*ComputerIngress, *chatComputerStore, *computerWorkspaceFixture, *computerClockFixture) {
	t.Helper()
	clock := &computerClockFixture{now: time.UnixMilli(1900000000000)}
	approval := authority.Approval{OwnerID: "owner", ComputerID: "computer", Generation: 3, Workspaces: []authority.ApprovedWorkspace{{WorkspaceID: "work", Root: "/disposable", Access: authority.ReadAccess, RootIdentity: authority.RootIdentity{Device: "1", Inode: "2"}}}, Capabilities: []authority.Capability{authority.List, authority.Read}, Network: authority.NoNetwork, Commands: authority.NoCommands, ExpiresAt: clock.Now().Add(time.Hour)}
	store := &chatComputerStore{Repository: accessrepo.New(), approval: approval, clock: clock, revision: 1}
	store.PutApproval(approval)
	native := &computerWorkspaceFixture{}
	ingress := &ComputerIngress{store: store, chat: f.service, native: native, clock: clock, peer: wire.Context{ProfileId: "profile", BackendGeneration: "backend"}, ownerID: "owner", computerID: "computer", used: make(map[string]bool), tasks: make(map[string]bool), turns: make(map[string]bool), publication: &knownComputerPublication{receipt: wire.ComputerAuthorityPublication{Fence: "1", StoreRevision: "1", Generation: "3"}, approval: approval}}
	if _, err := ingress.guard.deactivate(); err != nil {
		t.Fatal(err)
	}
	return ingress, store, native, clock
}
func (f *chatComputerFixture) count(kind string) int {
	n := 0
	for _, e := range f.journal.entries {
		if e.Kind == kind {
			n++
		}
	}
	return n
}
func TestChatComputerRunningTurnReadThenExactReturnAndObservedContinuation(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "chat-read", chatComputerInput(true))
	ingress, store, native, _ := f.computer(t)
	ctx := context.Background()
	correlation, err := h.handle.ComputerContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	native.after = func() {
		if f.count("request-computer") != 1 || store.admits != 1 {
			t.Error("read preceded durable request/membership")
		}
	}
	result, call, err := ingress.readConversation(ctx, h.handle, *correlation, "attach-read", "relay-call", "work", "note.md")
	if err != nil || result == nil || call == nil || result.Text != "test" {
		t.Fatal("joined read", result, err)
	}
	if result.CallID != "relay-call" || result.TaskID != h.binding.TaskID || result.ParticipantID != h.binding.ParticipantID || result.TurnID != h.binding.TurnID || f.count("admit") != 1 || f.count("request-computer") != 1 || f.count("resolve-computer") != 0 || store.admits != 1 || native.calls != 1 || f.physical.sends != 1 {
		t.Fatal("correlation or effect counts changed", result)
	}
	if _, _, err = ingress.readConversation(ctx, h.handle, *correlation, "attach-again", "relay-call", "work", "note.md"); err == nil || native.calls != 1 || store.admits != 1 {
		t.Fatal("duplicate dispatched", err)
	}
	ack := &conversation.ComputerReturn{Context: *correlation, CallID: "relay-call", Returned: true}
	if err = call.AcknowledgeReturn(ctx, ack); err != nil {
		t.Fatal("exact host return ACK", err)
	}
	if f.count("resolve-computer") != 1 {
		t.Fatal("missing committed resolve")
	}
	retained := f.finish(t, h)
	if retained.Text != "Useful before tool. Continued after read." || native.calls != 1 || f.physical.sends != 1 {
		t.Fatal("continuation", retained)
	}
	current, err := h.handle.Admission()
	if err != nil {
		t.Fatal(err)
	}
	if err = current.WithCurrent(ctx, func(b *chatct.TaskBinding) error {
		if b != nil {
			t.Error("terminal conversation retained admission")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
func TestChatComputerLostReturnACKKeepsCallOutstandingWithoutRepeat(t *testing.T) {
	f := newChatComputerFixture(t)
	h := f.start(t, "chat-lost", chatComputerInput(true))
	ingress, store, native, _ := f.computer(t)
	ctx := context.Background()
	correlation, err := h.handle.ComputerContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, call, err := ingress.readConversation(ctx, h.handle, *correlation, "attach-lost", "relay-lost", "work", "note.md")
	if err != nil {
		t.Fatal(err)
	}
	if err = call.AcknowledgeReturn(ctx, nil); err == nil {
		t.Fatal("lost ACK settled")
	}
	changed := *correlation
	changed.Physical.DocumentGeneration++
	if err = call.AcknowledgeReturn(ctx, &conversation.ComputerReturn{Context: changed, CallID: "relay-lost", Returned: true}); err == nil {
		t.Fatal("foreign physical ACK settled")
	}
	for _, id := range []string{"relay-lost", "fresh-key"} {
		if _, _, err = ingress.readConversation(ctx, h.handle, *correlation, "attach-"+id, id, "work", "note.md"); err == nil {
			t.Fatal("unsettled read repeated")
		}
	}
	if err = h.handle.Send(ctx, 10000); err == nil {
		t.Fatal("second Send permitted")
	}
	if f.count("resolve-computer") != 0 || f.count("request-computer") != 1 || store.admits != 1 || native.calls != 1 || f.physical.sends != 1 {
		t.Fatal("unknown return changed effects")
	}
}
func TestChatComputerForeignContextAndDisabledToolsReachNoComputer(t *testing.T) {
	for _, reason := range []string{"disabled", "task", "participant", "document", "call"} {
		t.Run(reason, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "chat-foreign", chatComputerInput(reason != "disabled"))
			ingress, store, native, _ := f.computer(t)
			ctx := context.Background()
			correlation, err := h.handle.ComputerContext(ctx)
			if reason == "disabled" {
				if err == nil {
					t.Fatal("tool-disabled owner exposed context")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			callID := "call"
			switch reason {
			case "task":
				correlation.Binding.TaskID = "foreign"
			case "participant":
				correlation.Binding.ParticipantID = "foreign"
			case "document":
				correlation.Physical.DocumentGeneration++
			case "call":
				callID = ""
			}
			if _, _, err = ingress.readConversation(ctx, h.handle, *correlation, "attach", callID, "work", "note.md"); err == nil || store.admits != 0 || native.calls != 0 || f.count("request-computer") != 0 {
				t.Fatal("foreign input reached Computer", err)
			}
		})
	}
}
func TestChatComputerAdmissionUncertaintyNeverReadsOrReattaches(t *testing.T) {
	for _, reason := range []string{"unknown", "nil", "crossed", "unchanged-revision", "status-after", "cancel-after", "fence-after", "journal-unknown"} {
		t.Run(reason, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "chat-uncertain", chatComputerInput(true))
			ingress, store, native, _ := f.computer(t)
			ctx := context.Background()
			correlation, err := h.handle.ComputerContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			store.fault = reason
			switch reason {
			case "cancel-after":
				store.afterAdmit = func() {
					if e := h.handle.Cancel(ctx); e != nil {
						t.Error(e)
					}
				}
			case "fence-after":
				store.afterAdmit = func() { _, _ = ingress.guard.deactivate() }
			case "journal-unknown":
				f.journal.fail = "request-computer"
			}
			if _, _, err = ingress.readConversation(ctx, h.handle, *correlation, "attach-uncertain", "call", "work", "note.md"); err == nil || native.calls != 0 {
				t.Fatal("unknown admission read", err)
			}
			expected := 1
			if reason == "journal-unknown" {
				expected = 0
			}
			for _, id := range []string{"call", "replacement"} {
				if _, _, err = ingress.readConversation(ctx, h.handle, *correlation, "attach-"+id, id, "work", "note.md"); err == nil {
					t.Fatal("unknown reattachment")
				}
			}
			if store.admits != expected || native.calls != 0 || f.count("admit") != 1 || f.physical.sends != 1 {
				t.Fatal("unknown repeated effects")
			}
		})
	}
}
func TestChatComputerLeaseRechecksCancellationRevocationAndOriginalDeadline(t *testing.T) {
	for _, reason := range []string{"cancel", "revoke", "deadline", "fence"} {
		t.Run(reason, func(t *testing.T) {
			f := newChatComputerFixture(t)
			h := f.start(t, "chat-disclosure", chatComputerInput(true))
			ingress, store, native, clock := f.computer(t)
			ctx := context.Background()
			correlation, err := h.handle.ComputerContext(ctx)
			if err != nil {
				t.Fatal(err)
			}
			native.after = func() {
				switch reason {
				case "cancel":
					if e := h.handle.Cancel(ctx); e != nil {
						t.Error(e)
					}
				case "revoke":
					store.RevokeParticipant(h.binding.ParticipantID)
				case "deadline":
					clock.now = clock.now.Add(authority.OrdinaryExecutionLifetime)
				case "fence":
					_, _ = ingress.guard.deactivate()
				}
			}
			result, _, err := ingress.readConversation(ctx, h.handle, *correlation, "attach-disclosure", "call", "work", "note.md")
			if err == nil || result != nil || native.calls != 1 || store.admits != 1 || f.count("resolve-computer") != 0 {
				t.Fatal("late data disclosed or lease reminted", result, err)
			}
		})
	}
}

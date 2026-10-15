//go:build darwin || linux

package conversation_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/handoff"
	"github.com/legrch/farol/modules/chat/app/services/lifecycle"
	"github.com/legrch/farol/modules/chat/contracts/conversation"
	"github.com/legrch/farol/modules/chat/infra/intent"
	handoffrepo "github.com/legrch/farol/modules/chat/infra/repos/handoff"
	"golang.org/x/sys/unix"
)

// Facade wiring fixture: actual lifecycle retirement, handoff and private reader
// witness, with disposable handoff files. Journal/result durability, browser,
// host drain and terminal are fixtures, not boot/restart/provider qualification.
type retainedJournal struct {
	journal
	root        port.JournalRoot
	afterCommit func()
}

func (j *retainedJournal) OpenFresh(_ context.Context, s port.JournalScope) (*port.JournalHead, error) {
	return &port.JournalHead{Scope: s, Root: j.root}, nil
}
func (j *retainedJournal) Commit(ctx context.Context, w port.JournalWrite) (*port.JournalReceipt, error) {
	r, err := j.journal.Commit(ctx, w)
	if err == nil && j.afterCommit != nil {
		j.afterCommit()
	}
	return r, err
}
func (j *retainedJournal) Retire(_ context.Context, w port.RetirementWrite) (*port.RetirementReceipt, error) {
	if w.PreviousRevision != j.revision {
		return nil, errors.New("fixture retirement revision")
	}
	return &port.RetirementReceipt{Write: port.CopyRetirement(w), PublicationDigest: [32]byte{7}}, nil
}

type retainedResults struct {
	root          port.JournalRoot
	value         port.RetainRequest
	publication   port.ResultPublication
	readErr       error
	reads, writes int
}

func (r *retainedResults) Retain(_ context.Context, v port.RetainRequest) (*port.RetainReceipt, error) {
	r.writes++
	v.Payload = append([]byte(nil), v.Payload...)
	r.value = v
	r.publication = port.ResultPublication{Version: 1, Root: r.root, StorageRoot: port.JournalRoot{Device: r.root.Device, Inode: r.root.Inode + 1, OwnerUID: r.root.OwnerUID}, Digest: [32]byte{1}, EncodedBytes: 1024}
	return &port.RetainReceipt{Binding: v.Binding, Result: v.Result, Bytes: len(v.Payload), Conversation: v.Conversation, Publication: r.publication}, nil
}
func (r *retainedResults) Read(_ context.Context, q port.ResultRead) (*port.RetainRequest, error) {
	r.reads++
	if r.readErr != nil {
		return nil, r.readErr
	}
	if q.Binding != r.value.Binding || q.Result != r.value.Result || q.Publication != r.publication {
		return nil, handoff.Refused
	}
	v := r.value
	v.Payload = append([]byte(nil), v.Payload...)
	return &v, nil
}
func (*retainedResults) Fence(context.Context) error { panic("unexpected result fence") }

type retainedBrowser struct {
	browser
	prepares     int
	target       port.ConversationTarget
	verification port.VerifySendRequest
	sent         port.SendRequest
}

func (b *retainedBrowser) Prepare(r port.PrepareRequest) (*port.PrepareResponse, error) {
	b.prepares++
	b.target = r.Target
	v, err := b.browser.Prepare(r)
	if r.Target.Mode == port.OwnedSaved {
		v.Saved = true
		v.Binding.ProviderState = port.ProviderBound
		v.Binding.ConversationID = r.Target.ConversationID
	}
	return v, err
}
func (b *retainedBrowser) VerifySend(r port.VerifySendRequest) (*port.SendVerification, error) {
	b.verification = r
	v, err := b.browser.VerifySend(r)
	v.PreviousUserTurnID, v.PreviousReplyID = r.PreviousUserTurnID, r.PreviousReplyID
	return v, err
}
func (b *retainedBrowser) Send(r port.SendRequest) (*port.SendResponse, error) {
	b.sent = r
	return b.browser.Send(r)
}

// Tests are synchronous. Revision pins the original activation so renewed
// authority cannot resurrect the original witness captured by an admitted turn.
type retainedAuthority struct {
	scope    port.HistoryReadScope
	revision uint64
}
type retainedLease struct {
	owner    *retainedAuthority
	revision uint64
}

func (a *retainedAuthority) AdmitHistoryRead(context.Context) (port.HistoryReadLease, error) {
	return &retainedLease{a, a.revision}, nil
}
func (l *retainedLease) WithCurrent(ctx context.Context, f func(port.HistoryReadScope) error) error {
	if ctx.Err() != nil || l.revision != l.owner.revision {
		return handoff.Refused
	}
	return f(l.owner.scope)
}

type retainedFixture struct {
	facade    *conversation.Facade
	history   *conversation.History
	input     conversation.Input
	journal   *retainedJournal
	browser   *retainedBrowser
	results   *retainedResults
	authority *retainedAuthority
}

func newRetainedFixture(t *testing.T) *retainedFixture {
	t.Helper()
	return newRetainedFixtureWithResolution(t, false)
}

func newRetainedFixtureWithResolution(t *testing.T, configured bool) *retainedFixture {
	t.Helper()
	ctx := context.Background()
	parent, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(parent, 0700); err != nil {
		t.Fatal(err)
	}
	chat := filepath.Join(parent, "chat")
	if err = os.Mkdir(chat, 0700); err != nil {
		t.Fatal(err)
	}
	root := func(path string) handoffrepo.Root {
		var s unix.Stat_t
		if err := unix.Lstat(path, &s); err != nil {
			t.Fatal(err)
		}
		return handoffrepo.Root{Path: path, Identity: port.JournalRoot{Device: uint64(s.Dev), Inode: s.Ino, OwnerUID: s.Uid}}
	}
	roots := handoffrepo.Roots{ProfileID: "profile", Parent: root(parent), Chat: root(chat)}
	store, err := handoffrepo.New(ctx, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Error(err)
		}
	})
	bound := port.HandoffBinding{ProfileID: "profile", BackendGeneration: "old-backend", BuildID: "build", HostLifetimeID: "old-host", ChildLaunchID: "old-child", ParentRoot: roots.Parent.Identity, ChatRoot: roots.Chat.Identity}
	oldJournal := &retainedJournal{root: bound.ChatRoot}
	r := &retainedResults{root: bound.ChatRoot}
	deps := func(j *retainedJournal, b port.Browser) lifecycle.Dependencies {
		return lifecycle.Dependencies{Gate: &sync.Mutex{}, Journal: j, Browser: b, Results: r, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}}
	}
	old, err := lifecycle.New(ctx, port.JournalScope{ProfileID: "profile", BackendGeneration: "old-backend"}, deps(oldJournal, &browser{}))
	if err != nil {
		t.Fatal(err)
	}
	i := port.ConversationInput{Binding: port.TurnBinding{ProfileID: "profile", BackendGeneration: "old-backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 31, ParticipantID: "participant", OperationID: "old-operation", TurnID: "old-turn", TurnGeneration: 2}, Required: port.RequiredControls{Model: true, Effort: true}, Selection: port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low"}, Prompt: "synthetic old prompt"}
	if configured {
		i.Resolution = port.ModelResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", Resolved: i.Selection, ConfigSHA256: strings.Repeat("a", 64), TranslationID: "original"}
	}
	c, err := old.CreateConversation(ctx, i)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err = c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	for n := 0; n < 3; n++ {
		if err = c.Observe(ctx, 100); err != nil {
			t.Fatal(err)
		}
	}
	result, err := c.Result(ctx)
	if err != nil || !result.Complete {
		t.Fatal("missing fixture result", err)
	}
	if err = c.Acknowledge(ctx, result.ResultID); err != nil {
		t.Fatal(err)
	}
	if err = c.Observe(ctx, 100); err != nil {
		t.Fatal(err)
	}
	proof, err := old.Retire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	h, err := handoff.New(store)
	if err != nil {
		t.Fatal(err)
	}
	p, err := h.Capture(ctx, bound, "handoff", proof)
	if err != nil {
		t.Fatal(err)
	}
	ack, err := h.Acknowledge(ctx, port.HandoffACK{Publication: *p})
	if err != nil {
		t.Fatal(err)
	}
	zero := 0
	if err = h.ObserveTerminal(ctx, port.HandoffTerminal{Publication: *p, KnownACKDigest: ack, Kind: port.HandoffNormalExit, StopMode: port.HandoffGracefulStop, ExitCode: &zero}); err != nil {
		t.Fatal(err)
	}
	bound.BackendGeneration, bound.HostLifetimeID, bound.ChildLaunchID = "backend", "host", "child"
	scope := port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}
	next, err := h.Consume(ctx, *p, port.HandoffConsumption{PreviousHostDrainConfirmed: true, Next: scope, NextBinding: bound, AttemptID: "attempt"})
	if err != nil {
		t.Fatal(err)
	}
	a := &retainedAuthority{scope: port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner"}}
	reader, err := handoff.NewHistoryReader(next.History, handoff.HistoryDependencies{Authority: a, Results: r, ResultBytesLimit: lifecycle.OutputBytesLimit})
	if err != nil {
		t.Fatal(err)
	}
	j, b := &retainedJournal{root: bound.ChatRoot}, &retainedBrowser{}
	s, err := lifecycle.New(ctx, scope, deps(j, b))
	if err != nil {
		t.Fatal(err)
	}
	input := conversation.Input{Binding: conversation.Binding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", TaskID: "task", TaskEpoch: 31, ParticipantID: "participant", OperationID: "operation", TurnID: "turn", TurnGeneration: 1}, Required: conversation.RequiredControls{Model: true, Effort: true}, Selection: conversation.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "cheap", Effort: "low"}, Prompt: "synthetic new prompt"}
	if configured {
		input.Resolution = conversation.ModelResolution{RequestedAlias: i.Resolution.RequestedAlias, RequestedExecutor: i.Resolution.RequestedExecutor, RequestedEffort: i.Resolution.RequestedEffort, Resolved: input.Selection, ConfigSHA256: i.Resolution.ConfigSHA256, TranslationID: i.Resolution.TranslationID}
	}
	return &retainedFixture{conversation.New(s), conversation.NewHistory(reader), input, j, b, r, a}
}

func TestContinueRetainedAuthorizedPreservesDurableResolution(t *testing.T) {
	for _, change := range []string{"configured", "hash", "translation", "requested-effort", "configured-to-zero", "zero-to-invented", "zero"} {
		t.Run(change, func(t *testing.T) {
			configured := change != "zero" && change != "zero-to-invented"
			f := newRetainedFixtureWithResolution(t, configured)
			switch change {
			case "hash":
				f.input.Resolution.ConfigSHA256 = strings.Repeat("b", 64)
			case "translation":
				f.input.Resolution.TranslationID = "replacement"
			case "requested-effort":
				f.input.Resolution.RequestedEffort = "high"
			case "configured-to-zero":
				f.input.Resolution = conversation.ModelResolution{}
			case "zero-to-invented":
				f.input.Resolution = conversation.ModelResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", Resolved: f.input.Selection, ConfigSHA256: strings.Repeat("a", 64), TranslationID: "invented"}
			}
			h, err := f.facade.ContinueRetainedAuthorized(context.Background(), f.history, "conversation", f.input, retainedGuard)
			if change != "configured" && change != "zero" {
				if h != nil {
					t.Fatal("changed durable resolution returned handle")
				}
				expectRetainedFailure(t, err, "chat-conversation", string(lifecycle.Mismatch))
				if f.journal.revision != 0 || f.browser.prepares != 0 || f.browser.sends != 0 || f.results.writes != 1 {
					t.Fatal("changed durable resolution performed work")
				}
				return
			}
			if err != nil || h == nil || f.journal.revision == 0 || f.browser.prepares != 0 || f.browser.sends != 0 {
				t.Fatal("exact durable resolution was not admitted without dispatch", err)
			}
			original := f.results.value.Conversation.Evidence
			if configured != (original.ResolutionSource == "configured") || (!configured && (original.ResolutionSource != "unknown" || original.Resolution != (port.ModelResolution{}))) {
				t.Fatal("historical resolution provenance changed", original)
			}
		})
	}
}

func retainedGuard(ctx context.Context, c *conversation.SendCurrent) error {
	return c.WithCurrent(ctx, func(*conversation.Binding) error { return nil })
}
func expectRetainedFailure(t *testing.T, err error, source, code string) {
	t.Helper()
	var f *conversation.Failure
	if !errors.As(err, &f) || f.Source != source || f.Code != code || f.Retry != "never" {
		t.Fatalf("failure=%v, want %s/%s", err, source, code)
	}
}

func TestContinueRetainedAuthorizedMapsPromptAnchorsGuardAndReplay(t *testing.T) {
	f := newRetainedFixture(t)
	ctx := context.Background()
	calls, replacement := 0, 0
	var captured *conversation.SendCurrent
	guard := func(ctx context.Context, c *conversation.SendCurrent) error {
		calls++
		captured = c
		if f.browser.verifies != 1 || f.browser.sends != 0 {
			t.Fatal("guard not at final dispatch")
		}
		return c.WithCurrent(ctx, func(b *conversation.Binding) error {
			if *b != f.input.Binding {
				t.Fatal("guard binding changed")
			}
			return nil
		})
	}
	h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, guard)
	if err != nil || h == nil {
		t.Fatal(err)
	}
	revision := f.journal.revision
	replay, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, func(context.Context, *conversation.SendCurrent) error { replacement++; return nil })
	if err != nil || replay == nil || f.journal.revision != revision {
		t.Fatal("replay admitted twice", err)
	}
	if calls != 0 || f.browser.prepares != 0 || f.results.writes != 1 {
		t.Fatal("admission performed effect")
	}
	changed := f.input
	changed.Prompt = "different new prompt"
	if h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", changed, retainedGuard); h != nil || err == nil {
		t.Fatal("changed replay accepted")
	}
	prepared, err := f.facade.PrepareNext(ctx, 100)
	if err != nil || prepared.Binding != f.input.Binding {
		t.Fatal("prepare mapping", err)
	}
	if err = replay.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || replacement != 0 || f.browser.sends != 1 {
		t.Fatal("original final guard replaced")
	}
	if f.browser.sent.Prompt != f.input.Prompt || f.browser.target.Mode != port.OwnedSaved || f.browser.target.ConversationID != "conversation" || f.browser.verification.PreviousUserTurnID != "user" || f.browser.verification.PreviousReplyID != "reply" || f.browser.verification.Requested != f.results.value.Conversation.Requested || f.browser.verification.Required != (port.RequiredControls{Model: true, Effort: true}) {
		t.Fatal("fresh input or retained anchors lost")
	}
	if err = captured.WithCurrent(ctx, func(*conversation.Binding) error { return nil }); err == nil {
		t.Fatal("dispatch capability escaped")
	}
	if _, err = h.Result(ctx); err == nil {
		t.Fatal("old result became new turn result")
	}
	page, err := f.history.List(ctx, 0)
	if err != nil || page.Total != 1 {
		t.Fatal("history changed", err)
	}
	old, err := f.history.Read(ctx, page.Entries[0].Key)
	if err != nil || old.Text != "<answer>\nline two" || f.results.writes != 1 {
		t.Fatal("old retained result changed", err)
	}
}

func TestContinueRetainedAuthorizedRejectsMissingDependencies(t *testing.T) {
	f := newRetainedFixture(t)
	for _, tc := range []struct {
		name         string
		facade       *conversation.Facade
		history      *conversation.History
		auth         conversation.SendAuthorization
		source, code string
	}{
		{"nil facade", nil, f.history, retainedGuard, "chat-conversation", string(lifecycle.Invalid)},
		{"nil service", conversation.New(nil), f.history, retainedGuard, "chat-conversation", string(lifecycle.Invalid)},
		{"nil authorization", f.facade, f.history, nil, "chat-conversation", string(lifecycle.Invalid)},
		{"nil history", f.facade, nil, retainedGuard, "chat-history", string(handoff.Refused)},
		{"nil reader", f.facade, conversation.NewHistory(nil), retainedGuard, "chat-history", string(handoff.Refused)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads := f.results.reads
			h, err := tc.facade.ContinueRetainedAuthorized(context.Background(), tc.history, "conversation", f.input, tc.auth)
			if h != nil {
				t.Fatal("missing dependency returned handle")
			}
			expectRetainedFailure(t, err, tc.source, tc.code)
			if f.results.reads != reads || f.journal.revision != 0 || f.browser.prepares != 0 {
				t.Fatal("missing dependency performed work")
			}
		})
	}
}

func TestContinueRetainedAuthorizedClassifiesHistoryFailures(t *testing.T) {
	for _, name := range []string{"invalid CID", "missing CID", "empty history", "crossed owner", "crossed profile", "crossed backend", "crossed result CID", "missing reply", "corrupt payload", "read error", "nil context", "cancelled context"} {
		t.Run(name, func(t *testing.T) {
			f := newRetainedFixture(t)
			ctx := context.Background()
			cid, code := "conversation", string(handoff.Refused)
			switch name {
			case "invalid CID":
				cid = ""
				code = string(handoff.Invalid)
			case "missing CID":
				cid = "absent"
			case "empty history":
				r, err := handoff.NewEmptyHistoryReader(port.JournalScope{ProfileID: "profile", BackendGeneration: "backend"}, f.authority)
				if err != nil {
					t.Fatal(err)
				}
				f.history = conversation.NewHistory(r)
			case "crossed owner":
				f.authority.scope.OwnerID = "another"
			case "crossed profile":
				f.authority.scope.ProfileID = "another"
			case "crossed backend":
				f.authority.scope.BackendGeneration = "another"
			case "crossed result CID":
				f.results.value.Conversation.ProviderConversationID = "another"
			case "missing reply":
				f.results.value.Conversation.ProviderReplyID = ""
			case "corrupt payload":
				f.results.value.Payload = []byte{0xff}
			case "read error":
				f.results.readErr = errors.New("fixture unavailable")
				code = "CHAT_HISTORY_UNAVAILABLE"
			case "nil context":
				ctx = nil
				code = string(handoff.Invalid)
			case "cancelled context":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
				code = string(handoff.Invalid)
			}
			h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, cid, f.input, retainedGuard)
			if h != nil {
				t.Fatal("invalid history returned handle")
			}
			expectRetainedFailure(t, err, "chat-history", code)
			if f.journal.revision != 0 || f.browser.prepares != 0 || f.browser.sends != 0 || f.results.writes != 1 {
				t.Fatal("history failure performed effect")
			}
		})
	}
}

func TestContinueRetainedAuthorizedLifecycleScopeChecks(t *testing.T) {
	for _, name := range []string{"owner", "profile", "backend", "old operation", "old turn", "selection", "service scope"} {
		t.Run(name, func(t *testing.T) {
			f := newRetainedFixture(t)
			i := f.input
			switch name {
			case "owner":
				i.Binding.OwnerID = "another"
			case "profile":
				i.Binding.ProfileID = "another"
			case "backend":
				i.Binding.BackendGeneration = "old-backend"
			case "old operation":
				i.Binding.OperationID = "old-operation"
			case "old turn":
				i.Binding.TurnID = "old-turn"
			case "selection":
				i.Selection.AccountID = "another"
			case "service scope":
				s, err := lifecycle.New(context.Background(), port.JournalScope{ProfileID: "profile", BackendGeneration: "another"}, lifecycle.Dependencies{Gate: &sync.Mutex{}, Journal: f.journal, Browser: f.browser, Results: f.results, ResultBytesLimit: lifecycle.OutputBytesLimit, IntentDigests: intent.SHA256{}})
				if err != nil {
					t.Fatal(err)
				}
				f.facade = conversation.New(s)
			}
			h, err := f.facade.ContinueRetainedAuthorized(context.Background(), f.history, "conversation", i, retainedGuard)
			if h != nil {
				t.Fatal("crossed lifecycle returned handle")
			}
			expectRetainedFailure(t, err, "chat-conversation", string(lifecycle.Mismatch))
			if f.journal.revision != 0 || f.browser.prepares != 0 {
				t.Fatal("crossed lifecycle admitted work")
			}
		})
	}
}

func TestContinueRetainedAuthorizedPreservesKnownHandleOnLateRefusal(t *testing.T) {
	f := newRetainedFixture(t)
	ctx := context.Background()
	f.journal.afterCommit = func() { f.authority.revision++ }
	h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, retainedGuard)
	if h == nil || f.journal.revision != 1 {
		t.Fatal("lost known admission handle", err)
	}
	expectRetainedFailure(t, err, "chat-conversation", "CHAT_CONVERSATION_UNAVAILABLE")
	f.journal.afterCommit = nil
	inspected := false
	if err := h.WithState(ctx, func(state conversation.State) error {
		inspected = true
		if state.Binding != f.input.Binding || state.HasResult || state.Prepared {
			t.Fatal("partial handle lost original admission")
		}
		return nil
	}); err != nil || !inspected {
		t.Fatal("partial handle unavailable", err)
	}
	// A fresh read lease can select the same predecessor for replay, but it may
	// not replace the original witness held by the already admitted operation.
	replay, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, retainedGuard)
	if err != nil || replay == nil || f.journal.revision != 1 {
		t.Fatal("known replay lost", err)
	}
	if err = h.Send(ctx, 100); err == nil {
		t.Fatal("withdrawn original proof sent")
	}
	if f.browser.prepares != 0 || f.browser.sends != 0 {
		t.Fatal("late refusal caused provider work")
	}
}

func TestContinueRetainedAuthorizedMapsFinalGuardRefusal(t *testing.T) {
	f := newRetainedFixture(t)
	ctx := context.Background()
	calls := 0
	h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, func(ctx context.Context, c *conversation.SendCurrent) error {
		calls++
		return c.WithCurrent(ctx, func(*conversation.Binding) error { return errors.New("fixture disclosure refused") })
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.facade.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err = h.Send(ctx, 100); err != nil || calls != 1 || f.browser.sends != 0 {
		t.Fatal("final guard refusal lost", err)
	}
	result, err := h.Result(ctx)
	if err != nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" {
		t.Fatal("known final refusal missing", result, err)
	}
}

func TestContinueRetainedAuthorizedReplayKeepsOriginalWitness(t *testing.T) {
	f := newRetainedFixture(t)
	ctx := context.Background()
	if h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, retainedGuard); err != nil || h == nil {
		t.Fatal(err)
	}
	f.authority.revision++
	revision := f.journal.revision
	if h, err := f.facade.ContinueRetainedAuthorized(ctx, f.history, "conversation", f.input, retainedGuard); err != nil || h == nil || f.journal.revision != revision {
		t.Fatal("fresh read could not identify exact known replay", err)
	}
	if prepared, err := f.facade.PrepareNext(ctx, 100); err == nil || prepared != nil {
		t.Fatal("replay replaced withdrawn original witness")
	}
	if f.browser.prepares != 0 || f.browser.sends != 0 {
		t.Fatal("withdrawn witness caused browser work")
	}
}

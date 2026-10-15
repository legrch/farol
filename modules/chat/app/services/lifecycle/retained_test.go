package lifecycle

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/domain/turn"
)

// Injected read witnesses exercise the real lifecycle/journal/Send path. These
// tests do not qualify native retained storage or an actual provider restart.
type retainedWitnessFixture struct {
	view      port.HistoryPredecessorView
	withdrawn atomic.Bool
	fault     string
}

func (w *retainedWitnessFixture) WithCurrent(ctx context.Context, f func(port.HistoryPredecessorView) error) error {
	if w == nil || ctx == nil || ctx.Err() != nil || w.withdrawn.Load() {
		return Unavailable
	}
	if w.fault == "missing-callback" {
		return nil
	}
	err := f(w.view)
	if w.fault == "twice" {
		_ = f(w.view)
	}
	if w.withdrawn.Load() || w.fault == "late-failure" {
		return Unavailable
	}
	return err
}

func retainedFixture() *retainedWitnessFixture {
	i := input("1")
	old := route("old")
	old.BackendGeneration = "predecessor-backend"
	facts := fixtureFacts(i.Selection)
	return &retainedWitnessFixture{view: port.HistoryPredecessorView{
		Binding: old, ResultID: "old-result", ProviderConversationID: "fixture-conversation", ProviderUserTurnID: "old-user", ProviderReplyID: "old-reply",
		Requested: i.Selection, Observed: facts, Evidence: port.SelectionEvidence{Requested: i.Selection, Observed: facts},
		CurrentScope: port.HistoryReadScope{ProfileID: i.Binding.ProfileID, BackendGeneration: i.Binding.BackendGeneration, OwnerID: i.Binding.OwnerID},
	}}
}

func retainedGuard(ctx context.Context, c port.SendCurrent) error {
	return c.WithCurrent(ctx, func(port.TurnBinding) error { return nil })
}

func TestRetainedContinuationPreservesHistoricalResolution(t *testing.T) {
	for _, change := range []string{"configured", "hash", "translation", "requested-effort", "configured-to-zero", "zero-to-invented", "zero"} {
		t.Run(change, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			i, w := input("1"), retainedFixture()
			configured := port.ModelResolution{RequestedAlias: "chatgpt", RequestedExecutor: "browser", RequestedEffort: "low", Resolved: i.Selection, ConfigSHA256: strings.Repeat("a", 64), TranslationID: "original"}
			original := configured
			if change == "zero" || change == "zero-to-invented" {
				original = port.ModelResolution{}
			}
			w.view.Evidence.Resolution = original
			w.view.Evidence.ResolutionSource = "configured"
			if original == (port.ModelResolution{}) {
				w.view.Evidence.ResolutionSource = "unknown"
			}
			i.Resolution = original
			switch change {
			case "hash":
				i.Resolution.ConfigSHA256 = strings.Repeat("b", 64)
			case "translation":
				i.Resolution.TranslationID = "replacement"
			case "requested-effort":
				i.Resolution.RequestedEffort = "high"
			case "configured-to-zero":
				i.Resolution = port.ModelResolution{}
			case "zero-to-invented":
				i.Resolution = configured
			}
			c, err := s.ContinueConversation(context.Background(), w, i, retainedGuard)
			if change != "configured" && change != "zero" {
				if !errors.Is(err, Mismatch) || c != nil || j.count() != 0 || len(b.prepares) != 0 || len(b.sent) != 0 {
					t.Fatal("changed historical resolution admitted work", c, err)
				}
				return
			}
			if err != nil || c == nil || j.count() == 0 {
				t.Fatal("exact historical resolution refused", c, err)
			}
			evidence := selectionEvidence(c.handle)
			wantSource := "configured"
			if original == (port.ModelResolution{}) {
				wantSource = "unknown"
			}
			if evidence.Resolution != original || evidence.ResolutionSource != wantSource || len(b.prepares) != 0 || len(b.sent) != 0 {
				t.Fatal("admission invented resolution evidence or dispatched", evidence)
			}
		})
	}
}

func TestRetainedContinuationUsesNewTurnAndOriginalGuard(t *testing.T) {
	s, b, j, _ := conversationOwner(t)
	ctx, i, w := context.Background(), input("1"), retainedFixture()
	i.Prompt = "A new explicit follow-up."
	calls, replacements := 0, 0
	guard := func(ctx context.Context, c port.SendCurrent) error { calls++; return retainedGuard(ctx, c) }
	c, err := s.ContinueConversation(ctx, w, i, guard)
	if err != nil || c == nil {
		t.Fatal(err)
	}
	if s.providerOwners[w.view.ProviderConversationID] != i.Binding {
		t.Fatal("claim missing after durable admission")
	}
	writes := j.count()
	replayed, err := s.ContinueConversation(ctx, retainedFixture(), i, func(ctx context.Context, c port.SendCurrent) error { replacements++; return retainedGuard(ctx, c) })
	if err != nil || replayed != c || j.count() != writes {
		t.Fatal("replay made a replacement", err)
	}
	prepared, err := s.PrepareNext(ctx, 100)
	if err != nil || prepared.ConversationID != w.view.ProviderConversationID {
		t.Fatal("saved preparation refused", err)
	}
	b.events = observations("new-user", "new-reply", "new answer")
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || replacements != 0 || len(b.sent) != 1 || b.sent[0].Prompt != i.Prompt || b.verifies[0].PreviousReplyID != "old-reply" || b.verifies[0].PreviousUserTurnID != "old-user" {
		t.Fatal("lost guard, prompt or anchors")
	}
	observeOK(t, c)
	observeOK(t, c)
	observeOK(t, c)
	r, err := c.Result(ctx)
	if err != nil || r.Text != "new answer" || r.ProviderReplyID != "new-reply" {
		t.Fatal(r, err)
	}
	if err := c.Acknowledge(ctx, r.ResultID); err != nil {
		t.Fatal(err)
	}
	observeOK(t, c)
	next := followInput()
	next.Prompt = "Next current-lifetime turn."
	n, err := s.FollowConversation(ctx, c, next)
	if err != nil {
		t.Fatal("retained root lost Follow", err)
	}
	if _, err = s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err = n.Send(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if len(b.sent) != 2 || calls != 2 || b.sent[1].Prompt != next.Prompt {
		t.Fatal("follow lost original guard")
	}
}

func TestRetainedContinuationRejectsInvalidProvenanceBeforeAdmission(t *testing.T) {
	for _, fault := range []string{"owner", "profile", "backend", "same-backend", "account", "model", "operation", "turn", "result", "cid", "user-anchor", "reply-anchor", "effort-downgrade", "facts", "missing-callback", "twice", "late-failure", "withdrawn", "nil-guard"} {
		t.Run(fault, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			i, w := input("1"), retainedFixture()
			guard := port.SendAuthorization(retainedGuard)
			switch fault {
			case "owner":
				w.view.CurrentScope.OwnerID = "other"
			case "profile":
				w.view.Binding.ProfileID = "other"
			case "backend":
				w.view.CurrentScope.BackendGeneration = "other"
			case "same-backend":
				w.view.Binding.BackendGeneration = i.Binding.BackendGeneration
			case "account":
				i.Selection.AccountID = "other"
			case "model":
				i.Selection.ModelID = "other"
			case "operation":
				i.Binding.OperationID = w.view.Binding.OperationID
			case "turn":
				i.Binding.TurnID = w.view.Binding.TurnID
			case "result":
				w.view.ResultID = ""
			case "cid":
				w.view.ProviderConversationID = ""
			case "user-anchor":
				w.view.ProviderUserTurnID = ""
			case "reply-anchor":
				w.view.ProviderReplyID = ""
			case "effort-downgrade":
				i.Required.Effort = false
			case "facts":
				w.view.Observed.Model.Value = "other"
			case "withdrawn":
				w.withdrawn.Store(true)
			case "nil-guard":
				guard = nil
			default:
				w.fault = fault
			}
			c, err := s.ContinueConversation(context.Background(), w, i, guard)
			if err == nil || c != nil || j.count() != 0 || len(b.prepares) != 0 || len(b.sent) != 0 {
				t.Fatal("invalid evidence admitted", c, err)
			}
		})
	}
}

func TestRetainedContinuationBindsProvenanceAndClaimsOneCID(t *testing.T) {
	s, _, j, _ := conversationOwner(t)
	ctx, i, w := context.Background(), input("1"), retainedFixture()
	if _, err := s.ContinueConversation(ctx, w, i, retainedGuard); err != nil {
		t.Fatal(err)
	}
	writes := j.count()
	for _, kind := range []string{"prompt", "provenance", "other-root"} {
		next, proof := i, retainedFixture()
		switch kind {
		case "prompt":
			next.Prompt = "changed"
		case "provenance":
			proof.view.ResultID = "other-result"
		case "other-root":
			next = input("2")
		}
		if c, err := s.ContinueConversation(ctx, proof, next, retainedGuard); !errors.Is(err, turn.Conflict) || c != nil || j.count() != writes {
			t.Fatal(kind, c, err)
		}
	}
}

func TestRetainedContinuationCannotReplaceCurrentOwnerOrRenewOldWitness(t *testing.T) {
	t.Run("existing-current-owner", func(t *testing.T) {
		s, b, j, _ := conversationOwner(t)
		completedFirst(t, s, b)
		before := j.count()
		if c, err := s.ContinueConversation(context.Background(), retainedFixture(), input("2"), retainedGuard); !errors.Is(err, turn.Conflict) || c != nil || j.count() != before {
			t.Fatal("existing live CID owner overwritten", c, err)
		}
	})
	t.Run("exact-replay-keeps-withdrawn-witness", func(t *testing.T) {
		s, b, j, _ := conversationOwner(t)
		ctx, w, i := context.Background(), retainedFixture(), input("1")
		c, err := s.ContinueConversation(ctx, w, i, retainedGuard)
		if err != nil {
			t.Fatal(err)
		}
		w.withdrawn.Store(true)
		before := j.count()
		replayed, err := s.ContinueConversation(ctx, retainedFixture(), i, retainedGuard)
		if err != nil || replayed != c || j.count() != before {
			t.Fatal("replay replaced source", err)
		}
		if _, err = s.PrepareNext(ctx, 100); err == nil || len(b.prepares) != 0 {
			t.Fatal("fresh witness renewed old operation", err)
		}
	})
}

func TestRetainedContinuationSupportsUnavailableHistoricalEffortControl(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	w, i := retainedFixture(), input("1")
	w.view.Observed.Effort = port.ControlFact{Source: port.FactUnknown}
	w.view.Evidence.Observed = w.view.Observed
	i.Required.Effort = false
	c, err := s.ContinueConversation(context.Background(), w, i, retainedGuard)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.PrepareNext(context.Background(), 100); err != nil {
		t.Fatal(err)
	}
	if err = c.Send(context.Background(), 100); err != nil || len(b.sent) != 1 {
		t.Fatal(err)
	}
}

func TestRetainedContinuationConcurrentClaimAndUnknownJournal(t *testing.T) {
	for _, unknown := range []bool{false, true} {
		t.Run(map[bool]string{false: "known", true: "unknown"}[unknown], func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			entered, release, done := make(chan struct{}), make(chan struct{}), make(chan error, 1)
			j.hook = func(w port.JournalWrite) {
				if w.Entry.Kind == "admit" {
					close(entered)
					<-release
				}
			}
			if unknown {
				j.fault = "nil"
			}
			go func() {
				_, err := s.ContinueConversation(context.Background(), retainedFixture(), input("1"), retainedGuard)
				done <- err
			}()
			<-entered
			if c, err := s.ContinueConversation(context.Background(), retainedFixture(), input("2"), retainedGuard); err != Busy || c != nil {
				t.Fatal("parallel claim", c, err)
			}
			close(release)
			err := <-done
			if (err != nil) != unknown {
				t.Fatal(err)
			}
			j.hook = nil
			before := j.count()
			if c, err := s.ContinueConversation(context.Background(), retainedFixture(), input("2"), retainedGuard); err == nil || c != nil || j.count() != before || len(b.prepares) != 0 {
				t.Fatal("claim replayed", c, err)
			}
			if unknown && (s.pending == nil || s.pending.handle.fixed.OperationID != input("1").Binding.OperationID) {
				t.Fatal("lost original unknown operation")
			}
		})
	}
}

func TestRetainedContinuationWithdrawalAndTailMismatchPreventEffects(t *testing.T) {
	for _, where := range []string{"admit-io", "before-prepare", "prepare-io", "verify", "authorize-wait", "guard-callback", "tail", "freeze"} {
		t.Run(where, func(t *testing.T) {
			s, b, j, _ := conversationOwner(t)
			ctx, w := context.Background(), retainedFixture()
			if where == "admit-io" {
				j.hook = func(v port.JournalWrite) {
					if v.Entry.Kind == "admit" {
						w.withdrawn.Store(true)
					}
				}
			}
			guard := func(ctx context.Context, c port.SendCurrent) error {
				if where == "authorize-wait" {
					w.withdrawn.Store(true)
				}
				return c.WithCurrent(ctx, func(port.TurnBinding) error {
					if where == "guard-callback" {
						w.withdrawn.Store(true)
					}
					return nil
				})
			}
			c, err := s.ContinueConversation(ctx, w, input("1"), guard)
			if where == "admit-io" {
				if c == nil || err == nil || len(b.prepares) != 0 {
					t.Fatal(c, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if where == "before-prepare" {
				w.withdrawn.Store(true)
			}
			if where == "prepare-io" {
				j.hook = func(v port.JournalWrite) {
					if v.Entry.Kind == "reserve" {
						w.withdrawn.Store(true)
					}
				}
			}
			_, err = s.PrepareNext(ctx, 100)
			if where == "before-prepare" || where == "prepare-io" {
				if err == nil || len(b.prepares) != 0 {
					t.Fatal("prepared after withdrawal", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if where == "verify" {
				b.verifyHook = func(*port.SendVerification) { w.withdrawn.Store(true) }
			}
			if where == "tail" {
				b.verifyFault = "reply"
			}
			if where == "freeze" {
				if err = s.FreezeAdmissions(ctx); err != nil {
					t.Fatal(err)
				}
			}
			err = c.Send(ctx, 100)
			if len(b.sent) != 0 {
				t.Fatal("sent after refusal", err)
			}
		})
	}
}

func TestRetainedContinuationWithdrawalAfterFinalGuardPreventsSend(t *testing.T) {
	s, b, _, _ := conversationOwner(t)
	ctx, w := context.Background(), retainedFixture()
	guard := func(ctx context.Context, current port.SendCurrent) error {
		if err := current.WithCurrent(ctx, func(port.TurnBinding) error { return nil }); err != nil {
			return err
		}
		// The read lease is withdrawn before the consumer authorizer returns.
		w.withdrawn.Store(true)
		return nil
	}
	c, err := s.ContinueConversation(ctx, w, input("1"), guard)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PrepareNext(ctx, 100); err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, 100); err != nil {
		t.Fatal("known pre-Send withdrawal failed to settle", err)
	}
	if len(b.sent) != 0 {
		t.Fatal("sent after read withdrawal before authorization returned")
	}
	result, err := c.Result(ctx)
	if err != nil || result == nil || result.Code != "SEND_NOT_SENT" || result.Outcome != "failed" {
		t.Fatal("known no-Send result lost", result, err)
	}
	if err := c.Send(ctx, 100); err == nil || len(b.sent) != 0 {
		t.Fatal("withdrawn Send was retried", err)
	}
}

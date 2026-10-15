package handoff

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// CPU fixtures reuse the existing history authority, chain and durable-result
// seams. They establish no native/provider or continuation-admission evidence.
func TestHistoryPredecessorCapturesExactCompletionWithOneLease(t *testing.T) {
	r, store, authority, results, next := historyFixture(t)
	ctx := context.Background()
	p, err := r.Predecessor(ctx, "provider-conversation")
	if err != nil || p == nil {
		t.Fatal("missing predecessor", err)
	}
	c := results.value.Conversation
	want := port.HistoryPredecessorView{Binding: results.value.Binding, ResultID: results.value.Result.ID,
		ProviderConversationID: c.ProviderConversationID, ProviderUserTurnID: c.ProviderUserTurnID, ProviderReplyID: c.ProviderReplyID,
		Requested: c.Requested, Observed: c.Observed, Evidence: c.Evidence, CurrentScope: authority.scope}
	// The witness owns a value projection and retains no payload/store. Later
	// fixture changes cannot replace its verified original anchors or controls.
	results.value.Conversation.ProviderReplyID = "replacement"
	results.value.Payload = []byte("replacement payload")
	for range 2 {
		calls := 0
		if err := p.WithCurrent(ctx, func(v port.HistoryPredecessorView) error {
			calls++
			if v != want {
				t.Fatal("crossed original/current projection", v)
			}
			v.Binding.OwnerID, v.Evidence.EvidenceID = "changed-copy", "changed-copy"
			return nil
		}); err != nil || calls != 1 {
			t.Fatal("witness callback count/currentness", calls, err)
		}
	}
	if authority.admissions != 1 || store.tails != 1 || store.finds != 0 || store.pages != 0 || results.reads != 1 || store.calls != 4 {
		t.Fatal("witness reacquired authority, repeated IO or published work")
	}
	if raw, err := json.Marshal(p); err != nil || string(raw) != "{}" {
		t.Fatal("opaque witness exposed state/payload", string(raw), err)
	}
	if err := next.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error { return nil }); err != nil {
		t.Fatal("read witness consumed execution proof", err)
	}
}

func TestHistoryPredecessorInvalidEmptyAndMissingRefuse(t *testing.T) {
	r, store, a, results, _ := historyFixture(t)
	for _, cid := range []string{"", "bad id", "bad\t", string([]byte{255}), strings.Repeat("x", 121)} {
		if p, err := r.Predecessor(context.Background(), cid); p != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid CID minted witness", err)
		}
	}
	if a.admissions != 0 || store.tails != 0 || results.reads != 0 {
		t.Fatal("invalid CID reached authority/storage")
	}
	if p, err := r.Predecessor(context.Background(), "missing"); p != nil || !errors.Is(err, Refused) || results.reads != 0 {
		t.Fatal("missing predecessor minted witness", err)
	}
	empty, err := NewEmptyHistoryReader(r.scope, a)
	if err != nil {
		t.Fatal(err)
	}
	if p, err := empty.Predecessor(context.Background(), "provider-conversation"); p != nil || !errors.Is(err, Refused) {
		t.Fatal("empty history minted witness", err)
	}
	for _, reader := range []*HistoryReader{nil, r} {
		if p, err := reader.Predecessor(nil, "provider-conversation"); p != nil || err == nil {
			t.Fatal("nil context/reader minted witness")
		}
	}
}

func TestHistoryPredecessorRejectsCrossedTailBeforeResultIO(t *testing.T) {
	for name, mutate := range map[string]func(*port.HistoryMatch){
		"anchor":         func(v *port.HistoryMatch) { v.Anchor.HeadDigest[0]++ },
		"owner":          func(v *port.HistoryMatch) { v.Turn.Binding.OwnerID = "other" },
		"CID":            func(v *port.HistoryMatch) { v.Turn.Snapshot.Binding.Document.ConversationID = "other" },
		"origin":         func(v *port.HistoryMatch) { v.Origin.Binding.BackendGeneration = "other" },
		"unacknowledged": func(v *port.HistoryMatch) { v.Turn.AcknowledgedRevision = 0 },
		"unreleased":     func(v *port.HistoryMatch) { v.Turn.ReleasedRevision = 0 },
		"publication":    func(v *port.HistoryMatch) { v.Turn.ResultPublication = port.ResultPublication{} },
	} {
		t.Run(name, func(t *testing.T) {
			r, store, _, results, _ := historyFixture(t)
			mutate(&store.match)
			if p, err := r.Predecessor(context.Background(), "provider-conversation"); p != nil || err == nil || results.reads != 0 {
				t.Fatal("crossed tail reached durable read or minted proof", err)
			}
		})
	}
}

type predecessorUnknownStore struct{ port.HandoffHistoryStore }

func (predecessorUnknownStore) HistoryTail(context.Context, port.HistoryAnchor, string, string) (*port.HistoryMatch, error) {
	return nil, Unknown
}

func TestHistoryPredecessorUnknownSelectionRefuses(t *testing.T) {
	r, _, _, results, _ := historyFixture(t)
	r.store = predecessorUnknownStore{r.store}
	if p, err := r.Predecessor(context.Background(), "provider-conversation"); p != nil || !errors.Is(err, Unknown) || results.reads != 0 {
		t.Fatal("unknown selection minted proof", err)
	}
}

func TestHistoryPredecessorSharesReadCorruptionChecks(t *testing.T) {
	for _, fault := range []string{"nil", "error", "binding", "result", "CID", "user", "reply", "generic", "incomplete", "evidence", "capacity", "utf8", "nonlatest"} {
		t.Run(fault, func(t *testing.T) {
			r, store, _, results, _ := historyFixture(t)
			switch fault {
			case "nil", "error":
				results.fault = fault
			case "binding":
				results.value.Binding.OwnerID = "other"
			case "result":
				results.value.Result.ID = "other"
			case "CID":
				results.value.Conversation.ProviderConversationID = "other"
			case "user":
				results.value.Conversation.ProviderUserTurnID = ""
			case "reply":
				results.value.Conversation.ProviderReplyID = ""
			case "generic":
				results.value.Conversation = port.RetainedConversation{}
			case "incomplete":
				results.value.Conversation.Complete = false
			case "evidence":
				results.value.Conversation.Evidence.Observed.Model.Value = "crossed"
			case "capacity":
				results.value.Payload = make([]byte, r.deps.ResultBytesLimit+1)
			case "utf8":
				results.value.Payload = []byte{255}
			case "nonlatest":
				// The tail selects operation, but storage returns a different
				// old completion. A valid historical result is not enough.
				results.value.Binding.OperationID = "older-operation"
				results.value.Result.ID = "older-operation"
			}
			if p, err := r.Predecessor(context.Background(), "provider-conversation"); p != nil || err == nil {
				t.Fatal("invalid durable completion minted witness", err)
			}
			if store.tails != 1 || store.finds != 0 || results.reads != 1 || store.calls != 4 {
				t.Fatal("wrong selection or an effect during proof verification")
			}
			if v, err := r.Read(context.Background(), historyKey()); v != nil || err == nil {
				t.Fatal("Read and predecessor verification diverged", err)
			}
		})
	}
}

func TestHistoryPredecessorMintRechecksSameLeaseAroundIOAndWaits(t *testing.T) {
	for _, at := range []string{"before", "selection", "result", "reactivate-selection", "reactivate-result", "scope-result", "cancel-result", "head-result", "unknown-result", "wait-selection", "wait-after-selection", "wait-after-result", "wait-mint"} {
		t.Run(at, func(t *testing.T) {
			r, store, a, results, _ := historyFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch at {
			case "before":
				a.active = false
			case "selection":
				store.hook = func() { a.active = false }
			case "result":
				results.hook = func() { a.active = false }
			case "reactivate-selection":
				store.hook = func() { a.revision++; a.active = true }
			case "reactivate-result":
				results.hook = func() { a.revision++; a.active = true }
			case "scope-result":
				results.hook = func() { a.scope.OwnerID = "other" }
			case "cancel-result":
				results.hook = cancel
			case "head-result":
				results.hook = func() { r.origin.owner.knownHead[0]++ }
			case "unknown-result":
				results.hook = func() { r.origin.owner.uncertain = true }
			default:
				gateAt := map[string]int{"wait-selection": 1, "wait-after-selection": 2, "wait-after-result": 3, "wait-mint": 4}[at]
				r.origin.owner.guard = &historyWaitGate{inner: r.origin.owner.guard, at: gateAt, revoke: func() { a.revision++ }}
			}
			if p, err := r.Predecessor(ctx, "provider-conversation"); p != nil || err == nil {
				t.Fatal("withdrawn/stale read minted witness", err)
			}
			if a.admissions != 1 || store.calls != 4 {
				t.Fatal("mint reacquired authority or wrote journal")
			}
			if (at == "before" || at == "wait-selection") && store.tails != 0 {
				t.Fatal("withdrawn waiter reached selection")
			}
			if (at == "selection" || at == "reactivate-selection" || at == "wait-after-selection") && results.reads != 0 {
				t.Fatal("withdrawn selection reached result IO")
			}
		})
	}
}

func TestHistoryPredecessorOldWitnessCannotRevive(t *testing.T) {
	for _, change := range []string{"revoke", "reactivate", "scope", "head", "unknown", "guard-wait"} {
		t.Run(change, func(t *testing.T) {
			r, store, a, results, next := historyFixture(t)
			p, err := r.Predecessor(context.Background(), "provider-conversation")
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "revoke":
				a.active = false
			case "reactivate":
				a.revision++
				a.active = true
			case "scope":
				a.scope.OwnerID = "other"
			case "head":
				b := next.History.anchor.Consumption.NextBinding
				if _, err := next.History.owner.Capture(context.Background(), b, "next-handoff", &fixtureOrigin{receipt: receipt(b)}); err != nil {
					t.Fatal(err)
				}
			case "unknown":
				r.origin.owner.uncertain = true
			case "guard-wait":
				r.origin.owner.guard = &historyWaitGate{inner: r.origin.owner.guard, at: 1, revoke: func() { a.revision++ }}
			}
			calls, writes := 0, store.calls
			if err := p.WithCurrent(context.Background(), func(port.HistoryPredecessorView) error { calls++; return nil }); err == nil || calls != 0 {
				t.Fatal("old witness revived", calls, err)
			}
			if a.admissions != 1 || store.tails != 1 || results.reads != 1 || store.calls != writes {
				t.Fatal("proof check reacquired authority or performed IO/effect")
			}
		})
	}
}

func TestHistoryPredecessorCallbackErrorsAndLateWithdrawal(t *testing.T) {
	for _, change := range []string{"error", "cancel", "error-and-cancel", "revoke", "reactivate", "head"} {
		t.Run(change, func(t *testing.T) {
			r, store, a, results, _ := historyFixture(t)
			p, err := r.Predecessor(context.Background(), "provider-conversation")
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			callbackErr := errors.New("consumer refused")
			calls := 0
			err = p.WithCurrent(ctx, func(port.HistoryPredecessorView) error {
				calls++
				// Deterministic fault injection only; real callbacks cannot
				// reenter owners or change authority while holding these gates.
				switch change {
				case "cancel", "error-and-cancel":
					cancel()
				case "revoke":
					a.active = false
				case "reactivate":
					a.revision++
					a.active = true
				case "head":
					r.origin.owner.knownHead[0]++
				}
				if change == "error" || change == "error-and-cancel" {
					return callbackErr
				}
				return nil
			})
			if err == nil || calls != 1 {
				t.Fatal("late invalidation/callback failure lost", calls, err)
			}
			if change == "error" && !errors.Is(err, callbackErr) {
				t.Fatal("callback error lost", err)
			}
			if change == "error-and-cancel" && errors.Is(err, callbackErr) {
				t.Fatal("callback error hid failed final check")
			}
			if store.calls != 4 || store.tails != 1 || results.reads != 1 || a.admissions != 1 {
				t.Fatal("callback check performed IO/effect/readmission")
			}
		})
	}
}

func TestHistoryPredecessorZeroOrInvalidCallHasNoAuthority(t *testing.T) {
	calls := 0
	inspect := func(port.HistoryPredecessorView) error { calls++; return nil }
	for _, p := range []*historyPredecessor{nil, {}} {
		if err := p.WithCurrent(context.Background(), inspect); err == nil {
			t.Fatal("zero proof admitted")
		}
	}
	r, _, _, _, _ := historyFixture(t)
	p, err := r.Predecessor(context.Background(), "provider-conversation")
	if err != nil {
		t.Fatal(err)
	}
	if err := p.WithCurrent(nil, inspect); err == nil {
		t.Fatal("nil context admitted")
	}
	if err := p.WithCurrent(context.Background(), nil); err == nil {
		t.Fatal("nil callback admitted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := p.WithCurrent(ctx, inspect); err == nil {
		t.Fatal("cancelled callback admitted")
	}
	if calls != 0 {
		t.Fatal("invalid witness disclosed view")
	}
}

// Probes both gate ownership and malformed callback delivery without timing
// sleeps. The production authority remains the existing consumer-owned port.
type predecessorLeaseProbe struct {
	inner                   port.HistoryReadLease
	handoff, reader         *trackingGate
	calls, skipAt, repeatAt int
	swallowCrossedAt        int
	t                       *testing.T
}

func (l *predecessorLeaseProbe) WithCurrent(ctx context.Context, inspect func(port.HistoryReadScope) error) error {
	if !l.handoff.inside {
		l.t.Fatal("reader gate acquired before handoff gate")
	}
	l.reader.Lock()
	defer l.reader.Unlock()
	l.calls++
	if l.calls == l.skipAt {
		return nil
	}
	return l.inner.WithCurrent(ctx, func(scope port.HistoryReadScope) error {
		if l.calls == l.swallowCrossedAt {
			scope.OwnerID = "crossed"
			_ = inspect(scope)
			return nil
		}
		err := inspect(scope)
		if l.calls == l.repeatAt && err == nil {
			return inspect(scope)
		}
		return err
	})
}

func TestHistoryPredecessorCallbackRunsOnceUnderOrderedGates(t *testing.T) {
	for _, mode := range []string{"normal", "missing", "duplicate", "swallowed-refusal"} {
		t.Run(mode, func(t *testing.T) {
			r, _, _, _, _ := historyFixture(t)
			witness, err := r.Predecessor(context.Background(), "provider-conversation")
			if err != nil {
				t.Fatal(err)
			}
			p := witness.(*historyPredecessor)
			handoff, reader := &trackingGate{}, &trackingGate{}
			p.origin.owner.guard = handoff
			probe := &predecessorLeaseProbe{inner: p.lease, handoff: handoff, reader: reader, t: t}
			if mode == "missing" {
				probe.skipAt = 2
			}
			if mode == "duplicate" {
				probe.repeatAt = 2
			}
			if mode == "swallowed-refusal" {
				probe.swallowCrossedAt = 2
			}
			p.lease = probe
			calls := 0
			err = p.WithCurrent(context.Background(), func(port.HistoryPredecessorView) error {
				calls++
				if !handoff.inside || !reader.inside {
					t.Fatal("callback escaped owner gates")
				}
				return nil
			})
			expectCall := mode == "normal" || mode == "duplicate"
			if (mode == "normal") != (err == nil) || calls > 1 || (expectCall && calls != 1) || (!expectCall && calls != 0) {
				t.Fatal("malformed callback cardinality accepted", calls, err)
			}
			if handoff.inside || reader.inside {
				t.Fatal("gate left locked")
			}
		})
	}
}

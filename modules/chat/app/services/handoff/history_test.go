package handoff

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// CPU ports only. These fixtures cannot qualify native ancestry, owner access,
// host terminal/drain, boot activation or an actual historical UI read.
type historyStore struct {
	memoryStore
	match               port.HistoryMatch
	pages, finds, tails int
	hook                func()
	pageFault           string
}

func (s *historyStore) HistoryPage(_ context.Context, a port.HistoryAnchor, owner string, offset uint32) (*port.HistoryPage, error) {
	s.pages++
	if s.hook != nil {
		s.hook()
	}
	if a.HeadDigest != s.head.Digest || owner != "owner" {
		return nil, Refused
	}
	p := &port.HistoryPage{Anchor: a, Offset: offset, Total: 1, Entries: []port.HistoryMatch{}}
	if offset == 0 {
		p.Entries = append(p.Entries, s.match)
	}
	switch s.pageFault {
	case "nil":
		return nil, nil
	case "anchor":
		p.Anchor.HeadDigest[0]++
	case "offset":
		p.Offset++
	case "total":
		p.Total = port.MaxRetainedResults + 1
	case "missing":
		p.Entries = nil
	case "duplicate":
		p.Total = 2
		p.Entries = append(p.Entries, s.match)
	}
	return p, nil
}
func (s *historyStore) HistoryFind(_ context.Context, a port.HistoryAnchor, owner string, key port.HistoryKey) (*port.HistoryMatch, error) {
	s.finds++
	if s.hook != nil {
		s.hook()
	}
	if a.HeadDigest != s.head.Digest {
		return nil, Refused
	}
	if owner != "owner" || key.OperationID == "missing" {
		return nil, nil
	}
	v := s.match
	return &v, nil
}

func (s *historyStore) HistoryTail(_ context.Context, a port.HistoryAnchor, owner, conversationID string) (*port.HistoryMatch, error) {
	s.tails++
	if s.hook != nil {
		s.hook()
	}
	if a.HeadDigest != s.head.Digest {
		return nil, Refused
	}
	if owner != "owner" || conversationID == "missing" {
		return nil, nil
	}
	v := s.match
	return &v, nil
}

type historyAuthority struct {
	scope      port.HistoryReadScope
	active     bool
	revision   uint64
	admissions int
}
type historyLease struct {
	owner    *historyAuthority
	revision uint64
}

func (a *historyAuthority) AdmitHistoryRead(context.Context) (port.HistoryReadLease, error) {
	a.admissions++
	if !a.active {
		return nil, Refused
	}
	return &historyLease{a, a.revision}, nil
}
func (l *historyLease) WithCurrent(ctx context.Context, f func(port.HistoryReadScope) error) error {
	if ctx.Err() != nil || !l.owner.active || l.owner.revision != l.revision {
		return Refused
	}
	return f(l.owner.scope)
}

type historyResults struct {
	want  port.ResultRead
	value port.RetainRequest
	reads int
	hook  func()
	fault string
}

func TestHistoryKnownFirstProvisioningHasOnlyAuthorizedEmptyCatalogue(t *testing.T) {
	ctx := context.Background()
	a := &historyAuthority{active: true, scope: port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "fresh", OwnerID: "owner"}}
	r, err := NewEmptyHistoryReader(port.JournalScope{ProfileID: "profile", BackendGeneration: "fresh"}, a)
	if err != nil {
		t.Fatal(err)
	}
	p, err := r.List(ctx, 0)
	if err != nil || p == nil || p.Total != 0 || p.Offset != 0 || p.Entries == nil || len(p.Entries) != 0 {
		t.Fatal("missing exact empty catalogue", err)
	}
	if p, err := r.List(ctx, 1); err == nil || p != nil {
		t.Fatal("invalid offset accepted")
	}
	if p, err := r.Read(ctx, port.HistoryKey{BackendGeneration: "old", OperationID: "operation"}); err == nil || p != nil {
		t.Fatal("fresh reader fabricated history")
	}
	a.active = false
	if p, err := r.List(ctx, 0); err == nil || p != nil {
		t.Fatal("revoked empty catalogue exposed")
	}
	a.active, a.scope.BackendGeneration = true, "replacement"
	if p, err := r.List(ctx, 0); err == nil || p != nil {
		t.Fatal("replacement backend admitted")
	}
	if r, err := NewEmptyHistoryReader(port.JournalScope{}, a); err == nil || r != nil {
		t.Fatal("invalid scope admitted")
	}
}

func (*historyResults) Retain(context.Context, port.RetainRequest) (*port.RetainReceipt, error) {
	panic("history cannot retain")
}
func (*historyResults) Fence(context.Context) error { panic("history cannot publish a result fence") }
func (s *historyResults) Read(_ context.Context, q port.ResultRead) (*port.RetainRequest, error) {
	s.reads++
	if q != s.want {
		return nil, Refused
	}
	if s.hook != nil {
		s.hook()
	}
	if s.fault == "error" {
		return nil, errors.New("read failed")
	}
	if s.fault == "nil" {
		return nil, nil
	}
	v := s.value
	v.Payload = append([]byte(nil), v.Payload...)
	return &v, nil
}
func historyFixture(t *testing.T) (*HistoryReader, *historyStore, *historyAuthority, *historyResults, *Successor) {
	t.Helper()
	ctx := context.Background()
	b := binding()
	receipt := completedReceipt(b)
	store := &historyStore{}
	s, err := New(store)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Capture(ctx, b, "handoff", &fixtureOrigin{receipt: receipt})
	if err != nil {
		t.Fatal(err)
	}
	ack, err := s.Acknowledge(ctx, port.HandoffACK{Publication: *p})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ObserveTerminal(ctx, terminal(*p, ack)); err != nil {
		t.Fatal(err)
	}
	next, err := s.Consume(ctx, *p, consumption())
	if err != nil {
		t.Fatal(err)
	}
	store.match = port.HistoryMatch{Anchor: next.History.anchor, Origin: *p, PreviousRevision: receipt.Write.PreviousRevision, Turn: receipt.Write.Turns[0]}
	a := &historyAuthority{scope: port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "generation-2", OwnerID: "owner"}, active: true, revision: 1}
	selection := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}
	facts := (port.SelectionFacts{Model: port.ControlFact{Value: "model", Literal: "Model", Source: port.FactPublicControl}, ObservedAtMillis: 1}).Projection()
	metadata := port.RetainedConversation{ProviderConversationID: "provider-conversation", ProviderUserTurnID: "provider-user", ProviderReplyID: "provider-reply", Requested: selection, Observed: facts, Complete: true, Evidence: port.SelectionEvidence{Requested: selection, Admitted: selection, Observed: facts, PinnedSource: "configured-pinned-scope", ResolutionSource: "unknown", AdmissionSource: "chat-policy", ObservationSource: "field-facts", EvidenceID: "verified"}}
	v := store.match.Turn
	results := &historyResults{want: port.ResultRead{Binding: v.Binding, Result: v.Snapshot.Result, Publication: v.ResultPublication}, value: port.RetainRequest{Binding: v.Binding, Result: v.Snapshot.Result, Conversation: metadata, Payload: []byte("Retained answer ☀")}}
	r, err := NewHistoryReader(next.History, HistoryDependencies{Authority: a, Results: results, ResultBytesLimit: 8192})
	if err != nil {
		t.Fatal(err)
	}
	return r, store, a, results, next
}
func historyKey() port.HistoryKey {
	return port.HistoryKey{BackendGeneration: "generation-1", OperationID: "operation"}
}

func TestHistoryReadListsAndReturnsOriginalResultWithoutUsingExecutionProof(t *testing.T) {
	r, store, _, results, next := historyFixture(t)
	ctx := context.Background()
	if err := next.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error { return nil }); err != nil {
		t.Fatal(err)
	}
	page, err := r.List(ctx, 0)
	if err != nil || page == nil || page.Total != 1 || len(page.Entries) != 1 || page.Entries[0].Key != historyKey() || results.reads != 0 {
		t.Fatal("listing did not preserve bounded original reference", err)
	}
	for n := 0; n < 2; n++ {
		got, err := r.Read(ctx, page.Entries[0].Key)
		if err != nil || got == nil || got.Binding != results.want.Binding || got.Text != string(results.value.Payload) || got.Requested != results.value.Conversation.Requested || got.Observed != results.value.Conversation.Observed || got.Evidence != results.value.Conversation.Evidence || got.ProviderUserTurnID != "provider-user" || got.ProviderReplyID != "provider-reply" || got.Phase != "delivered" || !got.Complete || !got.Acknowledged {
			t.Fatal("exact historical result missing", err)
		}
		got.Text = "changed returned value"
	}
	if store.calls != 4 || results.reads != 2 {
		t.Fatal("read/list published new work")
	}
	if err := next.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error { return nil }); err == nil {
		t.Fatal("history reset execution proof")
	}
	page, err = r.List(ctx, 1)
	if err != nil || page.Entries == nil || len(page.Entries) != 0 {
		t.Fatal("end page", err)
	}
}

func TestHistoryReadRechecksSameAuthorityAroundEveryIO(t *testing.T) {
	for _, at := range []string{"before", "history", "result", "reactivate-history", "reactivate-result", "scope-result"} {
		t.Run(at, func(t *testing.T) {
			r, store, a, results, _ := historyFixture(t)
			withdraw := func() { a.active = false }
			switch at {
			case "before":
				a.active = false
			case "history":
				store.hook = withdraw
			case "result":
				results.hook = withdraw
			case "reactivate-history":
				store.hook = func() { a.revision++; a.active = true }
			case "reactivate-result":
				results.hook = func() { a.revision++; a.active = true }
			case "scope-result":
				results.hook = func() { a.scope.OwnerID = "other" }
			}
			got, err := r.Read(context.Background(), historyKey())
			if err == nil || got != nil {
				t.Fatal("withdrawn authority exposed content")
			}
			if at == "before" && store.finds != 0 {
				t.Fatal("unadmitted history IO")
			}
			if (at == "history" || at == "reactivate-history") && results.reads != 0 {
				t.Fatal("withdrawn authority reached result IO")
			}
		})
	}
}

func TestHistoryReadRefusesCrossedOriginBeforeResultIO(t *testing.T) {
	for name, mutate := range map[string]func(*port.HistoryMatch){
		"anchor":              func(v *port.HistoryMatch) { v.Anchor.HeadDigest[0]++ },
		"owner":               func(v *port.HistoryMatch) { v.Turn.Binding.OwnerID = "other" },
		"operation":           func(v *port.HistoryMatch) { v.Turn.Binding.OperationID = "other" },
		"old-backend":         func(v *port.HistoryMatch) { v.Origin.Binding.BackendGeneration = "other" },
		"root":                func(v *port.HistoryMatch) { v.Origin.Binding.ChatRoot.Inode++ },
		"build":               func(v *port.HistoryMatch) { v.Origin.Binding.BuildID = "other" },
		"receipt":             func(v *port.HistoryMatch) { v.Origin.ReceiptDigest = [32]byte{} },
		"unacknowledged":      func(v *port.HistoryMatch) { v.Turn.AcknowledgedRevision = 0 },
		"unsettled":           func(v *port.HistoryMatch) { v.Turn.Quiescence.Confirmed = false },
		"missing-publication": func(v *port.HistoryMatch) { v.Turn.ResultPublication = port.ResultPublication{} },
	} {
		t.Run(name, func(t *testing.T) {
			r, s, _, results, _ := historyFixture(t)
			mutate(&s.match)
			got, err := r.Read(context.Background(), historyKey())
			if err == nil || got != nil || results.reads != 0 {
				t.Fatal("crossed original history accepted", err)
			}
		})
	}
}

func TestHistoryReadRefusesBadRetainedPayloadAndLateCancellation(t *testing.T) {
	for _, fault := range []string{"nil", "error", "binding", "result", "metadata", "generic", "capacity", "utf8", "cancel"} {
		t.Run(fault, func(t *testing.T) {
			r, _, _, results, _ := historyFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch fault {
			case "nil", "error":
				results.fault = fault
			case "binding":
				results.value.Binding.OwnerID = "other"
			case "result":
				results.value.Result.ID = "other"
			case "metadata":
				results.value.Conversation.ProviderConversationID = "other"
			case "generic":
				results.value.Conversation = port.RetainedConversation{}
			case "capacity":
				results.value.Payload = make([]byte, 8193)
			case "utf8":
				results.value.Payload = []byte{255}
			case "cancel":
				results.hook = cancel
			}
			got, err := r.Read(ctx, historyKey())
			if err == nil || got != nil {
				t.Fatal("invalid retained result disclosed")
			}
		})
	}
}

func TestHistoryListRejectsMalformedPageOrRevokedLease(t *testing.T) {
	for _, fault := range []string{"nil", "anchor", "offset", "total", "missing", "duplicate", "withdraw"} {
		t.Run(fault, func(t *testing.T) {
			r, s, a, results, _ := historyFixture(t)
			s.pageFault = fault
			if fault == "withdraw" {
				s.hook = func() { a.revision++ }
			}
			got, err := r.List(context.Background(), 0)
			if err == nil || got != nil || results.reads != 0 {
				t.Fatal("invalid page disclosed", err)
			}
		})
	}
}

func TestHistoryReadOriginCannotOutliveNextRetirementPublication(t *testing.T) {
	r, s, _, results, next := historyFixture(t)
	results.hook = func() {
		b := next.History.anchor.Consumption.NextBinding
		if _, err := next.History.owner.Capture(context.Background(), b, "next-handoff", &fixtureOrigin{receipt: receipt(b)}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := r.Read(context.Background(), historyKey())
	if err == nil || got != nil {
		t.Fatal("old history origin survived next retirement")
	}
	prior := s.pages
	if got, err := r.List(context.Background(), 0); err == nil || got != nil || s.pages != prior {
		t.Fatal("retired origin performed more IO")
	}
}

func TestHistoryReadConstructorAndSelectionRefuseWithoutIO(t *testing.T) {
	r, s, a, results, next := historyFixture(t)
	for _, origin := range []*HistoryOrigin{nil, {}} {
		if got, err := NewHistoryReader(origin, r.deps); err == nil || got != nil {
			t.Fatal("unminted origin accepted")
		}
	}
	if got, err := NewHistoryReader(next.History, HistoryDependencies{Authority: a, Results: results}); err == nil || got != nil {
		t.Fatal("missing byte limit")
	}
	for _, key := range []port.HistoryKey{{}, {BackendGeneration: "generation-2", OperationID: "operation"}, {BackendGeneration: "bad id", OperationID: "operation"}} {
		if got, err := r.Read(context.Background(), key); err == nil || got != nil {
			t.Fatal("invalid selection accepted")
		}
	}
	if s.finds != 0 || results.reads != 0 {
		t.Fatal("invalid selection performed IO")
	}
	for _, field := range []string{"profile", "backend"} {
		a.scope = port.HistoryReadScope{ProfileID: "profile", BackendGeneration: "generation-2", OwnerID: "owner"}
		if field == "profile" {
			a.scope.ProfileID = "other"
		} else {
			a.scope.BackendGeneration = "other"
		}
		if got, err := r.List(context.Background(), 0); err == nil || got != nil {
			t.Fatal("crossed current scope")
		}
	}
	if s.pages != 0 {
		t.Fatal("crossed current scope performed IO")
	}
}

// A deterministic lock-acquisition barrier: the original lease check can pass,
// then current authority changes before the waiting caller owns the service gate.
// This avoids timing sleeps while reproducing that exact scheduling boundary.
type historyWaitGate struct {
	inner     port.Gate
	calls, at int
	revoke    func()
}

func (g *historyWaitGate) Lock() {
	g.calls++
	if g.calls == g.at {
		g.revoke()
	}
	g.inner.Lock()
}
func (g *historyWaitGate) Unlock() { g.inner.Unlock() }

func TestHistoryReadRechecksAuthorityAfterServiceGateWait(t *testing.T) {
	for _, method := range []string{"list", "read"} {
		for _, when := range []string{"first-IO", "final-disclosure"} {
			t.Run(method+"/"+when, func(t *testing.T) {
				r, s, a, results, _ := historyFixture(t)
				at := 1
				if when == "final-disclosure" {
					if method == "list" {
						at = 3
					} else {
						at = 4
					}
				}
				r.origin.owner.guard = &historyWaitGate{inner: r.origin.owner.guard, at: at, revoke: func() { a.revision++; a.active = true }}
				if method == "list" {
					v, err := r.List(context.Background(), 0)
					if err == nil || v != nil {
						t.Fatal("gate wait revived revoked read lease")
					}
				} else {
					v, err := r.Read(context.Background(), historyKey())
					if err == nil || v != nil {
						t.Fatal("gate wait revived revoked read lease")
					}
				}
				if when == "first-IO" && (s.pages+s.finds != 0 || results.reads != 0) {
					t.Fatal("revoked waiter performed storage IO")
				}
			})
		}
	}
}

func TestHistoryLatestReturnsOnlyOriginalSummary(t *testing.T) {
	r, store, a, results, next := historyFixture(t)
	ctx := context.Background()
	// Observation wall time belongs to retained metadata, never tail ordering.
	// No result IO is needed to return this read-only original reference.
	for _, millis := range []uint64{999999, 1} {
		results.value.Conversation.Observed.ObservedAtMillis = millis
		results.value.Conversation.Evidence.Observed = results.value.Conversation.Observed
		got, err := r.Latest(ctx, "provider-conversation")
		if err != nil || got == nil || got.Key != historyKey() || got.Binding != store.match.Turn.Binding || got.ResultID != store.match.Turn.Snapshot.Result.ID || got.ProviderConversationID != "provider-conversation" {
			t.Fatal("wrong latest history summary", got, err)
		}
		got.Binding.OwnerID = "mutated"
	}
	if store.calls != 4 || store.pages != 0 || store.finds != 0 || store.tails != 2 || results.reads != 0 {
		t.Fatal("tail query accessed payload or published work")
	}
	if err := next.Proof.WithRetirement(ctx, func(*port.RetirementReceipt) error { return nil }); err != nil {
		t.Fatal("history query consumed execution proof", err)
	}
	if got, err := r.Latest(ctx, "missing"); got != nil || err != nil {
		t.Fatal("missing tail fabricated result", err)
	}
	empty, err := NewEmptyHistoryReader(r.scope, a)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := empty.Latest(ctx, "provider-conversation"); got != nil || err != nil {
		t.Fatal("known-first reader fabricated tail", err)
	}
	a.active = false
	if got, err := empty.Latest(ctx, "provider-conversation"); got != nil || err == nil {
		t.Fatal("empty tail bypassed current authority")
	}
}

func TestHistoryLatestRefusesCrossedOrIncompleteMatch(t *testing.T) {
	for name, mutate := range map[string]func(*port.HistoryMatch){
		"anchor":          func(v *port.HistoryMatch) { v.Anchor.HeadDigest[0]++ },
		"owner":           func(v *port.HistoryMatch) { v.Turn.Binding.OwnerID = "other" },
		"CID":             func(v *port.HistoryMatch) { v.Turn.Snapshot.Binding.Document.ConversationID = "other" },
		"origin":          func(v *port.HistoryMatch) { v.Origin.Binding.BackendGeneration = "other" },
		"current-backend": func(v *port.HistoryMatch) { v.Origin.Binding.BackendGeneration = "generation-2" },
		"build":           func(v *port.HistoryMatch) { v.Origin.Binding.BuildID = "other" },
		"root":            func(v *port.HistoryMatch) { v.Origin.Binding.ChatRoot.Inode++ },
		"receipt":         func(v *port.HistoryMatch) { v.Origin.ReceiptDigest = [32]byte{} },
		"unacknowledged":  func(v *port.HistoryMatch) { v.Turn.AcknowledgedRevision = 0 },
		"unreleased":      func(v *port.HistoryMatch) { v.Turn.ReleasedRevision = 0 },
		"incomplete":      func(v *port.HistoryMatch) { v.Turn.Snapshot.DeliveryAcknowledged = false },
		"missing-result":  func(v *port.HistoryMatch) { v.Turn.ResultPublication = port.ResultPublication{} },
	} {
		t.Run(name, func(t *testing.T) {
			r, store, _, results, _ := historyFixture(t)
			mutate(&store.match)
			if got, err := r.Latest(context.Background(), "provider-conversation"); got != nil || err == nil || results.reads != 0 {
				t.Fatal("invalid tail exposed history", got, err)
			}
		})
	}
}

func TestHistoryLatestRechecksOriginalLeaseAfterIOAndGuardWaits(t *testing.T) {
	for _, missing := range []bool{false, true} {
		for _, at := range []string{"before", "history", "reactivate-history", "scope-history", "cancel-history", "first-IO", "after-IO", "final-disclosure", "head-advance"} {
			t.Run(at+map[bool]string{false: "/match", true: "/missing"}[missing], func(t *testing.T) {
				r, store, a, results, _ := historyFixture(t)
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				switch at {
				case "before":
					a.active = false
				case "history":
					store.hook = func() { a.active = false }
				case "reactivate-history":
					store.hook = func() { a.revision++; a.active = true }
				case "scope-history":
					store.hook = func() { a.scope.OwnerID = "other" }
				case "cancel-history":
					store.hook = cancel
				case "first-IO", "after-IO", "final-disclosure":
					gateAt := map[string]int{"first-IO": 1, "after-IO": 2, "final-disclosure": 3}[at]
					r.origin.owner.guard = &historyWaitGate{inner: r.origin.owner.guard, at: gateAt, revoke: func() { a.revision++; a.active = true }}
				case "head-advance":
					store.hook = func() { r.origin.owner.knownHead[0]++ }
				}
				cid := "provider-conversation"
				if missing {
					cid = "missing"
				}
				if got, err := r.Latest(ctx, cid); got != nil || err == nil {
					t.Fatal("withdrawn/stale query disclosed history", got, err)
				}
				if (at == "before" || at == "first-IO") && store.tails != 0 {
					t.Fatal("withdrawn waiter performed history IO")
				}
				if results.reads != 0 {
					t.Fatal("tail lookup read payload")
				}
			})
		}
	}
}

func TestHistoryLatestInvalidCIDOrCurrentScopeDoesNoIO(t *testing.T) {
	r, store, a, results, _ := historyFixture(t)
	for _, cid := range []string{"", "bad id", "bad\t", string([]byte{255})} {
		if got, err := r.Latest(context.Background(), cid); got != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid CID accepted", err)
		}
	}
	for _, scope := range []port.HistoryReadScope{
		{ProfileID: "other", BackendGeneration: "generation-2", OwnerID: "owner"},
		{ProfileID: "profile", BackendGeneration: "other", OwnerID: "owner"},
	} {
		a.scope = scope
		if got, err := r.Latest(context.Background(), "provider-conversation"); got != nil || err == nil {
			t.Fatal("crossed current scope accepted", err)
		}
	}
	if store.tails != 0 || results.reads != 0 {
		t.Fatal("invalid request performed IO")
	}
}

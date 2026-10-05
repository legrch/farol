package results

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
)

// CPU storage only. It models publication/failed readback, not native filesystem
// durability, physical identity, process ownership or current read authority.
type resultStorageFixture struct {
	child                                                 port.JournalRoot
	files                                                 map[string][]byte
	appendErr, readErr, inventoryErr, poisonErr, closeErr error
	poisonCalls, appendCalls, closeCalls                  int
	afterAppend                                           func()
	afterRead                                             func(string)
	poisoned                                              bool
	corruptRead                                           bool
}

func (s *resultStorageFixture) identity() port.JournalRoot { return s.child }
func (s *resultStorageFixture) inventory(context.Context) ([]string, error) {
	if s.poisoned {
		return nil, Unknown
	}
	if s.inventoryErr != nil {
		return nil, s.inventoryErr
	}
	keys := make([]string, 0, len(s.files))
	for key := range s.files {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys, nil
}
func (s *resultStorageFixture) read(_ context.Context, key string) ([]byte, error) {
	if s.readErr != nil {
		return nil, s.readErr
	}
	raw, ok := s.files[key]
	if !ok {
		return nil, Unknown
	}
	raw = append([]byte(nil), raw...)
	if s.corruptRead {
		raw[len(raw)-1] ^= 1
	}
	if s.afterRead != nil {
		s.afterRead(key)
	}
	return raw, nil
}
func (s *resultStorageFixture) append(_ context.Context, key string, raw []byte) error {
	s.appendCalls++
	if _, ok := s.files[key]; ok {
		return Conflict
	}
	s.files[key] = append([]byte(nil), raw...)
	if s.afterAppend != nil {
		s.afterAppend()
	}
	return s.appendErr
}
func (s *resultStorageFixture) poison() error {
	s.poisonCalls++
	if s.poisonErr == nil {
		s.poisoned = true
	}
	return s.poisonErr
}
func (s *resultStorageFixture) close() error { s.closeCalls++; return s.closeErr }
func durableFixture(t *testing.T, limits Limits) (*Native, *resultStorageFixture, context.CancelFunc) {
	t.Helper()
	life, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	root := Root{Path: "/fixture/chat", ProfileID: "profile", Identity: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 3}}
	s := &resultStorageFixture{child: port.JournalRoot{Device: 1, Inode: 4, OwnerUID: 3}, files: make(map[string][]byte)}
	n, err := newResultOwner(context.Background(), life, root, scopeFixture(), limits, s)
	if err != nil {
		t.Fatal(err)
	}
	return n, s, cancel
}
func reopenFixture(t *testing.T, n *Native, s *resultStorageFixture, scope port.JournalScope) *Native {
	t.Helper()
	next, err := newResultOwner(context.Background(), context.Background(), n.root, scope, n.limits, s)
	if err != nil {
		t.Fatal(err)
	}
	return next
}
func resultReadFixture(r *port.RetainReceipt) port.ResultRead {
	return port.ResultRead{Binding: r.Binding, Result: r.Result, Publication: r.Publication}
}
func conversationResultFixture() port.RetainRequest {
	q := requestFixture()
	s := port.Selection{Provider: "farol", Alias: "chatgpt", AccountID: "account", ModelID: "model", Effort: "low"}
	f := (port.SelectionFacts{Model: port.ControlFact{Value: "model", Literal: "Model", Source: port.FactPublicControl}, ObservedAtMillis: 1}).Projection()
	q.Conversation = port.RetainedConversation{ProviderConversationID: "conversation", ProviderUserTurnID: "user", ProviderReplyID: "reply", Requested: s, Observed: f, Complete: true, Evidence: port.SelectionEvidence{Requested: s, Admitted: s, Observed: f, ResolutionSource: "unknown", AdmissionSource: "chat-policy", ObservationSource: "field-facts", PinnedSource: "configured-pinned-scope", EvidenceID: "evidence"}}
	return q
}
func TestDurableResultExactPublicationHistoricalReadAndLiveDuplicates(t *testing.T) {
	n, s, _ := durableFixture(t, TextLimits())
	q := conversationResultFixture()
	expected := append([]byte(nil), q.Payload...)
	r, err := n.Retain(context.Background(), q)
	if err != nil || !r.Publication.Valid() || r.Binding != q.Binding || r.Conversation != q.Conversation || r.Bytes != len(expected) {
		t.Fatal("bad publication", err)
	}
	raw := s.files[resultKey(q)]
	rec, err := decodeResult(raw)
	if err != nil || resultPublication(rec, raw) != r.Publication {
		t.Fatal("publication does not cover exact bytes", err)
	}
	q.Payload[0] = 'X'
	read, err := n.Read(context.Background(), resultReadFixture(r))
	if err != nil || !bytes.Equal(read.Payload, expected) || read.Conversation != q.Conversation {
		t.Fatal("copy/metadata lost", err)
	}
	read.Payload[0] = 'Y'
	read.Conversation.ProviderReplyID = "changed"
	q.Payload = expected
	duplicate, err := n.Retain(context.Background(), q)
	if err != nil || *duplicate != *r || s.appendCalls != 1 {
		t.Fatal("live duplicate wrote", err)
	}
	r.Bytes = 0
	again, err := n.Retain(context.Background(), q)
	if err != nil || again.Bytes != len(expected) {
		t.Fatal("receipt alias", err)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	nextScope := scopeFixture()
	nextScope.BackendGeneration = "successor"
	next := reopenFixture(t, n, s, nextScope)
	old, err := next.Read(context.Background(), resultReadFixture(again))
	if err != nil || old.Binding != q.Binding || old.Conversation != q.Conversation || !bytes.Equal(old.Payload, expected) {
		t.Fatal("original backend historical read lost", err)
	}
	if _, err := next.Retain(context.Background(), q); !errors.Is(err, Mismatch) {
		t.Fatal("old scope retained", err)
	}
	sameScope := reopenFixture(t, n, s, scopeFixture())
	if _, err := sameScope.Retain(context.Background(), q); !errors.Is(err, Unknown) || s.poisonCalls != 1 {
		t.Fatal("loaded bytes became successful retry", err)
	}
}
func TestDurableResultChangedRecordAndSuppliedPublicationRefuse(t *testing.T) {
	mutations := map[string]func(*port.RetainRequest){
		"owner":        func(q *port.RetainRequest) { q.Binding.OwnerID = "other" },
		"session":      func(q *port.RetainRequest) { q.Binding.SessionID = "other" },
		"task":         func(q *port.RetainRequest) { q.Binding.TaskID = "other" },
		"epoch":        func(q *port.RetainRequest) { q.Binding.TaskEpoch++ },
		"participant":  func(q *port.RetainRequest) { q.Binding.ParticipantID = "other" },
		"turn":         func(q *port.RetainRequest) { q.Binding.TurnID = "other" },
		"generation":   func(q *port.RetainRequest) { q.Binding.TurnGeneration++ },
		"result":       func(q *port.RetainRequest) { q.Result.ID = "other" },
		"code":         func(q *port.RetainRequest) { q.Result.Code = "OTHER" },
		"payload":      func(q *port.RetainRequest) { q.Payload = []byte("other") },
		"conversation": func(q *port.RetainRequest) { q.Conversation.ProviderReplyID = "other" },
		"evidence":     func(q *port.RetainRequest) { q.Conversation.Evidence.EvidenceID = "other" },
	}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			n, s, _ := durableFixture(t, TextLimits())
			q := conversationResultFixture()
			r, err := n.Retain(context.Background(), q)
			if err != nil {
				t.Fatal(err)
			}
			changed := q
			mutate(&changed)
			if _, err := n.Retain(context.Background(), changed); !errors.Is(err, Conflict) {
				t.Fatal("changed record accepted", err)
			}
			read := resultReadFixture(r)
			read.Binding = changed.Binding
			read.Result = changed.Result
			if read.Binding != q.Binding || read.Result != q.Result {
				if _, err := n.Read(context.Background(), read); !errors.Is(err, Mismatch) {
					t.Fatal("inexact read accepted", err)
				}
			}
			if s.appendCalls != 1 || s.poisonCalls != 0 {
				t.Fatal("conflict mutated storage")
			}
		})
	}
	n, _, _ := durableFixture(t, TextLimits())
	r, err := n.Retain(context.Background(), requestFixture())
	if err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*port.ResultRead){
		func(q *port.ResultRead) { q.Publication.Digest[0] ^= 1 },
		func(q *port.ResultRead) { q.Publication.EncodedBytes++ },
		func(q *port.ResultRead) { q.Publication.Root.Inode++ },
		func(q *port.ResultRead) { q.Publication.StorageRoot.Inode++ },
		func(q *port.ResultRead) { q.Binding.ProfileID = "other" },
	} {
		q := resultReadFixture(r)
		mutate(&q)
		if _, err := n.Read(context.Background(), q); !errors.Is(err, Mismatch) {
			t.Fatal("publication mismatch accepted", err)
		}
	}
}
func TestDurableResultCapacityCountsOldRecordsAndEmptyPayloads(t *testing.T) {
	n, s, _ := durableFixture(t, Limits{Results: 2, ResultBytes: 4, TotalBytes: 5})
	q := requestFixture()
	q.Payload = []byte{0, 255, 1, 2}
	r, err := n.Retain(context.Background(), q)
	if err != nil {
		t.Fatal(err)
	}
	nextScope := scopeFixture()
	nextScope.BackendGeneration = "next"
	next := reopenFixture(t, n, s, nextScope)
	newQ := q
	newQ.Binding.BackendGeneration = "next"
	newQ.Payload = []byte{1, 2}
	if _, err := next.Retain(context.Background(), newQ); !errors.Is(err, Capacity) {
		t.Fatal("old payload did not count", err)
	}
	newQ.Payload = nil
	if _, err := next.Retain(context.Background(), newQ); err != nil {
		t.Fatal(err)
	}
	newQ.Binding.OperationID = "third"
	if _, err := next.Retain(context.Background(), newQ); !errors.Is(err, Capacity) {
		t.Fatal("empty payload evaded record count", err)
	}
	if _, err := next.Read(context.Background(), resultReadFixture(r)); err != nil {
		t.Fatal("capacity evicted old bytes", err)
	}
	if len(s.files) != 2 || s.poisonCalls != 0 {
		t.Fatal("capacity changed/fenced storage")
	}
}
func TestDurableResultPublicationFailureStaysStickyAndFenceOneShot(t *testing.T) {
	for _, failure := range []string{"append", "readback", "corrupt", "late-request", "late-lifetime", "late-inventory"} {
		t.Run(failure, func(t *testing.T) {
			n, s, cancelLife := durableFixture(t, TextLimits())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch failure {
			case "append":
				s.appendErr = Unknown
			case "readback":
				s.afterAppend = func() { s.readErr = Unknown }
			case "corrupt":
				s.afterAppend = func() { s.corruptRead = true }
			case "late-request":
				s.afterAppend = cancel
			case "late-lifetime":
				s.afterAppend = cancelLife
			case "late-inventory":
				s.afterAppend = func() { s.inventoryErr = Unknown }
			}
			if r, err := n.Retain(ctx, requestFixture()); r != nil || !errors.Is(err, Unknown) {
				t.Fatal("uncertain publication returned receipt", err)
			}
			if !n.poisoned || s.poisonCalls != 1 {
				t.Fatal("uncertainty not sticky")
			}
			if _, err := n.Retain(context.Background(), requestFixture()); !errors.Is(err, Unknown) {
				t.Fatal("uncertainty retry accepted", err)
			}
			if err := n.Fence(context.Background()); err != nil {
				t.Fatal(err)
			}
			if err := n.Fence(context.Background()); err != nil || s.poisonCalls != 1 || s.appendCalls != 1 {
				t.Fatal("fence/publication retried", err)
			}
		})
	}
	n, s, _ := durableFixture(t, TextLimits())
	r, err := n.Retain(context.Background(), requestFixture())
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := n.Fence(cancelled); err != nil {
		t.Fatal("cancelled fence did not attempt", err)
	}
	if _, err := n.Read(context.Background(), resultReadFixture(r)); !errors.Is(err, Unknown) {
		t.Fatal("known commit escaped late outcome fence", err)
	}
	if _, err := newResultOwner(context.Background(), context.Background(), n.root, n.scope, n.limits, s); !errors.Is(err, Unknown) {
		t.Fatal("marker did not fence reload", err)
	}
}
func TestDurableResultFailedUnknownMarkerBoundaryRemainsUnqualified(t *testing.T) {
	n, s, _ := durableFixture(t, TextLimits())
	r, err := n.Retain(context.Background(), requestFixture())
	if err != nil {
		t.Fatal(err)
	}
	s.poisonErr = Unknown
	if err := n.Fence(context.Background()); !errors.Is(err, Unknown) {
		t.Fatal("failed marker claimed success", err)
	}
	if err := n.Fence(context.Background()); !errors.Is(err, Unknown) || s.poisonCalls != 1 {
		t.Fatal("failed fence retried", err)
	}
	if _, err := n.Read(context.Background(), resultReadFixture(r)); !errors.Is(err, Unknown) {
		t.Fatal("live owner unfenced", err)
	}
	// Deliberate limit: valid committed bytes plus a marker that never persisted
	// cannot reveal a lost caller outcome to a new process. Boot/journal service
	// must deny reopening/exposure without independent original terminal evidence.
	next := reopenFixture(t, n, s, n.scope)
	if _, err := next.Read(context.Background(), resultReadFixture(r)); err != nil {
		t.Fatal("fixture no longer models impossible reload boundary", err)
	}
	if _, err := next.Retain(context.Background(), requestFixture()); !errors.Is(err, Unknown) {
		t.Fatal("reload upgraded retry", err)
	}
}
func TestDurableResultMalformedLoadedBytesMissingAndChangedKnownRecordFence(t *testing.T) {
	for _, kind := range []string{"malformed", "profile", "root", "child", "key", "removed", "changed"} {
		t.Run(kind, func(t *testing.T) {
			n, s, _ := durableFixture(t, TextLimits())
			q := requestFixture()
			r, err := n.Retain(context.Background(), q)
			if err != nil {
				t.Fatal(err)
			}
			key := resultKey(q)
			raw := s.files[key]
			record, _ := decodeResult(raw)
			switch kind {
			case "malformed":
				s.files[key] = []byte("{}")
			case "profile":
				record.Request.Binding.ProfileID = "other"
				s.files[key], _ = encodeResult(record)
			case "root":
				record.Root.Inode++
				s.files[key], _ = encodeResult(record)
			case "child":
				record.StorageRoot.Inode++
				s.files[key], _ = encodeResult(record)
			case "key":
				delete(s.files, key)
				s.files["wrong"] = raw
			case "removed":
				delete(s.files, key)
			case "changed":
				record.Request.Payload = []byte("changed")
				s.files[key], _ = encodeResult(record)
			}
			if _, err := n.Read(context.Background(), resultReadFixture(r)); !errors.Is(err, Unknown) || s.poisonCalls != 1 {
				t.Fatal("bad inventory returned bytes", err)
			}
		})
	}
}
func TestDurableResultCancellationCloseAndConcurrentBounds(t *testing.T) {
	n, s, cancel := durableFixture(t, Limits{Results: 8, ResultBytes: 1, TotalBytes: 8})
	var wg sync.WaitGroup
	errs := make(chan error, 32)
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			q := requestFixture()
			q.Binding.OperationID = fmt.Sprintf("operation-%d", i)
			q.Payload = []byte{byte(i)}
			_, err := n.Retain(context.Background(), q)
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	success := 0
	for err := range errs {
		if err == nil {
			success++
		} else if !errors.Is(err, Capacity) {
			t.Fatal(err)
		}
	}
	if success != 8 || len(s.files) != 8 || s.appendCalls != 8 {
		t.Fatal("concurrency escaped bounds")
	}
	cancel()
	if _, err := n.Retain(context.Background(), requestFixture()); !errors.Is(err, Unavailable) {
		t.Fatal("ended lifetime used", err)
	}
	if err := n.Close(); err != nil {
		t.Fatal(err)
	}
	if err := n.Close(); err != nil || s.closeCalls != 1 || len(s.files) != 8 {
		t.Fatal("close destroyed files or retried", err)
	}
}

func TestDurableResultFinalReadbackMustStillContainExactPublication(t *testing.T) {
	for _, kind := range []string{"removed", "changed"} {
		t.Run(kind, func(t *testing.T) {
			n, s, _ := durableFixture(t, TextLimits())
			// Drop/change the successful immediate readback before the final scan. A
			// valid scan of an empty or different inventory cannot attest our record.
			s.afterRead = func(key string) {
				s.afterRead = nil
				if kind == "removed" {
					delete(s.files, key)
				} else {
					r, err := decodeResult(s.files[key])
					if err != nil {
						t.Fatal(err)
					}
					r.Request.Payload = []byte("changed-after-readback")
					s.files[key], err = encodeResult(r)
					if err != nil {
						t.Fatal(err)
					}
				}
			}
			if r, err := n.Retain(context.Background(), requestFixture()); r != nil || !errors.Is(err, Unknown) || s.poisonCalls != 1 {
				t.Fatal("final scan promoted absent/different publication", err)
			}
		})
	}
}
func TestDurableResultInvalidCompositionAndRequestsHaveNoStorageEffects(t *testing.T) {
	root := Root{Path: "/fixture/chat", ProfileID: "profile", Identity: port.JournalRoot{Device: 1, Inode: 2, OwnerUID: 3}}
	ctx := context.Background()
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	var typedNil *nilContextFixture
	if validResultComposition(typedNil, ctx, root, scopeFixture(), TextLimits(), "create") || validResultComposition(ctx, typedNil, root, scopeFixture(), TextLimits(), "create") {
		t.Fatal("typed nil context accepted")
	}
	for _, mode := range []string{"", "OPEN", "repair"} {
		if validResultComposition(ctx, ctx, root, scopeFixture(), TextLimits(), mode) {
			t.Fatal("invalid mode accepted")
		}
	}
	for _, limits := range []Limits{{}, {Results: MaxResults + 1, ResultBytes: 8192, TotalBytes: 8192}, {Results: 1, ResultBytes: 8193, TotalBytes: 8193}, {Results: 1, ResultBytes: 4, TotalBytes: 3}, {Results: 1, ResultBytes: 8192, TotalBytes: MaxTotalBytes + 1}} {
		if validResultComposition(ctx, ctx, root, scopeFixture(), limits, "create") {
			t.Fatal("invalid limits accepted")
		}
	}
	if validResultComposition(cancelled, ctx, root, scopeFixture(), TextLimits(), "create") {
		t.Fatal("cancelled create accepted")
	}
	n, s, _ := durableFixture(t, TextLimits())
	for _, mutate := range []func(*port.RetainRequest){
		func(q *port.RetainRequest) { q.Binding.TaskEpoch = 0 }, func(q *port.RetainRequest) { q.Result.Code = "raw private error" }, func(q *port.RetainRequest) { q.Payload = make([]byte, 8193) }, func(q *port.RetainRequest) {
			q.Conversation = conversationResultFixture().Conversation
			q.Conversation.Complete = false
		},
	} {
		q := requestFixture()
		mutate(&q)
		if r, err := n.Retain(ctx, q); r != nil || !errors.Is(err, Invalid) {
			t.Fatal("invalid request accepted", err)
		}
	}
	q := requestFixture()
	q.Binding.BackendGeneration = "other"
	if _, err := n.Retain(ctx, q); !errors.Is(err, Mismatch) {
		t.Fatal("foreign scope accepted", err)
	}
	if _, err := n.Retain(cancelled, requestFixture()); !errors.Is(err, Unavailable) {
		t.Fatal("cancelled retention accepted", err)
	}
	if _, err := n.Retain(typedNil, requestFixture()); !errors.Is(err, Invalid) {
		t.Fatal("nil retention context accepted", err)
	}
	if s.appendCalls != 0 || s.poisonCalls != 0 {
		t.Fatal("validation mutated storage")
	}
	if _, err := new(Native).Read(ctx, port.ResultRead{}); !errors.Is(err, Unavailable) {
		t.Fatal("zero native owner accepted", err)
	}
	var absent *Native
	if err := absent.Close(); !errors.Is(err, Invalid) {
		t.Fatal("nil Close accepted", err)
	}
}
func TestDurableResultCloseFailureClassifiedAndNeverRetried(t *testing.T) {
	n, s, _ := durableFixture(t, TextLimits())
	s.closeErr = errors.New("private path must not escape")
	err := n.Close()
	if !errors.Is(err, Unknown) || err.Error() != string(Unknown) {
		t.Fatal("raw close error escaped", err)
	}
	if err := n.Close(); !errors.Is(err, Unknown) || s.closeCalls != 1 {
		t.Fatal("close failure retried", err)
	}
}

package settingsdelivery

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

// These ports are pure policy fixtures, not native, filesystem or provider proof.
type fixedClock struct{}

func (fixedClock) Now() time.Time { return time.UnixMilli(1791100800123) }

type memoryStore struct {
	snapshot     Snapshot
	saves, loads int
	unrelated    string
	loadHook     func(context.Context)
	saveHook     func(context.Context, Change) (SaveResult, error)
}

func (m *memoryStore) Load(ctx context.Context) (Snapshot, error) {
	m.loads++
	if m.loadHook != nil {
		m.loadHook(ctx)
	}
	return cloneSnapshot(m.snapshot), nil
}
func (m *memoryStore) CompareAndSet(ctx context.Context, c Change) (SaveResult, error) {
	m.saves++
	if m.saveHook != nil {
		return m.saveHook(ctx, c)
	}
	return m.commit(c), nil
}
func (m *memoryStore) commit(c Change) SaveResult {
	if !sameSnapshot(c.Expected, m.snapshot) {
		return SaveResult{Publication: NotWritten}
	}
	m.snapshot.Revision++
	m.snapshot.Pending = clonePending(c.Next)
	m.snapshot.VerificationInvalidated = m.snapshot.VerificationInvalidated || c.InvalidateVerification
	readback := cloneSnapshot(m.snapshot)
	return SaveResult{Publication: Committed, Readback: &readback}
}

type outcomePort struct {
	executes, observes int
	selected           Selection
	request            EditRequest
	observation        Observation
	out                *Response
	err                error
	executeHook        func()
}

func (o *outcomePort) Execute(_ context.Context, s Selection, r EditRequest) (*Response, error) {
	o.executes++
	o.selected = s
	o.request = r
	if o.executeHook != nil {
		o.executeHook()
	}
	return o.out, o.err
}
func (o *outcomePort) Observe(_ context.Context, s Selection, r Observation) (*Response, error) {
	o.observes++
	o.selected = s
	o.observation = r
	return o.out, o.err
}

// Deterministic lowercase UUIDv4-shaped fixtures only; no UUID authority or
// native identity evidence is claimed by these pure tests.
func fixtureID(label string) string {
	bytes := sha256.Sum256([]byte(label))
	bytes[6] = bytes[6]&0x0f | 0x40
	bytes[8] = bytes[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", bytes[:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16])
}
func setup(t *testing.T) (*Service, *memoryStore, *outcomePort) {
	t.Helper()
	identity := Identity{ProfileID: fixtureID("profile"), OwnerID: "owner", ComputerID: fixtureID("computer"), Generation: 7}
	store := &memoryStore{snapshot: Snapshot{Revision: 10, Current: identity}, unrelated: "preserved"}
	outcomes := &outcomePort{}
	service, err := New(identity, store, outcomes, fixedClock{}, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	return service, store, outcomes
}
func request() EditRequest {
	return EditRequest{WorkspaceID: fixtureID("workspace"), Operation: Edit{RelativePath: "file.txt", ExpectedSHA256: strings.Repeat("a", 64), Edits: []TextEdit{{OldText: "before", NewText: "after"}}}}
}
func selected(s *Service, id string) Selection {
	return Selection{OperationID: fixtureID(id), ProfileID: s.identity.ProfileID, OwnerID: s.identity.OwnerID, ComputerID: s.identity.ComputerID, ComputerGeneration: s.identity.Generation}
}
func begin(t *testing.T, s *Service, id string) *Permit {
	t.Helper()
	p, err := s.Begin(context.Background(), selected(s, id), request())
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func completed(p Pending) *Response {
	hash := p.BeforeSHA256
	return &Response{OperationID: p.OperationID, WorkspaceID: p.WorkspaceID, ComputerGeneration: p.ComputerGeneration, Phase: "completed", Publication: "durable", Receipt: &EffectReceipt{Operation: "edit", RelativePath: p.RelativePath, Bytes: 12, Replacements: 1, BeforeSHA256: &hash, AfterSHA256: strings.Repeat("b", 64)}}
}
func offered(t *testing.T, s *Service, o *outcomePort, p *Permit) *Receipt {
	t.Helper()
	o.out = completed(p.Binding())
	if _, err := s.Execute(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	r, err := s.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	return r
}
func requireError(t *testing.T, got, want error) {
	t.Helper()
	if !errors.Is(got, want) {
		t.Fatalf("error = %v, want %v", got, want)
	}
}

func TestConcurrentBeginOnePending(t *testing.T) {
	s, store, _ := setup(t)
	var wg sync.WaitGroup
	results := make(chan *Permit, 32)
	errs := make(chan error, 32)
	for i := range 32 {
		wg.Go(func() {
			p, err := s.Begin(context.Background(), selected(s, fmt.Sprintf("op-%d", i)), request())
			results <- p
			errs <- err
		})
	}
	wg.Wait()
	close(results)
	close(errs)
	successes := 0
	for p := range results {
		if p != nil {
			successes++
		}
	}
	for err := range errs {
		if err != nil {
			requireError(t, err, ErrConflict)
		}
	}
	if successes != 1 || store.saves != 1 || store.snapshot.Pending == nil {
		t.Fatalf("successes=%d saves=%d pending=%v", successes, store.saves, store.snapshot.Pending)
	}
}

func TestOriginalEditAndSingleConsumedAttempt(t *testing.T) {
	s, store, o := setup(t)
	original := request()
	p, err := s.Begin(context.Background(), selected(s, "op"), original)
	if err != nil {
		t.Fatal(err)
	}
	original.Operation.Edits[0].NewText = "changed by caller"
	binding := p.Binding()
	binding.RelativePath = "changed.txt"
	o.out = completed(p.Binding())
	store.loadHook = func(context.Context) {
		if !p.consumed || !reflect.DeepEqual(p.request, EditRequest{}) {
			t.Error("permit not consumed before asynchronous Load")
		}
	}
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for range 20 {
		wg.Go(func() { _, err := s.Execute(context.Background(), p); errs <- err })
	}
	wg.Wait()
	close(errs)
	successes := 0
	for err := range errs {
		if err == nil {
			successes++
		} else {
			requireError(t, err, ErrConsumed)
		}
	}
	if successes != 1 || o.executes != 1 {
		t.Fatalf("successes=%d executes=%d", successes, o.executes)
	}
	if !reflect.DeepEqual(o.request, request()) || o.selected != s.selection(p.Binding()) {
		t.Fatalf("original request/selection changed: %+v %+v", o.request, o.selected)
	}
	if store.snapshot.Pending.RelativePath != "file.txt" || store.snapshot.Pending.Backend != "go-owner-v2" || store.snapshot.Pending.SubmittedAt != "2026-10-04T08:00:00.123Z" {
		t.Fatalf("unexpected tuple: %+v", store.snapshot.Pending)
	}
}

func TestCopiedAndCrossedPermits(t *testing.T) {
	s, _, o := setup(t)
	p := begin(t, s, "op")
	copy := *p
	_, err := s.Execute(context.Background(), &copy)
	requireError(t, err, ErrConsumed)
	other, _, _ := setup(t)
	_, err = other.Execute(context.Background(), p)
	requireError(t, err, ErrConsumed)
	if o.executes != 0 {
		t.Fatal("forged permit dispatched")
	}
	offered(t, s, o, p)
}

func TestBeginRefusesExistingAndStaleCAS(t *testing.T) {
	for _, mode := range []string{"existing", "foreign-profile", "stale-revision", "foreign-race"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			switch mode {
			case "existing", "foreign-profile":
				p := begin(t, s, "existing")
				value := p.Binding()
				if mode == "foreign-profile" {
					value.ProfileID = fixtureID("foreign")
				}
				store.snapshot.Pending = &value
			case "stale-revision", "foreign-race":
				store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
					store.snapshot.Revision++
					if mode == "foreign-race" {
						p := Pending{Backend: "go-owner-v2", OperationID: fixtureID("foreign"), ProfileID: fixtureID("profile"), WorkspaceID: fixtureID("workspace"), RelativePath: "other.txt", ComputerGeneration: 7, BeforeSHA256: strings.Repeat("c", 64), SubmittedAt: "2026-10-04T00:00:00Z"}
						store.snapshot.Pending = &p
					}
					return store.commit(c), nil
				}
			}
			before := clonePending(store.snapshot.Pending)
			permit, err := s.Begin(context.Background(), selected(s, "new"), request())
			if permit != nil || err == nil || o.executes != 0 {
				t.Fatalf("admitted refusal: %v %v", permit, err)
			}
			if mode == "existing" || mode == "foreign-profile" {
				if !samePending(before, store.snapshot.Pending) || store.saves != 1 {
					t.Fatal("existing pending overwritten")
				}
			}
			if mode == "stale-revision" || mode == "foreign-race" {
				requireError(t, err, ErrNotWritten)
				if s.publicationFence {
					t.Fatal("proven refusal classified unknown")
				}
				if err := s.FreezeForRetirement(); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestBeginPublicationAmbiguityNeverPermitsExecution(t *testing.T) {
	for _, mode := range []string{"error-before", "error-after", "unknown-before", "unknown-after", "zero", "missing-readback", "wrong-readback", "not-written-with-readback"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
				switch mode {
				case "error-before":
					return SaveResult{}, errors.New("storage failed before uncertain boundary")
				case "error-after":
					out := store.commit(c)
					return out, errors.New("reply lost")
				case "unknown-before":
					return SaveResult{Publication: PublicationUnknown}, nil
				case "unknown-after":
					store.commit(c)
					return SaveResult{Publication: PublicationUnknown}, nil
				case "zero":
					return SaveResult{}, nil
				case "missing-readback":
					return SaveResult{Publication: Committed}, nil
				case "wrong-readback":
					out := store.commit(c)
					out.Readback.Revision++
					return out, nil
				default:
					out := store.commit(c)
					out.Publication = NotWritten
					return out, nil
				}
			}
			p, err := s.Begin(context.Background(), selected(s, "op"), request())
			requireError(t, err, ErrFenced)
			if p != nil {
				t.Fatal("uncertain Begin issued permit")
			}
			// Even apparently complete/empty bytes cannot repair this lifetime.
			store.snapshot.Pending = nil
			store.snapshot.Revision++
			loads := store.loads
			_, err = s.Begin(context.Background(), selected(s, "next"), request())
			requireError(t, err, ErrFenced)
			_, err = s.Execute(context.Background(), p)
			requireError(t, err, ErrConsumed)
			requireError(t, s.FreezeForRetirement(), ErrFenced)
			if store.loads != loads || store.saves != 1 || o.executes != 0 {
				t.Fatal("uncertain publication was reloaded/retried/dispatched")
			}
		})
	}
}

func TestRestoredPendingObserverOnlyAndOriginalGeneration(t *testing.T) {
	original, store, o := setup(t)
	p := begin(t, original, "op")
	restored, err := New(original.identity, store, o, fixedClock{}, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	store.snapshot.Current.Generation++
	o.out = completed(p.Binding())
	out, err := restored.Observe(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if out.ComputerGeneration != 7 || o.selected.ComputerGeneration != 7 || o.observation.RelativePath != "file.txt" {
		t.Fatal("observation rebound original generation/path")
	}
	_, err = restored.Execute(context.Background(), p)
	requireError(t, err, ErrConsumed)
	_, err = restored.Begin(context.Background(), selected(restored, "next"), request())
	requireError(t, err, ErrConflict)
	r, err := restored.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if o.executes != 0 || store.saves != 2 {
		t.Fatal("restore minted execution or extra save")
	}
}

func TestFreshExecutionRequiresEntirePendingAndIdentity(t *testing.T) {
	for _, mode := range []string{"operation", "path", "sha", "submitted", "generation", "computer", "owner", "profile", "absent"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			switch mode {
			case "operation":
				store.snapshot.Pending.OperationID = fixtureID("other")
			case "path":
				store.snapshot.Pending.RelativePath = "other.txt"
			case "sha":
				store.snapshot.Pending.BeforeSHA256 = strings.Repeat("c", 64)
			case "submitted":
				store.snapshot.Pending.SubmittedAt = "2026-10-04T01:00:00Z"
			case "generation":
				store.snapshot.Current.Generation++
			case "computer":
				store.snapshot.Current.ComputerID = fixtureID("other")
			case "owner":
				store.snapshot.Current.OwnerID = "other"
			case "profile":
				store.snapshot.Current.ProfileID = fixtureID("other")
			case "absent":
				store.snapshot.Pending = nil
			}
			_, err := s.Execute(context.Background(), p)
			if err == nil {
				t.Fatal("stale execution allowed")
			}
			_, err = s.Execute(context.Background(), p)
			requireError(t, err, ErrConsumed)
			if o.executes != 0 {
				t.Fatal("stale/foreign pending dispatched")
			}
		})
	}
}

func TestOfferAndACKExactReceipt(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	_, err := s.Offer(context.Background(), p.Binding())
	requireError(t, err, ErrNotReady)
	requireError(t, s.ACK(context.Background(), &Receipt{pending: p.Binding()}), ErrInvalid)
	if store.saves != 1 || o.observes != 0 {
		t.Fatal("premature delivery saved/read outcome")
	}
	r := offered(t, s, o, p)
	copy := *r
	requireError(t, s.ACK(context.Background(), &copy), ErrInvalid)
	other, _, _ := setup(t)
	requireError(t, other.ACK(context.Background(), r), ErrInvalid)
	if store.snapshot.Pending == nil || store.saves != 1 {
		t.Fatal("offer/forged receipt cleared pending")
	}
	if r.ID() == "" || r.Retention() != Durable || r.Binding() != p.Binding() {
		t.Fatal("receipt correlation lost")
	}
	// Caller edits to the projected result never change offered receipt authority.
	projected := r.Outcome()
	projected.Receipt.RelativePath = "other.txt"
	*projected.Receipt.BeforeSHA256 = strings.Repeat("c", 64)
	o.out.Receipt.RelativePath = "mutated port result"
	if r.Outcome().Receipt.RelativePath != "file.txt" || *r.Outcome().Receipt.BeforeSHA256 != p.Binding().BeforeSHA256 {
		t.Fatal("receipt aliases caller/port result")
	}
	store.snapshot.Revision += 5
	store.unrelated = "new unrelated value"
	if err = s.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	loads, saves := store.loads, store.saves
	if err = s.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	out, err := s.Observe(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	again, err := s.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if again != r || out.Receipt.RelativePath != "file.txt" || store.loads != loads || store.saves != saves || store.saves != 2 || store.unrelated != "new unrelated value" {
		t.Fatal("known ACK replay reread/saved or changed unrelated configuration")
	}
	if err = s.FreezeForRetirement(); err != nil {
		t.Fatal(err)
	}
}

func TestACKNeverClearsNewOrForeignPending(t *testing.T) {
	for _, mode := range []string{"new", "same-id-new-sha", "same-id-new-time", "absent", "cas-race"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			r := offered(t, s, o, p)
			switch mode {
			case "new":
				store.snapshot.Pending.OperationID = fixtureID("new")
			case "same-id-new-sha":
				store.snapshot.Pending.BeforeSHA256 = strings.Repeat("c", 64)
			case "same-id-new-time":
				store.snapshot.Pending.SubmittedAt = "2026-10-04T01:00:00Z"
			case "absent":
				store.snapshot.Pending = nil
			case "cas-race":
				store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
					store.snapshot.Revision++
					store.snapshot.Pending.OperationID = fixtureID("new")
					return store.commit(c), nil
				}
			}
			err := s.ACK(context.Background(), r)
			if mode == "cas-race" {
				requireError(t, err, ErrNotWritten)
				requireError(t, s.ACK(context.Background(), r), ErrNotWritten)
				if store.saves != 2 {
					t.Fatal("proven refusal retried")
				}
			} else {
				requireError(t, err, ErrConflict)
				if store.saves != 1 {
					t.Fatal("stale receipt saved")
				}
			}
			if mode != "absent" && store.snapshot.Pending == nil {
				t.Fatal("foreign pending cleared")
			}
		})
	}
}

func TestLostACKPermanentlyFencesDespiteLaterReadback(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	r := offered(t, s, o, p)
	store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
		out := store.commit(c)
		return out, errors.New("ACK reply lost after commit")
	}
	requireError(t, s.ACK(context.Background(), r), ErrFenced)
	if store.snapshot.Pending != nil {
		t.Fatal("fixture did not simulate effective clear")
	}
	// A later Load really looks cleared; no replay upgrades the unknown ACK.
	if _, err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	loads := store.loads
	requireError(t, s.ACK(context.Background(), r), ErrFenced)
	_, err := s.Begin(context.Background(), selected(s, "next"), request())
	requireError(t, err, ErrFenced)
	requireError(t, s.FreezeForRetirement(), ErrFenced)
	if store.loads != loads || store.saves != 2 || o.executes != 1 {
		t.Fatal("lost ACK retried or reread to success")
	}
}

func TestOutcomeRetentionAndUIACKCannotSettleEffectFence(t *testing.T) {
	for _, mode := range []string{"memory-completed", "memory-failed", "durable-unknown", "memory-unknown", "missing", "error"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			switch mode {
			case "memory-completed":
				o.out = completed(p.Binding())
				o.out.Publication = "memory_only"
			case "memory-failed":
				o.out = completed(p.Binding())
				o.out.Phase = "failed"
				o.out.Publication = "memory_only"
				o.out.Receipt = nil
				o.out.Failure = &Failure{Code: "WORKSPACE_EDIT_NO_MATCH", Source: "native-workspace"}
			case "durable-unknown":
				o.out = unknownResult(p.Binding())
				o.out.Publication = "durable"
			case "memory-unknown":
				o.out = unknownResult(p.Binding())
			case "error":
				o.err = errors.New("transport failure")
			}
			out, err := s.Execute(context.Background(), p)
			if err != nil {
				t.Fatal(err)
			}
			exact := cloneResult(out)
			if mode == "missing" || mode == "error" {
				if out.Phase != "outcome_unknown" || out.Publication != "memory_only" {
					t.Fatal("missing/error became not_admitted")
				}
			}
			o.out = completed(p.Binding())
			o.err = nil
			out, err = s.Observe(context.Background(), p.Binding())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(out, exact) || o.observes != 0 {
				t.Fatal("original uncertainty/result was replaced")
			}
			r, err := s.Offer(context.Background(), p.Binding())
			if err != nil {
				t.Fatal(err)
			}
			requireError(t, s.ACK(context.Background(), &Receipt{pending: p.Binding()}), ErrInvalid)
			if err = s.ACK(context.Background(), r); err != nil {
				t.Fatal(err)
			}
			if store.snapshot.Pending != nil || !store.snapshot.VerificationInvalidated {
				t.Fatal("uncertainty UI delivery or invalidation lost")
			}
			_, err = s.Begin(context.Background(), selected(s, "next"), request())
			requireError(t, err, ErrEffectUnsettled)
			requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
		})
	}
}

func TestRestoredMissingRecordUnknownNotAdmissionProof(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	restored, err := New(s.identity, store, o, fixedClock{}, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	out, err := restored.Observe(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(out, unknownResult(p.Binding())) || o.executes != 0 {
		t.Fatal("missing record authorized not_admitted/execution")
	}
}

func TestPreparedObserveCannotOfferPrematureACK(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	restored, err := New(s.identity, store, o, fixedClock{}, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	o.out = &Response{OperationID: fixtureID("op"), WorkspaceID: fixtureID("workspace"), ComputerGeneration: 7, Phase: "prepared", Publication: "durable"}
	_, err = restored.Offer(context.Background(), p.Binding())
	requireError(t, err, ErrNotReady)
	o.out = completed(p.Binding())
	r, err := restored.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
}

func TestMalformedOutcomeCannotOfferOrClear(t *testing.T) {
	for _, mode := range []string{"operation", "workspace", "generation", "publication", "phase", "path", "before-sha", "kind", "shape"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			o.out = completed(p.Binding())
			switch mode {
			case "operation":
				o.out.OperationID = fixtureID("other")
			case "workspace":
				o.out.WorkspaceID = fixtureID("other")
			case "generation":
				o.out.ComputerGeneration++
			case "publication":
				o.out.Publication = "unknown"
			case "phase":
				o.out.Phase = "not_admitted"
			case "path":
				o.out.Receipt.RelativePath = "other"
			case "before-sha":
				*o.out.Receipt.BeforeSHA256 = strings.Repeat("c", 64)
			case "kind":
				o.out.Receipt.Operation = "write"
			case "shape":
				o.out.Failure = &Failure{Code: "WORKSPACE_EDIT_NO_MATCH", Source: "native-workspace"}
			}
			_, err := s.Execute(context.Background(), p)
			requireError(t, err, ErrInvalid)
			warning, offerErr := s.Offer(context.Background(), p.Binding())
			if offerErr != nil {
				t.Fatal(offerErr)
			}
			if warning.Outcome().Phase != "outcome_unknown" || !store.snapshot.VerificationInvalidated {
				t.Fatal("malformed result did not require uncertainty invalidation")
			}
			requireError(t, s.ACK(context.Background(), &Receipt{pending: p.Binding()}), ErrInvalid)
			requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
			if store.saves != 2 || store.snapshot.Pending == nil {
				t.Fatal("malformed outcome cleared pending")
			}
		})
	}
}

func TestCancellationBeforeAndAfterPossiblePublication(t *testing.T) {
	for _, action := range []string{"begin", "ack"} {
		for _, when := range []string{"before-load", "during-load", "not-written", "after-commit"} {
			t.Run(action+"/"+when, func(t *testing.T) {
				s, store, o := setup(t)
				var r *Receipt
				if action == "ack" {
					p := begin(t, s, "op")
					r = offered(t, s, o, p)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				before := store.saves
				switch when {
				case "before-load":
					cancel()
				case "during-load":
					store.loadHook = func(context.Context) { cancel() }
				case "not-written":
					store.saveHook = func(context.Context, Change) (SaveResult, error) {
						cancel()
						return SaveResult{Publication: NotWritten}, nil
					}
				case "after-commit":
					store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
						out := store.commit(c)
						cancel()
						return out, nil
					}
				}
				var err error
				if action == "begin" {
					var p *Permit
					p, err = s.Begin(ctx, selected(s, "op"), request())
					if p != nil {
						t.Fatal("cancelled Begin minted permit")
					}
				} else {
					err = s.ACK(ctx, r)
				}
				switch when {
				case "before-load", "during-load":
					requireError(t, err, context.Canceled)
					if store.saves != before || s.publicationFence {
						t.Fatal("prewrite cancellation saved/fenced")
					}
				case "not-written":
					requireError(t, err, ErrNotWritten)
					if s.publicationFence {
						t.Fatal("proven refusal became unknown")
					}
				case "after-commit":
					requireError(t, err, ErrFenced)
					requireError(t, s.FreezeForRetirement(), ErrFenced)
				}
			})
		}
	}
}

func TestExecutionCancellationConsumesWithoutRetry(t *testing.T) {
	for _, when := range []string{"before-load", "during-load", "after-dispatch"} {
		t.Run(when, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			o.out = completed(p.Binding())
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch when {
			case "before-load":
				cancel()
			case "during-load":
				store.loadHook = func(context.Context) { cancel() }
			case "after-dispatch":
				o.executeHook = cancel
			}
			_, err := s.Execute(ctx, p)
			requireError(t, err, context.Canceled)
			_, err = s.Execute(context.Background(), p)
			requireError(t, err, ErrConsumed)
			if when == "after-dispatch" {
				if o.executes != 1 {
					t.Fatal("missing dispatch")
				}
				requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
			} else if o.executes != 0 {
				t.Fatal("cancelled attempt dispatched")
			}
		})
	}
}

func TestRetentionBoundAndDistinctReceiptProjection(t *testing.T) {
	s, store, o := setup(t)
	ids := map[string]bool{}
	for i := range MaxAttempts {
		p := begin(t, s, fmt.Sprintf("op-%d", i))
		r := offered(t, s, o, p)
		if ids[r.ID()] {
			t.Fatal("duplicate receipt projection")
		}
		ids[r.ID()] = true
		if err := s.ACK(context.Background(), r); err != nil {
			t.Fatal(err)
		}
	}
	saves := store.saves
	_, err := s.Begin(context.Background(), selected(s, "overflow"), request())
	requireError(t, err, ErrCapacity)
	if store.saves != saves || len(s.attempts) != MaxAttempts {
		t.Fatal("retention bound violated")
	}
}

func TestRealEditValidationBeforeStorage(t *testing.T) {
	for _, mode := range []string{"path", "sha", "no-edits", "same-text", "missing-edit"} {
		t.Run(mode, func(t *testing.T) {
			s, store, _ := setup(t)
			r := request()
			e := r.Operation
			switch mode {
			case "path":
				e.RelativePath = "../escape"
			case "sha":
				e.ExpectedSHA256 = "not-a-sha"
			case "no-edits":
				e.Edits = nil
			case "same-text":
				e.Edits[0].NewText = e.Edits[0].OldText
			}
			r.Operation = e
			if mode == "missing-edit" {
				r.Operation = Edit{}
			}
			_, err := s.Begin(context.Background(), selected(s, "op"), r)
			requireError(t, err, ErrInvalid)
			if store.loads != 0 || store.saves != 0 {
				t.Fatal("invalid request reached store")
			}
		})
	}
}

func TestInvalidationBeforeOfferingReceiptAndACKPreservesIt(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	o.err = errors.New("execution response lost")
	if _, err := s.Execute(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	before := p.Binding()
	store.snapshot.Current.Generation++ // Older original binding still deliverable.
	calls := 0
	store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
		calls++
		if calls == 1 && (!c.InvalidateVerification || !samePending(c.Next, &before) || !samePending(c.Expected.Pending, &before)) {
			t.Fatal("unknown receipt did not request exact one-way invalidation")
		}
		if calls == 2 && (c.InvalidateVerification || c.Next != nil || !c.Expected.VerificationInvalidated) {
			t.Fatal("ACK changed invalidation policy or lost pending precondition")
		}
		return store.commit(c), nil
	}
	r, err := s.Offer(context.Background(), before)
	if err != nil {
		t.Fatal(err)
	}
	if !store.snapshot.VerificationInvalidated || r.Binding() != before || r.Outcome().ComputerGeneration != 7 {
		t.Fatal("receipt issued without durable invalidation/original binding")
	}
	if err = s.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if !store.snapshot.VerificationInvalidated || store.snapshot.Pending != nil || store.unrelated != "preserved" {
		t.Fatal("ACK widened verification or changed unrelated configuration")
	}
	requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
	if calls != 2 {
		t.Fatal("invalidation or ACK repeated")
	}
}

func TestInvalidationRefusalAmbiguityAndCancellationOfferNoReceipt(t *testing.T) {
	for _, mode := range []string{"not-written", "unknown-before", "lost-after", "wrong-readback", "cancel-before", "cancel-after", "foreign-pending"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			o.out = unknownResult(p.Binding())
			if _, err := s.Execute(context.Background(), p); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			store.saveHook = func(_ context.Context, c Change) (SaveResult, error) {
				if !c.InvalidateVerification {
					t.Fatal("unknown execution did not request invalidation")
				}
				switch mode {
				case "not-written":
					return SaveResult{Publication: NotWritten}, nil
				case "unknown-before":
					return SaveResult{Publication: PublicationUnknown}, nil
				case "lost-after":
					out := store.commit(c)
					return out, errors.New("invalidation readback lost")
				case "wrong-readback":
					out := store.commit(c)
					out.Readback.VerificationInvalidated = false
					return out, nil
				case "cancel-after":
					out := store.commit(c)
					cancel()
					return out, nil
				default:
					t.Fatal("unexpected save")
					return SaveResult{}, nil
				}
			}
			if mode == "cancel-before" {
				cancel()
			}
			if mode == "foreign-pending" {
				store.snapshot.Pending.OperationID = fixtureID("new")
			}
			r, err := s.Offer(ctx, p.Binding())
			if r != nil || err == nil {
				t.Fatal("uncertain/refused invalidation offered a receipt")
			}
			switch mode {
			case "not-written":
				requireError(t, err, ErrNotWritten)
				if s.publicationFence {
					t.Fatal("proven invalidation refusal fenced publication")
				}
			case "cancel-before":
				requireError(t, err, context.Canceled)
				if store.saves != 1 {
					t.Fatal("cancelled invalidation saved")
				}
			case "foreign-pending":
				requireError(t, err, ErrConflict)
				if store.saves != 1 {
					t.Fatal("foreign pending invalidated")
				}
			default:
				requireError(t, err, ErrFenced)
				saves := store.saves
				_, err = s.Offer(context.Background(), p.Binding())
				requireError(t, err, ErrFenced)
				requireError(t, s.FreezeForRetirement(), ErrFenced)
				if store.saves != saves {
					t.Fatal("unknown invalidation was retried")
				}
			}
		})
	}
}

func TestAlreadyInvalidatedWarningDoesNotSaveAgain(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	o.out = unknownResult(p.Binding())
	if _, err := s.Execute(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	store.snapshot.VerificationInvalidated = true
	r, err := s.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if store.saves != 1 || r.Retention() != MemoryOnly {
		t.Fatal("already confirmed invalidation saved again")
	}
	if err = s.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if !store.snapshot.VerificationInvalidated {
		t.Fatal("ACK cleared invalidation")
	}
}

func TestMalformedRestoredOutcomeRequiresInvalidationBeforeWarning(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	restored, err := New(s.identity, store, o, fixedClock{}, &sync.Mutex{})
	if err != nil {
		t.Fatal(err)
	}
	o.out = completed(p.Binding())
	o.out.WorkspaceID = fixtureID("foreign")
	_, err = restored.Observe(context.Background(), p.Binding())
	requireError(t, err, ErrInvalid)
	r, err := restored.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if r.Outcome().WorkspaceID != fixtureID("workspace") || r.Outcome().Phase != "outcome_unknown" || !store.snapshot.VerificationInvalidated || o.executes != 0 {
		t.Fatal("malformed restored result became trustworthy")
	}
}

func TestLateCancelledExecutionRequiresInvalidationBeforeDelivery(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	o.out = completed(p.Binding())
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	o.executeHook = cancel
	_, err := s.Execute(ctx, p)
	requireError(t, err, context.Canceled)
	r, err := s.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	if !store.snapshot.VerificationInvalidated || r.Outcome().Phase != "completed" || r.Retention() != Durable {
		t.Fatal("late cancellation lost exact result or required invalidation")
	}
	if err = s.ACK(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
}

func TestWarningACKRefusesLostInvalidationWithoutAnotherSave(t *testing.T) {
	s, store, o := setup(t)
	p := begin(t, s, "op")
	o.out = unknownResult(p.Binding())
	if _, err := s.Execute(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	r, err := s.Offer(context.Background(), p.Binding())
	if err != nil {
		t.Fatal(err)
	}
	store.snapshot.VerificationInvalidated = false
	store.snapshot.Revision++
	saves := store.saves
	requireError(t, s.ACK(context.Background(), r), ErrConflict)
	if store.saves != saves || store.snapshot.Pending == nil {
		t.Fatal("warning ACK erased pending without confirmed invalidation")
	}
	requireError(t, s.FreezeForRetirement(), ErrEffectUnsettled)
	_, err = s.Offer(context.Background(), p.Binding())
	requireError(t, err, ErrEffectUnsettled)
	if store.saves != saves {
		t.Fatal("retirement freeze allowed invalidation write")
	}
}

func TestBeginRequiresOriginalPreviewGenerationAndIdentity(t *testing.T) {
	for _, mode := range []string{"stale-preview", "changed-during-load", "owner", "profile", "computer", "zero-generation"} {
		t.Run(mode, func(t *testing.T) {
			s, store, o := setup(t)
			original := selected(s, "op")
			switch mode {
			case "stale-preview":
				original.ComputerGeneration = 6
			case "changed-during-load":
				store.loadHook = func(context.Context) { store.snapshot.Current.Generation++ }
			case "owner":
				original.OwnerID = "foreign"
			case "profile":
				original.ProfileID = fixtureID("foreign")
			case "computer":
				original.ComputerID = fixtureID("foreign")
			case "zero-generation":
				original.ComputerGeneration = 0
			}
			permit, err := s.Begin(context.Background(), original, request())
			if permit != nil || err == nil || store.saves != 0 || store.snapshot.Pending != nil || o.executes != 0 {
				t.Fatal("original preview silently rebound or dispatched")
			}
			if mode == "stale-preview" || mode == "changed-during-load" {
				requireError(t, err, ErrConflict)
			} else {
				requireError(t, err, ErrInvalid)
			}
		})
	}
}

func TestSettingsUUIDContractRejectsIncompatibleIdentityBeforeWrite(t *testing.T) {
	valid := fixtureID("operation")
	for _, malformed := range []string{
		"operation", strings.ToUpper(valid), valid[:14] + "5" + valid[15:], valid[:19] + "7" + valid[20:],
		valid[:8] + "_" + valid[9:], valid + "0", " " + valid,
	} {
		for _, field := range []string{"operation", "profile", "computer", "workspace"} {
			t.Run(field+"/"+malformed, func(t *testing.T) {
				s, store, o := setup(t)
				selection := selected(s, "op")
				r := request()
				switch field {
				case "operation":
					selection.OperationID = malformed
				case "profile":
					selection.ProfileID = malformed
				case "computer":
					selection.ComputerID = malformed
				case "workspace":
					r.WorkspaceID = malformed
				}
				permit, err := s.Begin(context.Background(), selection, r)
				requireError(t, err, ErrInvalid)
				if permit != nil || store.saves != 0 || store.loads != 0 || o.executes != 0 {
					t.Fatal("incompatible Settings identity reached storage/execution")
				}
			})
		}
	}
}

func TestPersistedAndCurrentUUIDContractRefusesInsteadOfEmptyProjection(t *testing.T) {
	for _, field := range []string{"pending-operation", "pending-profile", "pending-workspace", "current-profile", "current-computer", "legacy-backend"} {
		t.Run(field, func(t *testing.T) {
			s, store, o := setup(t)
			p := begin(t, s, "op")
			observer, constructErr := New(s.identity, store, o, fixedClock{}, &sync.Mutex{})
			if constructErr != nil {
				t.Fatal(constructErr)
			}
			switch field {
			case "pending-operation":
				store.snapshot.Pending.OperationID = "legacy-operation"
			case "pending-profile":
				store.snapshot.Pending.ProfileID = "legacy-profile"
			case "pending-workspace":
				store.snapshot.Pending.WorkspaceID = "legacy-workspace"
			case "current-profile":
				store.snapshot.Current.ProfileID = "legacy-profile"
			case "current-computer":
				store.snapshot.Current.ComputerID = "legacy-computer"
			case "legacy-backend":
				store.snapshot.Pending.Backend = ""
			}
			_, err := observer.Observe(context.Background(), p.Binding())
			requireError(t, err, ErrInvalid)
			_, err = observer.Begin(context.Background(), selected(observer, "new"), request())
			requireError(t, err, ErrInvalid)
			if store.saves != 1 || store.snapshot.Pending == nil || o.executes != 0 || o.observes != 0 {
				t.Fatal("incompatible projection became empty pending or reached outcome port")
			}
		})
	}
}

func TestDomainEditValidationStillEnforcesTextAndEditLimits(t *testing.T) {
	for _, mode := range []string{"empty-old", "nul-text", "invalid-utf8", "too-many-edits"} {
		t.Run(mode, func(t *testing.T) {
			s, store, _ := setup(t)
			r := request()
			switch mode {
			case "empty-old":
				r.Operation.Edits[0].OldText = ""
			case "nul-text":
				r.Operation.Edits[0].NewText = "after\x00"
			case "invalid-utf8":
				r.Operation.Edits[0].NewText = string([]byte{0xff})
			case "too-many-edits":
				r.Operation.Edits = make([]TextEdit, 257)
				for i := range r.Operation.Edits {
					r.Operation.Edits[i] = TextEdit{OldText: "before", NewText: "after"}
				}
			}
			_, err := s.Begin(context.Background(), selected(s, "op"), r)
			requireError(t, err, ErrInvalid)
			if store.saves != 0 || store.loads != 0 {
				t.Fatal("invalid Edit passed the explicit domain mapping")
			}
		})
	}
}

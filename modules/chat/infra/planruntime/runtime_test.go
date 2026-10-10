package planruntime_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	cp "github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	"github.com/legrch/farol/modules/chat/app/services/inference"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	ms "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/catalogue"
	"github.com/legrch/farol/modules/chat/infra/clients/planresponses"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
	runtime "github.com/legrch/farol/modules/chat/infra/planruntime"
)

// These tests use actual producer policies, private account Grant, runtime,
// inference service and strict HTTP/SSE transport. Source owner, clock, durable
// journal, credential store, HTTP writer and publication are controlled ports.
// They are not live subscription, shipping boot, transcript or journal evidence.
type clock struct {
	mu  sync.Mutex
	now uint64
}

func (c *clock) NowMillis() uint64 { c.mu.Lock(); defer c.mu.Unlock(); return c.now }
func (c *clock) change(v uint64)   { c.mu.Lock(); defer c.mu.Unlock(); c.now = v }

type estimator struct{}

func (estimator) EstimateTokens(s string) (int, error) {
	return (utf8.RuneCountInString(s) + 2) / 3, nil
}

type source struct {
	mu         sync.Mutex
	value      cb.Source
	closed     bool
	beforeGate func()
	entered    bool
}

func (s *source) Read(ctx context.Context, b cb.Binding) (cb.Source, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if ctx.Err() != nil || s.closed || b != s.value.Binding {
		return cb.Source{}, cb.Stale
	}
	v := s.value
	v.Events = append([]cb.Event(nil), v.Events...)
	return v, nil
}
func sourceRef(v cb.Source) (cb.SourceRef, error) {
	raw, err := cb.CanonicalSource(v)
	if err != nil {
		return cb.SourceRef{}, err
	}
	hash, err := (intent.SHA256{}).Digest(raw)
	if err != nil {
		return cb.SourceRef{}, err
	}
	first, last := v.Events[0], v.Events[len(v.Events)-1]
	return cb.SourceRef{Binding: v.Binding, Revision: v.Revision, FirstSequence: first.Sequence, LastSequence: last.Sequence, FirstEventID: first.ID, LastEventID: last.ID, SHA256: hash}, nil
}
func (s *source) check(ctx context.Context, r cb.SourceRef) error {
	ref, err := sourceRef(s.value)
	if ctx.Err() != nil || s.closed || err != nil || ref != r {
		return cb.Stale
	}
	return nil
}
func (s *source) Check(ctx context.Context, r cb.SourceRef) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.check(ctx, r)
}
func (s *source) WithCurrent(ctx context.Context, r cb.SourceRef, f func() error) error {
	if s.beforeGate != nil {
		s.beforeGate()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.check(ctx, r); err != nil {
		return err
	}
	s.entered = true
	defer func() { s.entered = false }()
	return f()
}
func (s *source) withdraw() { s.mu.Lock(); defer s.mu.Unlock(); s.closed = true }
func (s *source) changeOmitted() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.value.Events[0].Text += "changed omitted original"
}

type selected struct {
	mu          sync.Mutex
	original    inference.Selection
	observation chatport.AccountObservation
	cache       *catalogue.Cache
	resolved    ms.Resolved
	clock       *clock
}

func (s *selected) WithSelected(ctx context.Context, want inference.Selection, f func(chatport.AccountObservation) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.cache.Current()
	pin := s.resolved.Pin()
	if ctx.Err() != nil || want != s.original || err != nil || ms.RecheckBeforeStart(s.resolved, current, ms.Scope{Route: pin.Route, AccountID: pin.AccountID}, s.clock.NowMillis()) != nil {
		return inference.Withdrawn
	}
	return f(s.observation)
}
func (s *selected) withdraw() { s.mu.Lock(); defer s.mu.Unlock(); s.original.Account.Epoch++ }

type ledger struct {
	mu                        sync.Mutex
	calls, settles            int
	refs                      []runtime.Reference
	hashes                    []string
	outcomes                  []inference.Outcome
	used                      map[string]string
	reserveError, settleError error
	afterReserve, afterSettle func()
}

func (l *ledger) Reserve(ctx context.Context, r runtime.Reference, hash string) (bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls++
	l.refs = append(l.refs, r)
	l.hashes = append(l.hashes, hash)
	if l.reserveError != nil {
		return false, l.reserveError
	}
	if _, exists := l.used[r.Binding.OperationID]; exists {
		return false, nil
	}
	l.used[r.Binding.OperationID] = hash
	if l.afterReserve != nil {
		l.afterReserve()
	}
	return true, nil
}
func (l *ledger) Settle(ctx context.Context, r runtime.Reference, o inference.Outcome) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.settles++
	l.refs = append(l.refs, r)
	l.outcomes = append(l.outcomes, o)
	if l.afterSettle != nil {
		l.afterSettle()
	}
	return l.settleError
}

type credentials struct {
	calls int
	value inference.Credential
	refs  []runtime.Reference
	after func()
}

func (c *credentials) Acquire(ctx context.Context, r runtime.Reference) (inference.Credential, error) {
	c.calls++
	c.refs = append(c.refs, r)
	if c.after != nil {
		c.after()
	}
	return c.value, nil
}

type publication struct {
	calls  int
	refs   []runtime.Reference
	source *source
	err    error
}

func (p *publication) Publish(r runtime.Reference, o inference.Outcome) error {
	if !p.source.entered {
		return errors.New("publication outside original source gate")
	}
	p.calls++
	p.refs = append(p.refs, r)
	return p.err
}

type writer struct {
	calls  int
	body   []byte
	err    error
	after  func()
	stream string
}

func (w *writer) RoundTrip(r *http.Request) (*http.Response, error) {
	w.calls++
	raw, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	w.body = append([]byte(nil), raw...)
	if w.after != nil {
		w.after()
	}
	if w.err != nil {
		return nil, w.err
	}
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(w.stream))}, nil
}

const responseStream = "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_composition\",\"status\":\"in_progress\"}}\n\n" +
	"data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_composition\",\"delta\":\"answer\"}\n\n" +
	"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_composition\",\"status\":\"completed\"}}\n\n"

type fixture struct {
	clock        *clock
	source       *source
	selected     *selected
	ledger       *ledger
	credentials  *credentials
	publication  *publication
	writer       *writer
	context      *cp.Service
	materialized *cp.PlanMaterialization
	prepared     *runtime.Prepared
	runtime      *runtime.Runtime
	capture      runtime.Capture
	policy       cb.Policy
	original     cp.PlanView
	binding      inference.Binding
	authority    inference.Authority
}

func history(binding cb.Binding) cb.Source {
	s := cb.Source{Binding: binding, Revision: 7}
	for i := 0; i < 48; i++ {
		turn := cb.Turn{SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: fmt.Sprintf("turn-%d", i), OperationID: fmt.Sprintf("operation-%d", i), TaskEpoch: 3, TurnGeneration: 9}
		outcome := cb.Completed
		if i == 1 {
			outcome = cb.Unknown
		}
		for n, e := range []cb.Event{{Kind: cb.User, Text: fmt.Sprintf("original user %d café λ🙂", i)}, {Kind: cb.Call, CallID: fmt.Sprintf("call-%d", i), ToolOperationID: fmt.Sprintf("tool-%d", i), Name: "observe", Text: `{"path":"synthetic"}`}, {Kind: cb.Result, CallID: fmt.Sprintf("call-%d", i), ToolOperationID: fmt.Sprintf("tool-%d", i), Outcome: outcome, Text: "done prose does not resolve unknown"}, {Kind: cb.Assistant, Text: "original answer"}} {
			e.ID = fmt.Sprintf("event-%d-%d", i, n)
			e.Sequence = uint64(len(s.Events) + 1)
			e.Turn = turn
			s.Events = append(s.Events, e)
		}
	}
	return s
}
func digest(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	value, err := (intent.SHA256{}).Digest(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{clock: &clock{now: uint64(time.Now().UnixMilli())}, ledger: &ledger{used: map[string]string{}}, credentials: &credentials{}, writer: &writer{stream: responseStream}}
	now := f.clock.NowMillis()
	account := inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "subject", ClientID: "client", HostID: "urn:uuid:host", Epoch: 1}
	scope := ms.Scope{Route: ms.Route{Provider: "openai", Backend: ms.PlanInference, Billing: ms.Plan}, AccountID: digest(t, account)}
	cache := &catalogue.Cache{}
	cache.Activate(scope)
	ticket := cache.Begin()
	snapshot := ms.Snapshot{Scope: scope, Epoch: ticket.Epoch(), Revision: "revision", ObservedAtMillis: now - 1, ExpiresAtMillis: now + 60000, Source: ms.SIWC, Complete: true, Entries: []ms.Entry{{Slug: "model", DisplayName: "Model", Efforts: []string{"high"}, DefaultEffort: "high", Capabilities: ms.Capabilities{Text: ms.Yes, Image: ms.No, Tools: ms.No, Revision: "capability", Provenance: "independent-fixture-evidence"}}}}
	if err := cache.Complete(ticket, snapshot, nil); err != nil {
		t.Fatal(err)
	}
	resolved, err := ms.Resolve(snapshot, scope, now, ms.Request{Slug: "model", Effort: "high", Requirements: ms.Requirements{Text: true}})
	if err != nil {
		t.Fatal(err)
	}
	pin := resolved.Pin()
	selection := inference.Selection{Backend: inference.PlanBackend, Account: account, ConsentID: "consent", ConsentRevision: 1, Model: inference.ModelSelection{Slug: pin.Model, Effort: pin.Effort, CapabilityEvidence: pin.CapabilityRevision, CatalogueEpoch: pin.Epoch}}
	binding := cb.Binding{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", AccountID: scope.AccountID, Provider: "openai", ModelID: pin.Model, Effort: pin.Effort, CapabilityEpoch: pin.CapabilityRevision}
	f.source = &source{value: history(binding)}
	f.context, err = cp.New(cp.Dependencies{Gate: gate.New(), Source: f.source, Digests: intent.SHA256{}, Estimator: estimator{}})
	if err != nil {
		t.Fatal(err)
	}
	f.policy = cb.Policy{Limit: cb.Metrics{Bytes: 14000, CodePoints: 12000, EstimatedTokens: 8000}, Reserve: cb.Metrics{Bytes: 2000, CodePoints: 2000, EstimatedTokens: 1000}}
	prepared, err := f.context.Prepare(context.Background(), binding, "checkpoint", "context-operation", f.policy)
	if err != nil {
		t.Fatal(err)
	}
	f.materialized, err = f.context.MaterializePlan(context.Background(), prepared, binding)
	if err != nil {
		t.Fatal(err)
	}
	f.original, err = f.materialized.View(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	estimate, err := ms.CaptureEstimate(resolved, f.original.Receipt.InputHash, ms.EstimateObservation{Qualified: true, ObservedAtMillis: now - 1, ExpiresAtMillis: now + 1000}, ms.Estimate{Source: "context-estimator", Version: "v1", Currency: "USD", InputTokens: ms.Quantity{Known: true, Value: f.original.Receipt.EstimatedTokens}, OutputTokens: ms.Quantity{Known: true}, CostMicrounits: ms.Quantity{Known: true}})
	if err != nil {
		t.Fatal(err)
	}
	f.binding = inference.Binding{OperationID: "inference-operation", ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", Selection: selection, DeadlineMillis: now + 60000}
	f.capture = runtime.Capture{Plan: f.materialized, Binding: f.binding, Resolved: resolved, Estimate: estimate, Budget: ms.Budget{MaxInputTokens: ms.Quantity{Known: true, Value: f.original.Receipt.TokenLimit}}, EstimatorSource: "context-estimator", EstimatorVersion: "v1"}
	f.prepared, err = runtime.Prepare(context.Background(), f.capture, intent.SHA256{})
	if err != nil {
		t.Fatal(err)
	}
	observation := chatport.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("a", 64), ObservedAtMillis: now, ExpiresAtMillis: now + 60000}
	f.selected = &selected{original: selection, observation: observation, cache: cache, resolved: resolved, clock: f.clock}
	accountScope := chatport.AccountScope{ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session"}
	owner, err := accountapproval.New(accountScope, gate.New(), f.clock)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := owner.Approve(context.Background(), selection.ConsentID, 0, observation)
	if err != nil {
		t.Fatal(err)
	}
	authority, err := planresponses.NewConsentFence(grant, accountScope, selection, f.selected)
	if err != nil {
		t.Fatal(err)
	}
	f.authority = authority
	f.credentials.value = inference.Credential{Account: account, AccessToken: "synthetic-composition-credential", RequestedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, GrantedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, ExpiresAtMillis: now + 60000, Generation: 1}
	f.publication = &publication{source: f.source}
	f.runtime, err = runtime.New(runtime.Options{Source: f.source, Account: authority, Clock: f.clock, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Ledger: f.ledger, Credentials: f.credentials, Publication: f.publication, HTTP: &http.Client{Transport: f.writer}})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestActualRuntimeComposesExactProducerWireAndCompleteSidecars(t *testing.T) {
	f := newFixture(t)
	got := f.runtime.Infer(context.Background(), f.prepared)
	if got.State != inference.Completed || got.Text != "answer" || f.ledger.calls != 1 || f.credentials.calls != 1 || f.writer.calls != 1 || f.publication.calls != 1 || !bytes.Equal(f.writer.body, f.original.ProviderJSON) {
		t.Fatalf("actual composed path %+v reserve=%d credentials=%d http=%d publish=%d", got, f.ledger.calls, f.credentials.calls, f.writer.calls, f.publication.calls)
	}
	ref := f.prepared.Reference()
	if ref.Receipt != f.original.Receipt || len(ref.Window.Unresolved) != 1 || ref.Window.Unresolved[0].Outcome != cb.Unknown || ref.Window.OmittedEvents == 0 {
		t.Fatal("source UNKNOWN/omitted history/reservations lost")
	}
	for _, r := range append(append(f.ledger.refs, f.credentials.refs...), f.publication.refs...) {
		if digest(t, r) != digest(t, ref) {
			t.Fatal("full sidecar changed through actual owner ports")
		}
	}
	if len(f.ledger.outcomes) != 1 || f.ledger.outcomes[0].Text != "" {
		t.Fatal("output text persisted in settlement metadata")
	}
	again := f.runtime.Infer(context.Background(), f.prepared)
	if again.State != inference.NotSent || again.Code != inference.AlreadyReserved || f.writer.calls != 1 {
		t.Fatal("original operation replayed")
	}
}

func TestRuntimePreparedViewIsDetachedAndCannotRetargetOriginal(t *testing.T) {
	f := newFixture(t)
	original := f.prepared.Reference()
	view := f.prepared.Reference()
	view.Receipt.Policy.Reserve.Bytes++
	view.Binding.Context.InputHash = strings.Repeat("b", 64)
	view.Window.Unresolved[0].Outcome = cb.Completed
	view.Window.Events[0].Text = "replacement"
	if digest(t, original) != digest(t, f.prepared.Reference()) {
		t.Fatal("reference view mutated retained operation")
	}
	f.credentials.after = func() {
		if len(f.credentials.refs[0].Window.Unresolved) > 0 {
			f.credentials.refs[0].Window.Unresolved[0].Outcome = cb.Completed
		}
	}
	got := f.runtime.Infer(context.Background(), f.prepared)
	if got.State != inference.Completed || f.publication.refs[0].Window.Unresolved[0].Outcome != cb.Unknown {
		t.Fatal("IO adapter mutated original unknown sidecar")
	}
}

func TestRuntimeSourceAccountModelAndEstimateWithdrawBeforeFirstEffects(t *testing.T) {
	for _, kind := range []string{"source", "omitted original", "account", "catalogue", "estimate expiry", "clock rollback", "unqualified estimate", "foreign input", "unknown limit", "changed limit", "browser account route"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			switch kind {
			case "source":
				f.source.withdraw()
			case "omitted original":
				f.source.changeOmitted()
			case "account":
				f.selected.withdraw()
			case "catalogue":
				f.selected.cache.Activate(ms.Scope{Route: f.capture.Resolved.Pin().Route, AccountID: "different-account"})
			case "estimate expiry":
				f.clock.change(f.capture.Estimate.Snapshot().Observation.ExpiresAtMillis)
			case "clock rollback":
				f.clock.change(f.capture.Estimate.Snapshot().Observation.ObservedAtMillis - 1)
			default:
				c := f.capture
				switch kind {
				case "unqualified estimate":
					s := c.Estimate.Snapshot()
					c.Estimate, _ = ms.CaptureEstimate(c.Resolved, s.InputDigest, ms.EstimateObservation{}, s.Estimate)
				case "foreign input":
					s := c.Estimate.Snapshot()
					c.Estimate, _ = ms.CaptureEstimate(c.Resolved, strings.Repeat("b", 64), s.Observation, s.Estimate)
				case "unknown limit":
					c.Budget.MaxInputTokens = ms.Quantity{}
				case "changed limit":
					c.Budget.MaxInputTokens.Value++
				case "browser account route":
					c.Binding.Selection.Backend = "browser-chat"
				}
				p, err := runtime.Prepare(context.Background(), c, intent.SHA256{})
				if err == nil {
					f.prepared = p
				} else {
					if f.ledger.calls != 0 || f.writer.calls != 0 {
						t.Fatal("preparation effects")
					}
					return
				}
			}
			got := f.runtime.Infer(context.Background(), f.prepared)
			if got.State != inference.NotSent || f.ledger.calls != 0 || f.credentials.calls != 0 || f.writer.calls != 0 || f.publication.calls != 0 {
				t.Fatalf("pre-first-effect refusal %+v", got)
			}
		})
	}
}

func TestRuntimeWithdrawalAcrossOriginalIOAndFinalPublication(t *testing.T) {
	for _, point := range []string{"reserve", "credentials", "http", "settle"} {
		for _, kind := range []string{"source", "omitted original", "account", "estimate expiry"} {
			t.Run(point+"/"+kind, func(t *testing.T) {
				f := newFixture(t)
				withdraw := func() {
					switch kind {
					case "source":
						f.source.withdraw()
					case "omitted original":
						f.source.changeOmitted()
					case "account":
						f.selected.withdraw()
					case "estimate expiry":
						f.clock.change(f.capture.Estimate.Snapshot().Observation.ExpiresAtMillis)
					}
				}
				switch point {
				case "reserve":
					f.ledger.afterReserve = withdraw
				case "credentials":
					f.credentials.after = withdraw
				case "http":
					f.writer.after = withdraw
				case "settle":
					f.ledger.afterSettle = withdraw
				}
				got := f.runtime.Infer(context.Background(), f.prepared)
				expectedHTTP := 0
				if point == "http" || point == "settle" {
					expectedHTTP = 1
				}
				if f.writer.calls != expectedHTTP || f.publication.calls != 0 || got.Text != "" || f.ledger.settles != 1 {
					t.Fatalf("late original effect leakage %+v HTTP=%d publish=%d settles=%d", got, f.writer.calls, f.publication.calls, f.ledger.settles)
				}
				if expectedHTTP == 1 && got.State != inference.Suppressed {
					t.Fatalf("original remote completion discarded %+v", got)
				}
				if expectedHTTP == 0 && got.State != inference.NotSent {
					t.Fatalf("unsent outcome wrong %+v", got)
				}
			})
		}
	}
}

func TestRuntimeLostOriginalAcknowledgementsRemainUnknownWithoutHTTPReplay(t *testing.T) {
	for _, point := range []string{"reserve", "http", "settle", "publication"} {
		t.Run(point, func(t *testing.T) {
			f := newFixture(t)
			lost := errors.New("controlled lost original acknowledgement")
			switch point {
			case "reserve":
				f.ledger.reserveError = lost
			case "http":
				f.writer.err = lost
			case "settle":
				f.ledger.settleError = lost
			case "publication":
				f.publication.err = lost
			}
			got := f.runtime.Infer(context.Background(), f.prepared)
			if got.State != inference.Unknown || got.Text != "" {
				t.Fatalf("unknown downgraded %+v", got)
			}
			if point != "reserve" {
				again := f.runtime.Infer(context.Background(), f.prepared)
				if again.Code != inference.AlreadyReserved || f.writer.calls != 1 {
					t.Fatal("original HTTP retried")
				}
			}
		})
	}
}

func TestRuntimeOriginalCompleteIntentChangesForSameProviderBytes(t *testing.T) {
	for _, kind := range []string{"omitted original", "byte reserve", "codepoint reserve", "token reserve"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			if got := f.runtime.Infer(context.Background(), f.prepared); got.State != inference.Completed {
				t.Fatal(got)
			}
			if kind == "omitted original" {
				f.source.changeOmitted()
			} else {
				switch kind {
				case "byte reserve":
					f.policy.Reserve.Bytes++
				case "codepoint reserve":
					f.policy.Reserve.CodePoints++
				case "token reserve":
					f.policy.Reserve.EstimatedTokens++
				}
			}
			s, err := cp.New(cp.Dependencies{Gate: gate.New(), Source: f.source, Digests: intent.SHA256{}, Estimator: estimator{}})
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := s.Prepare(context.Background(), f.source.value.Binding, "checkpoint", "context-operation", f.policy)
			if err != nil {
				t.Fatal(err)
			}
			projection, err := s.MaterializePlan(context.Background(), prepared, f.source.value.Binding)
			if err != nil {
				t.Fatal(err)
			}
			view, err := projection.View(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(view.ProviderJSON, f.original.ProviderJSON) || view.Receipt.IdentityHash == f.original.Receipt.IdentityHash {
				t.Fatal("not a same-provider/different-original counterexample")
			}
			c := f.capture
			c.Plan = projection
			snap := c.Estimate.Snapshot()
			snap.Estimate.InputTokens.Value = view.Receipt.EstimatedTokens
			c.Estimate, err = ms.CaptureEstimate(c.Resolved, view.Receipt.InputHash, snap.Observation, snap.Estimate)
			if err != nil {
				t.Fatal(err)
			}
			c.Budget.MaxInputTokens.Value = view.Receipt.TokenLimit
			next, err := runtime.Prepare(context.Background(), c, intent.SHA256{})
			if err != nil {
				t.Fatal(err)
			}
			// Compare identical inference operation IDs and final wire bytes. Full sidecar
			// must remain in the owning journal's intent, not only in a validation wrapper.
			if got := f.runtime.Infer(context.Background(), next); got.State != inference.NotSent || got.Code != inference.AlreadyReserved {
				t.Fatal(got)
			}
			if len(f.ledger.hashes) != 2 || f.ledger.hashes[0] == f.ledger.hashes[1] || f.writer.calls != 1 {
				t.Fatal("full original/reservation identity collapsed or operation replayed")
			}
			if next.Reference().Receipt.Source == f.prepared.Reference().Receipt.Source && kind == "omitted original" {
				t.Fatal("full original source lost")
			}
		})
	}
}

func TestActualStrictWirePreflightRejectsProducerJSONBeforeOwnerEffects(t *testing.T) {
	for _, arguments := range []string{`{"a":1,"a":2}`, `{"a":"\ud800"}`, `{"nested":{"a":1,"a":2}}`} {
		t.Run(arguments, func(t *testing.T) {
			f := newFixture(t)
			// This is actual original history, not an edited materialization. CONTEXT's
			// JSON grammar accepts these; actual planresponses strict grammar refuses.
			f.source.value.Events[5].Text = arguments
			service, err := cp.New(cp.Dependencies{Gate: gate.New(), Source: f.source, Digests: intent.SHA256{}, Estimator: estimator{}})
			if err != nil {
				t.Fatal(err)
			}
			prepared, err := service.Prepare(context.Background(), f.source.value.Binding, "strict-checkpoint", "strict-operation", f.policy)
			if err != nil {
				t.Fatal(err)
			}
			projection, err := service.MaterializePlan(context.Background(), prepared, f.source.value.Binding)
			if err != nil {
				t.Fatal(err)
			}
			view, err := projection.View(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			c := f.capture
			c.Plan = projection
			s := c.Estimate.Snapshot()
			s.Estimate.InputTokens.Value = view.Receipt.EstimatedTokens
			c.Estimate, err = ms.CaptureEstimate(c.Resolved, view.Receipt.InputHash, s.Observation, s.Estimate)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = runtime.Prepare(context.Background(), c, intent.SHA256{}); !errors.Is(err, inference.Invalid) {
				t.Fatalf("strict actual wire accepted: %v", err)
			}
			if f.ledger.calls != 0 || f.credentials.calls != 0 || f.writer.calls != 0 || f.publication.calls != 0 {
				t.Fatal("invalid original wire entered owner effects")
			}
		})
	}
}

func TestRuntimeEstimateExpiresDuringFinalGateWait(t *testing.T) {
	f := newFixture(t)
	// First post-settlement authority check enters once; the second is the final
	// publication callback. Freshness can change while waiting for that lock.
	calls := 0
	f.ledger.afterSettle = func() {
		f.source.beforeGate = func() {
			calls++
			if calls == 2 {
				f.clock.change(f.capture.Estimate.Snapshot().Observation.ExpiresAtMillis)
			}
		}
	}
	got := f.runtime.Infer(context.Background(), f.prepared)
	if got.State != inference.Suppressed || got.RemoteState != inference.Completed || got.Text != "" || f.writer.calls != 1 || f.publication.calls != 0 || f.ledger.settles != 1 {
		t.Fatalf("expired-after-gate-wait output exposed: %+v", got)
	}
}

func TestRuntimeConcurrentOriginalOperationUsesOneOwningJournalReservation(t *testing.T) {
	f := newFixture(t)
	start := make(chan struct{})
	results := make(chan inference.Outcome, 2)
	for range 2 {
		go func() { <-start; results <- f.runtime.Infer(context.Background(), f.prepared) }()
	}
	close(start)
	first, second := <-results, <-results
	completed, reserved := 0, 0
	for _, got := range []inference.Outcome{first, second} {
		if got.State == inference.Completed {
			completed++
		}
		if got.State == inference.NotSent && got.Code == inference.AlreadyReserved {
			reserved++
		}
	}
	if completed != 1 || reserved != 1 || f.writer.calls != 1 || f.credentials.calls != 1 || f.publication.calls != 1 || f.ledger.settles != 1 {
		t.Fatalf("concurrent original reservation replayed: %+v %+v", first, second)
	}
}

func TestRuntimeRetainsOriginalExplicitHTTPWriter(t *testing.T) {
	f := newFixture(t)
	client := &http.Client{Transport: f.writer}
	options := runtime.Options{Source: f.source, Account: f.authority, Clock: f.clock, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Ledger: f.ledger, Credentials: f.credentials, Publication: f.publication, HTTP: client}
	actual, err := runtime.New(options)
	if err != nil {
		t.Fatal(err)
	}
	replacement := &writer{stream: responseStream}
	client.Transport = replacement
	if got := actual.Infer(context.Background(), f.prepared); got.State != inference.Completed || f.writer.calls != 1 || replacement.calls != 0 {
		t.Fatalf("mutable HTTP handle crossed writer: %+v", got)
	}
	options.HTTP = &http.Client{}
	if _, err = runtime.New(options); !errors.Is(err, inference.Invalid) {
		t.Fatal("ambient implicit physical writer accepted")
	}
	options.HTTP = nil
	if _, err = runtime.New(options); !errors.Is(err, inference.Invalid) {
		t.Fatal("missing physical writer accepted")
	}
}

type lockTopology struct {
	account, chat sync.Mutex
	attempts      chan string
	source        runtime.SourceGate
	authority     inference.Authority
}
type topologyAccount struct{ topology *lockTopology }

func (a topologyAccount) WithCurrent(ctx context.Context, b inference.Binding, f func() error) error {
	a.topology.attempts <- "account"
	a.topology.account.Lock()
	defer a.topology.account.Unlock()
	return a.topology.authority.WithCurrent(ctx, b, f)
}

type topologySource struct{ topology *lockTopology }

func (s topologySource) WithCurrent(ctx context.Context, r cb.SourceRef, f func() error) error {
	s.topology.attempts <- "chat"
	s.topology.chat.Lock()
	defer s.topology.chat.Unlock()
	return s.topology.source.WithCurrent(ctx, r, f)
}

func TestRuntimeAccountThenSourceMatchesConcurrentBrowserGuardOrder(t *testing.T) {
	f := newFixture(t)
	// Controlled SAME guard topology, with the actual ConsentFence/Grant nested
	// under the original account guard. The existing Browser peer acquires
	// account then Chat. TryLock observes a cycle without hanging or native IO.
	topology := &lockTopology{attempts: make(chan string, 64), source: f.source, authority: f.authority}
	actual, err := runtime.New(runtime.Options{Source: topologySource{topology}, Account: topologyAccount{topology}, Clock: f.clock, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Ledger: f.ledger, Credentials: f.credentials, Publication: f.publication, HTTP: &http.Client{Transport: f.writer}})
	if err != nil {
		t.Fatal(err)
	}
	held, tryChat, result := make(chan struct{}), make(chan struct{}), make(chan bool, 1)
	go func() {
		topology.account.Lock()
		close(held)
		<-tryChat
		acquired := topology.chat.TryLock()
		if acquired {
			topology.chat.Unlock()
		}
		topology.account.Unlock()
		result <- acquired
	}()
	<-held
	outcome := make(chan inference.Outcome, 1)
	go func() { outcome <- actual.Infer(context.Background(), f.prepared) }()
	first := <-topology.attempts
	if first == "chat" { // Make the inverted runtime's account wait observable.
		if next := <-topology.attempts; next != "account" {
			t.Errorf("unexpected second guard %q", next)
		}
	}
	close(tryChat)
	legacyAcquired := <-result
	got := <-outcome
	if first != "account" || !legacyAcquired || got.State != inference.Completed || f.writer.calls != 1 {
		t.Fatalf("existing account->Chat peer saw inversion: first=%s peerChat=%t outcome=%+v", first, legacyAcquired, got)
	}
}

func TestRuntimePrepareRejectsForeignOriginalSessionAndMalformedBinding(t *testing.T) {
	for _, kind := range []string{"foreign session", "invalid operation", "zero deadline", "unrepresentable deadline", "different context hash"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			c := f.capture
			switch kind {
			case "foreign session":
				c.Binding.SessionID = "foreign-session"
			case "invalid operation":
				c.Binding.OperationID = "invalid operation"
			case "zero deadline":
				c.Binding.DeadlineMillis = 0
			case "unrepresentable deadline":
				c.Binding.DeadlineMillis = ^uint64(0)
			case "different context hash":
				c.Binding.Context = f.prepared.Reference().Binding.Context
				c.Binding.Context.InputHash = strings.Repeat("b", 64)
			}
			if _, err := runtime.Prepare(context.Background(), c, intent.SHA256{}); !errors.Is(err, inference.Invalid) {
				t.Fatalf("invalid original binding accepted: %v", err)
			}
			if f.ledger.calls != 0 || f.credentials.calls != 0 || f.writer.calls != 0 {
				t.Fatal("invalid binding entered effects")
			}
		})
	}
}

func TestRuntimePreservesOriginalInstructionWithoutInventingTurn(t *testing.T) {
	f := newFixture(t)
	events := append([]cb.Event{{ID: "instruction", Sequence: 1, Kind: cb.Instruction, Text: "original system instruction"}}, f.source.value.Events...)
	for i := 1; i < len(events); i++ {
		events[i].Sequence++
	}
	f.source.value.Events = events
	service, err := cp.New(cp.Dependencies{Gate: gate.New(), Source: f.source, Digests: intent.SHA256{}, Estimator: estimator{}})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := service.Prepare(context.Background(), f.source.value.Binding, "instruction-checkpoint", "instruction-operation", f.policy)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := service.MaterializePlan(context.Background(), prepared, f.source.value.Binding)
	if err != nil {
		t.Fatal(err)
	}
	view, err := projection.View(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c := f.capture
	c.Plan = projection
	s := c.Estimate.Snapshot()
	s.Estimate.InputTokens.Value = view.Receipt.EstimatedTokens
	c.Estimate, err = ms.CaptureEstimate(c.Resolved, view.Receipt.InputHash, s.Observation, s.Estimate)
	if err != nil {
		t.Fatal(err)
	}
	selected, err := runtime.Prepare(context.Background(), c, intent.SHA256{})
	if err != nil {
		t.Fatal("valid original instruction rejected", err)
	}
	if selected.Reference().Window.Events[0].Turn != (cb.Turn{}) || view.Items[0].Role != "developer" {
		t.Fatal("instruction invented original turn or lost developer mapping")
	}
	got := f.runtime.Infer(context.Background(), selected)
	if got.State != inference.Completed || !bytes.Equal(f.writer.body, view.ProviderJSON) {
		t.Fatalf("original instruction lost: %+v", got)
	}
}

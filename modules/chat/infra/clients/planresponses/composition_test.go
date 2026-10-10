package planresponses_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	chatport "github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/accountapproval"
	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/clients/planresponses"
	"github.com/legrch/farol/modules/chat/infra/gate"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// Actual app + production builder/parser + actual private account Grant. HTTP,
// selected account, credential storage, journal and publication are controlled.
// This is neither a provider/live billing nor a shipping boot qualification.
type compositionClock struct{ now uint64 }

func (c *compositionClock) NowMillis() uint64 { return c.now }

type selectedAccount struct {
	sync.Mutex
	selection   inference.Selection
	observation chatport.AccountObservation
}

func (s *selectedAccount) WithSelected(ctx context.Context, want inference.Selection, f func(chatport.AccountObservation) error) error {
	s.Lock()
	defer s.Unlock()
	if ctx.Err() != nil || s.selection != want {
		return inference.Withdrawn
	}
	return f(s.observation)
}
func (s *selectedAccount) change() {
	s.Lock()
	defer s.Unlock()
	s.selection.Account.Epoch++
	s.selection.Model.CatalogueEpoch++
}

type compositionCredentials struct {
	value inference.Credential
	after func()
}

func (c *compositionCredentials) Acquire(context.Context, inference.Selection) (inference.Credential, error) {
	if c.after != nil {
		c.after()
	}
	return c.value, nil
}

type compositionLedger struct {
	sync.Mutex
	used    map[string]bool
	settles int
	after   func()
	last    inference.Outcome
}

func (l *compositionLedger) Reserve(ctx context.Context, b inference.Binding, digest string) (bool, error) {
	l.Lock()
	defer l.Unlock()
	if l.used[b.OperationID] {
		return false, nil
	}
	l.used[b.OperationID] = true
	return true, nil
}
func (l *compositionLedger) Settle(ctx context.Context, b inference.Binding, o inference.Outcome) error {
	l.settles++
	l.last = o
	if l.after != nil {
		l.after()
	}
	return nil
}

type compositionPublication struct {
	count int
	text  string
	after func()
}

func (p *compositionPublication) Publish(b inference.Binding, o inference.Outcome) error {
	p.count++
	p.text = o.Text
	if p.after != nil {
		p.after()
	}
	return nil
}

type controlledHTTP struct {
	calls, closes int
	before        func()
	body          string
	status        int
	seen          map[string]json.RawMessage
	t             *testing.T
}

func (h *controlledHTTP) RoundTrip(r *http.Request) (*http.Response, error) {
	h.calls++
	h.t.Helper()
	if r.URL.String() != "https://api.openai.com/v1/responses" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer synthetic-composition-credential" {
		h.t.Fatal("wrong selected public request")
	}
	if err := json.NewDecoder(r.Body).Decode(&h.seen); err != nil {
		h.t.Fatal(err)
	}
	if h.before != nil {
		h.before()
	}
	return &http.Response{StatusCode: h.status, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: &byteBody{value: []byte(h.body), closed: func() { h.closes++ }}}, nil
}

type byteBody struct {
	value  []byte
	closed func()
}

func (b *byteBody) Read(p []byte) (int, error) {
	if len(b.value) == 0 {
		return 0, io.EOF
	}
	p[0] = b.value[0]
	b.value = b.value[1:]
	return 1, nil
}
func (b *byteBody) Close() error { b.closed(); return nil }

type composed struct {
	service     *inference.Service
	binding     inference.Binding
	input       []inference.InputItem
	owner       *accountapproval.Service
	selected    *selectedAccount
	credentials *compositionCredentials
	ledger      *compositionLedger
	publication *compositionPublication
	http        *controlledHTTP
	clock       *compositionClock
	authority   *planresponses.ConsentFence
}

const summaryStream = ": leading keepalive\r\n\r\n" +
	"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_composition\",\"status\":\"in_progress\"}}\n\n" +
	"data: {\"type\":\"response.output_text.delta\",\"response_id\":\"resp_composition\",\"delta\":\"Synthetic summary: café 🌊.\"}\n\n" +
	"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_composition\",\"status\":\"completed\"}}\n\n"

func newComposed(t *testing.T) *composed {
	t.Helper()
	f := &composed{ledger: &compositionLedger{used: make(map[string]bool)}, publication: &compositionPublication{}}
	now := uint64(time.Now().UnixMilli())
	c := &compositionClock{now: now}
	f.clock = c
	scope := chatport.AccountScope{ProfileID: "controlled-profile", BackendGeneration: "controlled-backend", OwnerID: "controlled-owner", SessionID: "controlled-session"}
	observation := chatport.AccountObservation{State: "observed", Source: "provider-session-v1", PrincipalKey: strings.Repeat("a", 64), ObservedAtMillis: now, ExpiresAtMillis: now + 60000}
	var err error
	f.owner, err = accountapproval.New(scope, gate.New(), c)
	if err != nil {
		t.Fatal(err)
	}
	grant, err := f.owner.Approve(context.Background(), "controlled-consent", 0, observation)
	if err != nil {
		t.Fatal(err)
	}
	selection := inference.Selection{Backend: inference.PlanBackend, Account: inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "controlled-subject", ClientID: "controlled-issued-client", HostID: "urn:uuid:11111111-1111-4111-8111-111111111111", Epoch: 1}, ConsentID: "controlled-consent", ConsentRevision: 1, Model: inference.ModelSelection{Slug: "controlled-model", Effort: "high", CapabilityEvidence: "controlled-account-catalogue", CatalogueEpoch: 1}}
	f.selected = &selectedAccount{selection: selection, observation: observation}
	authority, err := planresponses.NewConsentFence(grant, scope, selection, f.selected)
	if err != nil {
		t.Fatal(err)
	}
	f.authority = authority
	f.input = []inference.InputItem{{Kind: "message", Role: "developer", Content: "Summarize the explicitly selected text in one sentence."}, {Kind: "message", Role: "user", Content: "Synthetic selected text: The café uses reusable cups near the sea."}}
	hash, err := inference.InputHash(intent.SHA256{}, f.input)
	if err != nil {
		t.Fatal(err)
	}
	f.binding = inference.Binding{OperationID: "controlled-operation", ProfileID: scope.ProfileID, BackendGeneration: scope.BackendGeneration, OwnerID: scope.OwnerID, SessionID: scope.SessionID, Selection: selection, Context: inference.ContextSelection{CheckpointID: "controlled-context", InputHash: hash, EstimatedTokens: 40, TokenLimit: 1000}, DeadlineMillis: now + 30000}
	f.credentials = &compositionCredentials{value: inference.Credential{Account: selection.Account, AccessToken: "synthetic-composition-credential", RequestedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, GrantedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, ExpiresAtMillis: now + 60000, Generation: 1}}
	f.http = &controlledHTTP{body: summaryStream, status: 200, t: t}
	f.service, err = inference.New(inference.Options{Clock: c, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Credentials: f.credentials, Authority: authority, Ledger: f.ledger, Publication: f.publication, Transport: planresponses.New(&http.Client{Transport: f.http})})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestProductionCompositionControlledSelectedTextSummary(t *testing.T) {
	f := newComposed(t)
	got := f.service.Infer(context.Background(), f.binding, f.input)
	if got.State != inference.Completed || got.Text != "Synthetic summary: café 🌊." || f.http.calls != 1 || f.http.closes != 1 || f.publication.count != 1 || f.ledger.settles != 1 || f.ledger.last.Text != "" {
		t.Fatalf("composition did not complete: %+v", got)
	}
	if string(f.http.seen["store"]) != "false" || string(f.http.seen["stream"]) != "true" || string(f.http.seen["model"]) != `"controlled-model"` {
		t.Fatal("preview request shape changed")
	}
	for _, unsupported := range []string{"tools", "previous_response_id", "conversation", "background", "max_output_tokens", "temperature", "multi_agent", "metadata", "deadlineMillis"} {
		if _, exists := f.http.seen[unsupported]; exists {
			t.Fatal("unsupported field sent: " + unsupported)
		}
	}
	var items []map[string]any
	if json.Unmarshal(f.http.seen["input"], &items) != nil || len(items) != 2 || items[0]["role"] != "developer" || items[1]["content"] != f.input[1].Content {
		t.Fatal("explicit ordered history lost")
	}
	_ = f.service.Infer(context.Background(), f.binding, f.input)
	if f.http.calls != 1 || f.publication.count != 1 {
		t.Fatal("original operation retried")
	}
}

func TestProductionCompositionStreamFailuresNeverPublishOrRetry(t *testing.T) {
	for _, kind := range []string{"missing terminal", "wrong id", "error after partial", "invalid JSON", "failed status", "empty valid text"} {
		t.Run(kind, func(t *testing.T) {
			f := newComposed(t)
			switch kind {
			case "missing terminal":
				f.http.body = summaryStream[:strings.Index(summaryStream, "data: {\"type\":\"response.completed")]
			case "wrong id":
				f.http.body = strings.Replace(summaryStream, `"response_id":"resp_composition"`, `"response_id":"resp_foreign"`, 1)
			case "error after partial":
				f.http.body = strings.Replace(summaryStream, `"type":"response.completed","response":{"id":"resp_composition","status":"completed"}`, `"type":"error","code":"synthetic-private-message"`, 1)
			case "invalid JSON":
				f.http.body = "data: {invalid}\n\n"
			case "failed status":
				f.http.body = strings.Replace(summaryStream, `"type":"response.completed","response":{"id":"resp_composition","status":"completed"}`, `"type":"response.failed","response":{"id":"resp_composition","status":"failed"}`, 1)
			case "empty valid text":
				f.http.body = strings.Replace(summaryStream, `Synthetic summary: café 🌊.`, "", 1)
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if kind == "empty valid text" {
				if got.State != inference.Completed || got.Text != "" || f.publication.count != 1 {
					t.Fatal("valid empty completed text rejected")
				}
			} else if got.State == inference.Completed || got.Text != "" || f.publication.count != 0 {
				t.Fatalf("failure became answer: %+v", got)
			}
			_ = f.service.Infer(context.Background(), f.binding, f.input)
			if f.http.calls != 1 || f.http.closes != 1 {
				t.Fatal("uncertain stream replayed or retained body")
			}
		})
	}
}

func TestProductionCompositionSelectionAndPrivateGrantWithdrawal(t *testing.T) {
	for _, stage := range []string{"account before", "account after credentials", "account during HTTP", "revoke during HTTP", "account during journal", "consumer close"} {
		t.Run(stage, func(t *testing.T) {
			f := newComposed(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch stage {
			case "account before":
				f.selected.change()
			case "account after credentials":
				f.credentials.after = f.selected.change
			case "account during HTTP":
				f.http.before = f.selected.change
			case "revoke during HTTP":
				f.http.before = func() {
					if _, err := f.owner.Revoke(context.Background(), 1); err != nil {
						t.Fatal(err)
					}
				}
			case "account during journal":
				f.ledger.after = f.selected.change
			case "consumer close":
				f.http.before = cancel
			}
			got := f.service.Infer(ctx, f.binding, f.input)
			if got.Text != "" || f.publication.count != 0 {
				t.Fatal("output under changed account/consent/delivery")
			}
			if strings.Contains(stage, "before") || strings.Contains(stage, "credentials") {
				if got.State != inference.NotSent || f.http.calls != 0 {
					t.Fatal("known pre-send refusal lost")
				}
			} else if f.http.calls != 1 {
				t.Fatal("missing original request")
			}
		})
	}
}

// Controlled secret-owner ports preserve full CAS semantics. They use only
// synthetic credentials and inspect the actual operation context deadline.
type compositionStore struct {
	sync.Mutex
	record inference.CredentialRecord
	writes int
	wait   bool
	t      *testing.T
}

func (s *compositionStore) Read(ctx context.Context) (*inference.CredentialRecord, error) {
	if _, ok := ctx.Deadline(); !ok {
		s.t.Fatal("secret IO context is unbounded")
	}
	if s.wait {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	s.Lock()
	defer s.Unlock()
	r := s.record
	r.RequestedScopes = append([]string(nil), r.RequestedScopes...)
	r.GrantedScopes = append([]string(nil), r.GrantedScopes...)
	return &r, nil
}
func (s *compositionStore) CompareAndSwap(ctx context.Context, revision uint64, next inference.CredentialRecord) (*inference.CredentialRecord, error) {
	s.Lock()
	defer s.Unlock()
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	if revision != s.record.Revision {
		return nil, inference.Conflict
	}
	s.writes++
	s.record = next
	r := next
	r.RequestedScopes = append([]string(nil), next.RequestedScopes...)
	r.GrantedScopes = append([]string(nil), next.GrantedScopes...)
	return &r, nil
}

type compositionRefresh struct {
	t       *testing.T
	account inference.AccountIdentity
	now     uint64
	calls   int
	after   func()
	err     error
}

func (p *compositionRefresh) Refresh(ctx context.Context, r inference.RefreshRequest) (*inference.RefreshResult, error) {
	p.calls++
	if _, ok := ctx.Deadline(); !ok {
		p.t.Fatal("refresh IO context is unbounded")
	}
	if r.Account != p.account || r.RefreshToken != "synthetic-refresh-old" || r.Generation != 1 {
		p.t.Fatal("refresh crossed original credential")
	}
	if p.after != nil {
		p.after()
	}
	if p.err != nil {
		return nil, p.err
	}
	return &inference.RefreshResult{Account: p.account, AccessToken: "synthetic-composition-credential", RefreshToken: "synthetic-refresh-new", GrantedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, ExpiresAtMillis: p.now + 60000, EarliestRefreshAtMillis: p.now + 45000}, nil
}

type compositionCredentialPolicy struct {
	binding   inference.Binding
	authority inference.Authority
}

func (p compositionCredentialPolicy) Current(ctx context.Context, s inference.Selection) error {
	if s != p.binding.Selection {
		return inference.Withdrawn
	}
	return p.authority.WithCurrent(ctx, p.binding, func() error { return nil })
}

func composedCredentialManager(t *testing.T, f *composed) (*inference.CredentialManager, *compositionStore, *compositionRefresh) {
	t.Helper()
	s := f.binding.Selection
	store := &compositionStore{t: t, record: inference.CredentialRecord{Revision: 1, Account: s.Account, ConsentID: s.ConsentID, ConsentRevision: s.ConsentRevision, ValidatedConsent: true, State: inference.CredentialReady, AccessToken: "synthetic-access-expired", RefreshToken: "synthetic-refresh-old", RequestedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, GrantedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, ExpiresAtMillis: f.clock.now - 1, Generation: 1}}
	provider := &compositionRefresh{t: t, account: s.Account, now: f.clock.now}
	manager, err := inference.NewCredentialManager(gate.New(), f.clock, store, provider, compositionCredentialPolicy{binding: f.binding, authority: f.authority})
	if err != nil {
		t.Fatal(err)
	}
	f.service, err = inference.New(inference.Options{Clock: f.clock, Deadline: planresponses.OperationDeadline{}, Digester: intent.SHA256{}, Credentials: manager, Authority: f.authority, Ledger: f.ledger, Publication: f.publication, Transport: planresponses.New(&http.Client{Transport: f.http})})
	if err != nil {
		t.Fatal(err)
	}
	return manager, store, provider
}

func TestProductionCompositionRealCredentialRotationAndLostReply(t *testing.T) {
	for _, stage := range []string{"known rotation", "lost rotation reply", "account changes during refresh"} {
		t.Run(stage, func(t *testing.T) {
			f := newComposed(t)
			_, store, provider := composedCredentialManager(t, f)
			switch stage {
			case "lost rotation reply":
				provider.err = errors.New("synthetic private provider detail")
			case "account changes during refresh":
				provider.after = f.selected.change
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if provider.calls != 1 {
				t.Fatal("rotation not one-shot")
			}
			if stage == "known rotation" {
				if got.State != inference.Completed || f.http.calls != 1 || f.publication.count != 1 || store.writes != 2 || store.record.Generation != 2 || store.record.RefreshToken != "synthetic-refresh-new" || !store.record.RefreshProduced {
					t.Fatalf("real manager composition: %+v", got)
				}
			} else if got.State != inference.NotSent || got.Text != "" || f.http.calls != 0 || f.publication.count != 0 {
				t.Fatalf("uncertain/withdrawn refresh authorized inference: %+v", got)
			}
			if stage == "lost rotation reply" && got.Code != inference.CredentialRefreshUnknown {
				t.Fatal("refresh uncertainty collapsed")
			}
			_ = f.service.Infer(context.Background(), f.binding, f.input)
			if provider.calls != 1 || f.http.calls > 1 || f.publication.count > 1 {
				t.Fatal("consumed operation replayed")
			}
		})
	}
}

func TestProductionCompositionDeadlineBoundsSecretOwnerIO(t *testing.T) {
	f := newComposed(t)
	f.binding.DeadlineMillis = uint64(time.Now().Add(30 * time.Millisecond).UnixMilli())
	_, store, provider := composedCredentialManager(t, f)
	store.wait = true
	got := f.service.Infer(context.Background(), f.binding, f.input)
	if got.State != inference.NotSent || provider.calls != 0 || f.http.calls != 0 || f.publication.count != 0 {
		t.Fatal("expired secret read authorized IO")
	}
}

func TestProductionCompositionPublicationClosesOrExpiresOperation(t *testing.T) {
	for _, stage := range []string{"caller closes", "deadline expires"} {
		t.Run(stage, func(t *testing.T) {
			f := newComposed(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if stage == "caller closes" {
				f.publication.after = cancel
			} else {
				f.publication.after = func() { f.clock.now = f.binding.DeadlineMillis }
			}
			got := f.service.Infer(ctx, f.binding, f.input)
			if got.State != inference.Unknown || got.RemoteState != inference.Completed || got.Code != inference.PublicationUnknown || got.Text != "" || f.publication.count != 1 || f.http.calls != 1 {
				t.Fatalf("publication lifetime uncertainty lost: %+v", got)
			}
			_ = f.service.Infer(ctx, f.binding, f.input)
			if f.publication.count != 1 || f.http.calls != 1 {
				t.Fatal("late publication replayed")
			}
		})
	}
}

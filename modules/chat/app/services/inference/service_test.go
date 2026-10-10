package inference_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/intent"
)

// These tests exercise app sequencing with synthetic ports, not provider effects.
type clock struct {
	now     uint64
	samples []uint64
}

func (c *clock) NowMillis() uint64 {
	if len(c.samples) > 0 {
		now := c.samples[0]
		c.samples = c.samples[1:]
		return now
	}
	return c.now
}

type controlledDeadline struct{}

func (controlledDeadline) Limit(ctx context.Context, _ uint64) (context.Context, context.CancelFunc, error) {
	bounded, cancel := context.WithCancel(ctx)
	return bounded, cancel, nil
}

type authority struct {
	current bool
	after   func() error
}

func (a *authority) WithCurrent(ctx context.Context, b inference.Binding, f func() error) error {
	if !a.current || ctx.Err() != nil {
		return inference.Withdrawn
	}
	err := f()
	if a.after != nil {
		if afterErr := a.after(); afterErr != nil {
			return afterErr
		}
	}
	return err
}

type credentials struct {
	value inference.Credential
	after func()
	err   error
	calls int
}

func (c *credentials) Acquire(context.Context, inference.Selection) (inference.Credential, error) {
	c.calls++
	if c.after != nil {
		c.after()
	}
	return c.value, c.err
}

type transport struct {
	outcome inference.Outcome
	after   func()
	calls   int
	request inference.Request
}

func (t *transport) Infer(ctx context.Context, c inference.Credential, r inference.Request) inference.Outcome {
	t.calls++
	t.request = r
	if t.after != nil {
		t.after()
	}
	return t.outcome
}

type ledger struct {
	used                      map[string]bool
	reservations, settlements int
	reserveError, settleError error
	afterReserve, afterSettle func()
	stored                    inference.Outcome
}

func (l *ledger) Reserve(ctx context.Context, b inference.Binding, digest string) (bool, error) {
	l.reservations++
	if l.reserveError != nil {
		return false, l.reserveError
	}
	if l.used[b.OperationID] {
		return false, nil
	}
	l.used[b.OperationID] = true
	if l.afterReserve != nil {
		l.afterReserve()
	}
	return true, nil
}
func (l *ledger) Settle(ctx context.Context, b inference.Binding, o inference.Outcome) error {
	l.settlements++
	l.stored = o
	if l.afterSettle != nil {
		l.afterSettle()
	}
	return l.settleError
}

type publication struct {
	calls int
	text  string
	err   error
}

func (p *publication) Publish(b inference.Binding, o inference.Outcome) error {
	p.calls++
	p.text = o.Text
	return p.err
}

type fixture struct {
	service     *inference.Service
	binding     inference.Binding
	input       []inference.InputItem
	c           *clock
	a           *authority
	credentials *credentials
	transport   *transport
	ledger      *ledger
	publication *publication
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{c: &clock{now: 1}, a: &authority{current: true}, ledger: &ledger{used: make(map[string]bool)}, publication: &publication{}}
	f.input = []inference.InputItem{{Kind: "message", Role: "developer", Content: "Summarize selected text."}, {Kind: "message", Role: "user", Content: "A controlled document."}}
	hash, err := inference.InputHash(intent.SHA256{}, f.input)
	if err != nil {
		t.Fatal(err)
	}
	f.binding = inference.Binding{OperationID: "operation", ProfileID: "profile", BackendGeneration: "backend", OwnerID: "owner", SessionID: "session", DeadlineMillis: 100, Context: inference.ContextSelection{CheckpointID: "checkpoint", InputHash: hash, EstimatedTokens: 10, TokenLimit: 100}, Selection: inference.Selection{Backend: inference.PlanBackend, Account: inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "subject", ClientID: "issued-client", HostID: "urn:uuid:11111111-1111-4111-8111-111111111111", Epoch: 1}, ConsentID: "consent", ConsentRevision: 1, Model: inference.ModelSelection{Slug: "controlled-model", Effort: "high", CapabilityEvidence: "controlled-capability", CatalogueEpoch: 1}}}
	f.credentials = &credentials{value: inference.Credential{Account: f.binding.Selection.Account, AccessToken: "synthetic-credential", Generation: 1, ExpiresAtMillis: 200, RequestedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}, GrantedScopes: []string{"resource.invoke", "chatgpt.tokens.use.direct"}}}
	f.transport = &transport{outcome: inference.Outcome{State: inference.Completed, ResponseID: "resp_controlled", Text: "Controlled summary."}}
	f.service, err = inference.New(inference.Options{Clock: f.c, Deadline: controlledDeadline{}, Digester: intent.SHA256{}, Credentials: f.credentials, Transport: f.transport, Authority: f.a, Ledger: f.ledger, Publication: f.publication})
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func TestSelectedSummaryPublishesOnlyFinalOnceAndJournalContainsNoText(t *testing.T) {
	f := newFixture(t)
	got := f.service.Infer(context.Background(), f.binding, f.input)
	if got.State != inference.Completed || got.Text != "Controlled summary." || f.publication.calls != 1 || f.transport.calls != 1 || f.ledger.stored.Text != "" || f.transport.request.Model != f.binding.Selection.Model || f.transport.request.DeadlineMillis != f.binding.DeadlineMillis {
		t.Fatalf("unexpected completion: %+v", got)
	}
	if again := f.service.Infer(context.Background(), f.binding, f.input); again.Code != inference.AlreadyReserved || f.transport.calls != 1 || f.publication.calls != 1 {
		t.Fatal("consumed operation redispatched")
	}
}

func TestWithdrawalAroundEachIOPreventsSendOrDisclosure(t *testing.T) {
	for _, stage := range []string{"before", "reserve", "credentials", "transport", "settle"} {
		t.Run(stage, func(t *testing.T) {
			f := newFixture(t)
			withdraw := func() { f.a.current = false }
			switch stage {
			case "before":
				withdraw()
			case "reserve":
				f.ledger.afterReserve = withdraw
			case "credentials":
				f.credentials.after = withdraw
			case "transport":
				f.transport.after = withdraw
			case "settle":
				f.ledger.afterSettle = withdraw
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if got.Text != "" || f.publication.calls != 0 {
				t.Fatal("withdrawn output published")
			}
			if stage == "transport" || stage == "settle" {
				if got.State != inference.Suppressed || got.RemoteState != inference.Completed || f.transport.calls != 1 {
					t.Fatalf("original completion lost: %+v", got)
				}
			} else if f.transport.calls != 0 {
				t.Fatal("request after withdrawn consent")
			}
		})
	}
}

func TestRefusalBeforeWriteAndConsumerCloseAfterIORemainDistinct(t *testing.T) {
	t.Run("deadline", func(t *testing.T) {
		f := newFixture(t)
		f.c.now = 100
		got := f.service.Infer(context.Background(), f.binding, f.input)
		if got.State != inference.NotSent || f.transport.calls != 0 || f.ledger.reservations != 0 {
			t.Fatal("expired dispatch")
		}
	})
	t.Run("consumer closes", func(t *testing.T) {
		f := newFixture(t)
		ctx, cancel := context.WithCancel(context.Background())
		f.transport.after = cancel
		got := f.service.Infer(ctx, f.binding, f.input)
		if got.State != inference.Suppressed || got.RemoteState != inference.Completed || f.publication.calls != 0 || f.transport.calls != 1 {
			t.Fatal("local disconnect changed remote outcome")
		}
	})
	t.Run("expired during IO", func(t *testing.T) {
		f := newFixture(t)
		f.transport.after = func() { f.c.now = 100 }
		got := f.service.Infer(context.Background(), f.binding, f.input)
		if got.State != inference.Suppressed || f.publication.calls != 0 {
			t.Fatal("late text disclosed")
		}
	})
}

func TestCredentialAndContextMismatchRefuseWithoutFallback(t *testing.T) {
	for _, kind := range []string{"account", "scope", "expiry", "context", "budget", "backend"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			switch kind {
			case "account":
				f.credentials.value.Account.Epoch++
			case "scope":
				f.credentials.value.GrantedScopes = []string{"resource.invoke"}
			case "expiry":
				f.credentials.value.ExpiresAtMillis = 1
			case "context":
				f.input[1].Content = "changed"
			case "budget":
				f.binding.Context.EstimatedTokens = 101
			case "backend":
				f.binding.Selection.Backend = "api-key"
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if got.State != inference.NotSent || got.Text != "" || f.transport.calls != 0 || f.publication.calls != 0 {
				t.Fatal("invalid selection dispatched")
			}
		})
	}
}

func TestFailedAndUncertainIOCannotPublishPartialOrReplay(t *testing.T) {
	for _, kind := range []string{"reserve", "settle", "provider", "malformed", "private diagnostic"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			switch kind {
			case "reserve":
				f.ledger.reserveError = errors.New("synthetic private detail")
			case "settle":
				f.ledger.settleError = errors.New("synthetic private detail")
			case "provider":
				f.transport.outcome = inference.Outcome{State: inference.Failed, Code: "INFERENCE_MODEL_DENIED"}
			case "malformed":
				f.transport.outcome = inference.Outcome{State: inference.Failed, Text: "partial"}
			case "private diagnostic":
				f.transport.outcome = inference.Outcome{State: inference.Unknown, Code: "synthetic private detail"}
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if got.Text != "" || f.publication.calls != 0 || strings.Contains(string(got.Code), "private") {
				t.Fatal("failed output leaked")
			}
			if f.ledger.stored.Text != "" {
				t.Fatal("journal retained text")
			}
			if kind != "reserve" {
				_ = f.service.Infer(context.Background(), f.binding, f.input)
				if f.transport.calls != 1 {
					t.Fatal("uncertain operation replayed")
				}
			}
		})
	}
}

func TestOrderedFunctionHistoryCannotLoseOrInventResults(t *testing.T) {
	f := newFixture(t)
	valid := []inference.InputItem{{Kind: "message", Role: "user", Content: "previous"}, {Kind: "function_call", CallID: "call-a", Name: "read_selected", Arguments: `{"path":"synthetic"}`}, {Kind: "function_call_output", CallID: "call-a", Content: "result"}, {Kind: "message", Role: "user", Content: "summarize"}}
	r := inference.Request{Model: f.binding.Selection.Model, Input: valid}
	if inference.ValidateRequest(r) != nil {
		t.Fatal("complete history rejected")
	}
	for _, items := range [][]inference.InputItem{valid[:2], {valid[2]}, append(append([]inference.InputItem(nil), valid...), valid[2]), {{Kind: "message", Role: "system", Content: "unsupported"}}, {{Kind: "message", Role: "user", Content: string([]byte{0xff})}}} {
		r.Input = items
		if inference.ValidateRequest(r) == nil {
			t.Fatal("invalid history admitted")
		}
	}
	a, _ := inference.InputHash(intent.SHA256{}, valid)
	b, _ := inference.InputHash(intent.SHA256{}, []inference.InputItem{valid[3], valid[0], valid[1], valid[2]})
	if a == b {
		t.Fatal("history order absent from hash")
	}
}

func TestPublicationUncertaintyNeverClaimsSuppressionOrReplays(t *testing.T) {
	for _, stage := range []string{"publication error", "post-publication authority error"} {
		t.Run(stage, func(t *testing.T) {
			f := newFixture(t)
			if stage == "publication error" {
				f.publication.err = errors.New("synthetic private detail")
			} else {
				f.a.after = func() error {
					if f.publication.calls > 0 {
						return inference.Withdrawn
					}
					return nil
				}
			}
			got := f.service.Infer(context.Background(), f.binding, f.input)
			if got.State != inference.Unknown || got.RemoteState != inference.Completed || got.Code != inference.PublicationUnknown || got.Text != "" || f.publication.calls != 1 {
				t.Fatalf("publication uncertainty misclassified: %+v", got)
			}
			_ = f.service.Infer(context.Background(), f.binding, f.input)
			if f.transport.calls != 1 || f.publication.calls != 1 {
				t.Fatal("uncertain publication replayed")
			}
		})
	}
}

func TestCredentialRefreshUncertaintyIsPreservedWithoutPrivateDetail(t *testing.T) {
	f := newFixture(t)
	f.credentials.err = inference.CredentialRefreshUnknown
	got := f.service.Infer(context.Background(), f.binding, f.input)
	if got.State != inference.NotSent || got.Code != inference.CredentialRefreshUnknown || f.transport.calls != 0 {
		t.Fatalf("refresh uncertainty lost: %+v", got)
	}
}

func TestZeroAndRollbackClockAfterCredentialsRefuseDispatch(t *testing.T) {
	for _, now := range []uint64{0, 19} {
		f := newFixture(t)
		f.c.now = 20
		f.credentials.after = func() { f.c.now = now }
		got := f.service.Infer(context.Background(), f.binding, f.input)
		if got.State != inference.NotSent || f.transport.calls != 0 || f.publication.calls != 0 {
			t.Fatal("invalid clock authorized IO")
		}
	}
}

func TestCredentialExpirySampleParticipatesInClockFence(t *testing.T) {
	f := newFixture(t)
	f.c.samples = []uint64{10, 10, 20, 19}
	got := f.service.Infer(context.Background(), f.binding, f.input)
	if got.State != inference.NotSent || f.transport.calls != 0 || f.publication.calls != 0 {
		t.Fatal("rollback from credential expiry sample authorized dispatch")
	}
}

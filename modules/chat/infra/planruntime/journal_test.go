package planruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	cp "github.com/legrch/farol/modules/chat/app/services/contextcheckpoint"
	"github.com/legrch/farol/modules/chat/app/services/inference"
	cb "github.com/legrch/farol/modules/chat/domain/contextbudget"
	ms "github.com/legrch/farol/modules/chat/domain/modelselection"
	"github.com/legrch/farol/modules/chat/infra/planledger"
	"github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
)

// Private mapping fixtures, NOT original transcript/native image/publication
// authority. Exported construction remains concrete lifecycle.Repository only;
// actual CAS/poison/restart/storage/native proofs are tested by that owner.
type journalCaptureFixture struct {
	calls int
	head  lifecycle.PlanHead
	err   error
}

func (c *journalCaptureFixture) capture(context.Context) (lifecycle.PlanHead, error) {
	c.calls++
	return c.head, c.err
}

type journalProtocolFixture struct {
	capture                     planledger.Capture
	captures, reserves, settles int
	captured                    bool
	head                        lifecycle.PlanHead
	witness                     string
	binding                     inference.Binding
	intent                      string
	outcome                     inference.Outcome
	reserveErr, settleErr       error
	historical, forceFresh      bool
}

func (p *journalProtocolFixture) Reserve(ctx context.Context, b inference.Binding, intent string) (bool, error) {
	p.reserves++
	if !p.captured {
		p.captures++
		head, witness, err := p.capture(b, intent)
		if err != nil {
			return false, err
		}
		p.captured = true
		p.head = head
		p.witness = witness
		p.binding = b
		p.intent = intent
	}
	if p.forceFresh {
		return true, nil
	}
	if p.reserveErr != nil {
		return false, p.reserveErr
	}
	return p.reserves == 1 && !p.historical, nil
}
func (p *journalProtocolFixture) Settle(ctx context.Context, b inference.Binding, outcome inference.Outcome) error {
	p.settles++
	p.binding = b
	p.outcome = outcome
	return p.settleErr
}
func journalOriginal() *Prepared {
	binding := inference.Binding{OperationID: "original-operation", ProfileID: "profile", BackendGeneration: "generation", OwnerID: "owner", SessionID: "session", DeadlineMillis: 100, Selection: inference.Selection{Backend: inference.PlanBackend, Account: inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "subject", ClientID: "client", HostID: "urn:uuid:host", Epoch: 1}, ConsentID: "consent", ConsentRevision: 2, Model: inference.ModelSelection{Slug: "model", Effort: "high", CapabilityEvidence: "capability", CatalogueEpoch: 3}}, Context: inference.ContextSelection{CheckpointID: "checkpoint", InputHash: strings.Repeat("a", 64), EstimatedTokens: 1, TokenLimit: 10}}
	source := cb.SourceRef{Binding: cb.Binding{ProfileID: "profile", BackendGeneration: "generation", OwnerID: "owner", AccountID: "opaque-account", Provider: "openai", ModelID: "model", Effort: "high", CapabilityEpoch: "capability"}, Revision: 7, FirstSequence: 1, LastSequence: 4, FirstEventID: "first", LastEventID: "last", SHA256: strings.Repeat("b", 64)}
	turn := cb.Turn{SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", OperationID: "root-operation", TaskEpoch: 2, TurnGeneration: 3}
	window := cb.Window{Source: source, Events: []cb.Event{{ID: "event", Sequence: 1, Turn: turn, Kind: cb.User, Text: "original λ🙂"}}, Unresolved: []cb.UnknownReference{{Turn: turn, CallID: "original-call", ToolOperationID: "original-tool-operation", CallEventID: "call-event", ResultEventID: "result-event", Outcome: cb.Unknown}}, Usage: cb.Metrics{Bytes: 50, CodePoints: 40, EstimatedTokens: 1}, OmittedEvents: 3}
	receipt := cp.PlanReceipt{CheckpointID: "checkpoint", OperationID: "context-operation", Source: source, Policy: cb.Policy{Limit: cb.Metrics{Bytes: 100, CodePoints: 100, EstimatedTokens: 11}, Reserve: cb.Metrics{Bytes: 5, CodePoints: 6, EstimatedTokens: 1}}, InputHash: binding.Context.InputHash, ProviderHash: strings.Repeat("c", 64), IdentityHash: strings.Repeat("d", 64), Usage: cb.Metrics{Bytes: 50, CodePoints: 40, EstimatedTokens: 1}, InputUsage: cb.Metrics{Bytes: 40, CodePoints: 30, EstimatedTokens: 1}, EstimatedTokens: 1, TokenLimit: 10}
	model := ms.Pin{Route: ms.Route{Provider: "openai", Backend: ms.PlanInference, Billing: ms.Plan}, AccountID: "opaque-account", Epoch: 3, Revision: "catalogue-revision", Model: "model", Effort: "high", CapabilityRevision: "capability"}
	estimate := ms.EstimateSnapshot{Selection: model, InputDigest: binding.Context.InputHash, Observation: ms.EstimateObservation{Qualified: true, ObservedAtMillis: 1, ExpiresAtMillis: 100}, Estimate: ms.Estimate{Source: "estimator", Version: "v1", InputTokens: ms.Quantity{Known: true, Value: 1}}}
	return &Prepared{reference: Reference{Binding: binding, Receipt: receipt, Window: window, Model: model, Estimate: estimate, Budget: ms.Budget{MaxInputTokens: ms.Quantity{Known: true, Value: 10}}, EstimatorSource: "estimator", EstimatorVersion: "v1"}, input: []inference.InputItem{{Kind: "message", Role: "user", Content: "synthetic protocol fixture"}}, provider: []byte("synthetic private mapping bytes")}
}
func journalFixture(t *testing.T) (*JournalLedger, *Prepared, *journalCaptureFixture, *journalProtocolFixture) {
	t.Helper()
	original := journalOriginal()
	c := &journalCaptureFixture{head: lifecycle.PlanHead{Scope: port.JournalScope{ProfileID: "profile", BackendGeneration: "generation"}, Revision: 7, PublicationDigest: strings.Repeat("e", 64)}}
	p := &journalProtocolFixture{}
	l, err := newJournalLedger(context.Background(), original, c.capture, func(capture planledger.Capture) (inference.Ledger, error) { p.capture = capture; return p, nil })
	if err != nil {
		t.Fatal(err)
	}
	return l, original, c, p
}
func journalDigest(v any) string {
	raw, _ := json.Marshal(v)
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func TestJournalConstructorPinsOriginalConcreteOwnerContract(t *testing.T) {
	l, original, c, p := journalFixture(t)
	if c.calls != 1 || p.reserves != 0 || p.captures != 0 || p.settles != 0 {
		t.Fatal("constructor consumed operation or missed original capture")
	}
	if fresh, err := l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64)); err != nil || !fresh {
		t.Fatal(fresh, err)
	}
	if c.calls != 1 || p.captures != 1 || p.head != c.head || p.witness != journalDigest(original.Reference()) || p.binding != original.Reference().Binding || p.intent != strings.Repeat("f", 64) {
		t.Fatal("full witness or alreadyfull intent lost")
	}
	c.head.Revision++
	c.head.PublicationDigest = strings.Repeat("9", 64)
	if fresh, err := l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64)); err != nil || fresh || c.calls != 1 || p.captures != 1 || p.head.Revision != 7 {
		t.Fatal("consumed operation recaptured a fresh source", fresh, err)
	}
}

func TestJournalFullReferenceRejectsChangedOrOmittedSidecarsBeforeOwnerIO(t *testing.T) {
	changes := map[string]func(*Reference){
		"omitted unknown":      func(r *Reference) { r.Window.Unresolved = nil },
		"unknown identity":     func(r *Reference) { r.Window.Unresolved[0].ToolOperationID = "replacement" },
		"unknown outcome":      func(r *Reference) { r.Window.Unresolved[0].Outcome = cb.Completed },
		"source head":          func(r *Reference) { r.Receipt.Source.Revision++ },
		"source bytes":         func(r *Reference) { r.Receipt.Source.SHA256 = strings.Repeat("9", 64) },
		"original turn":        func(r *Reference) { r.Window.Events[0].Turn.OperationID = "replacement" },
		"original text":        func(r *Reference) { r.Window.Events[0].Text = "replacement" },
		"omitted count":        func(r *Reference) { r.Window.OmittedEvents++ },
		"byte reserve":         func(r *Reference) { r.Receipt.Policy.Reserve.Bytes++ },
		"codepoint reserve":    func(r *Reference) { r.Receipt.Policy.Reserve.CodePoints++ },
		"token reserve":        func(r *Reference) { r.Receipt.Policy.Reserve.EstimatedTokens++ },
		"estimate observation": func(r *Reference) { r.Estimate.Observation.ExpiresAtMillis++ },
		"estimate provenance":  func(r *Reference) { r.Estimate.Estimate.Version = "v2" },
		"unknown estimate":     func(r *Reference) { r.Estimate.Estimate.InputTokens.Known = false },
		"model revision":       func(r *Reference) { r.Model.Revision = "replacement" },
		"budget":               func(r *Reference) { r.Budget.MaxInputTokens.Value++ },
		"account":              func(r *Reference) { r.Binding.Selection.Account.Subject = "replacement" },
		"binding context":      func(r *Reference) { r.Binding.Context.CheckpointID = "replacement" },
		"policy label":         func(r *Reference) { r.EstimatorVersion = "v2" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			l, original, c, p := journalFixture(t)
			ref := original.Reference()
			change(&ref)
			if fresh, err := l.Reserve(context.Background(), ref, strings.Repeat("f", 64)); fresh || !errors.Is(err, inference.Conflict) || p.reserves != 0 || p.captures != 0 || c.calls != 1 {
				t.Fatal("foreign complete reference reached journal", fresh, err)
			}
			if err := l.Settle(context.Background(), ref, inference.Outcome{State: inference.Completed, ResponseID: "response"}); !errors.Is(err, inference.Conflict) || p.settles != 0 {
				t.Fatal("foreign settlement reached journal", err)
			}
		})
	}
}

func TestJournalRetainsOriginalIndependentCopyAndExactCanonicalWitness(t *testing.T) {
	l, original, _, p := journalFixture(t)
	wanted := original.Reference()
	original.reference.Window.Unresolved[0].Outcome = cb.Completed
	original.reference.Window.Events[0].Text = "replacement"
	if fresh, err := l.Reserve(context.Background(), wanted, strings.Repeat("f", 64)); err != nil || !fresh || p.witness != journalDigest(wanted) {
		t.Fatal("constructor retained mutable Prepared reference", fresh, err)
	}
	if fresh, err := l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64)); fresh || !errors.Is(err, inference.Conflict) {
		t.Fatal("edited Prepared retargeted original", fresh, err)
	}
}

func TestJournalLostReservationACKOrHistoricalOperationCannotMintSettlement(t *testing.T) {
	for _, historical := range []bool{false, true} {
		t.Run(map[bool]string{false: "lost ACK", true: "historical not fresh"}[historical], func(t *testing.T) {
			l, original, c, p := journalFixture(t)
			lost := &lifecycle.Failure{Code: lifecycle.Unknown, OutcomeUnknown: true}
			if historical {
				p.historical = true
			} else {
				p.reserveErr = lost
			}
			if fresh, err := l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64)); fresh || (!historical && !errors.Is(err, lifecycle.Unknown)) {
				t.Fatal(fresh, err)
			}
			c.head.Revision++
			c.err = inference.Withdrawn
			if fresh, _ := l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64)); fresh || c.calls != 1 || p.captures != 1 {
				t.Fatal("uncertain original reacquired source")
			}
			if err := l.Settle(context.Background(), original.Reference(), inference.Outcome{State: inference.Completed, ResponseID: "fabricated-response"}); !errors.Is(err, inference.Conflict) || p.settles != 0 {
				t.Fatal("absence of original knownfresh receipt fabricated facts", err)
			}
		})
	}
}

func TestJournalFreshOriginalSettlementSurvivesSourceWithdrawalAndDuplicate(t *testing.T) {
	l, original, c, p := journalFixture(t)
	intent := strings.Repeat("f", 64)
	if fresh, err := l.Reserve(context.Background(), original.Reference(), intent); err != nil || !fresh {
		t.Fatal(fresh, err)
	}
	if fresh, err := l.Reserve(context.Background(), original.Reference(), intent); err != nil || fresh {
		t.Fatal("duplicate unexpectedly fresh", fresh, err)
	}
	c.err = inference.Withdrawn
	c.head.Revision++
	outcome := inference.Outcome{State: inference.Completed, ResponseID: "original-response", HTTPStatus: 200}
	if err := l.Settle(context.Background(), original.Reference(), outcome); err != nil || p.settles != 1 || p.outcome != outcome || p.binding != original.Reference().Binding || c.calls != 1 || p.captures != 1 {
		t.Fatal("original completion changed after withdrawal", err)
	}
	p.settleErr = &lifecycle.Failure{Code: lifecycle.Unknown, OutcomeUnknown: true}
	if err := l.Settle(context.Background(), original.Reference(), outcome); !errors.Is(err, lifecycle.Unknown) || p.outcome != outcome || c.calls != 1 {
		t.Fatal("lost settlement ACK erased facts or reacquired source", err)
	}
}

func TestJournalSettlementRefusesRawTextSuppressionAndPreservesOtherFields(t *testing.T) {
	for _, field := range []string{"text", "remote state"} {
		t.Run(field, func(t *testing.T) {
			l, original, _, p := journalFixture(t)
			_, _ = l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64))
			o := inference.Outcome{State: inference.Completed, ResponseID: "response", HTTPStatus: 200}
			if field == "text" {
				o.Text = "private output"
			} else {
				o.RemoteState = inference.Completed
			}
			if err := l.Settle(context.Background(), original.Reference(), o); !errors.Is(err, inference.Invalid) || p.settles != 0 {
				t.Fatal("unqualified fields erased into journal evidence", err)
			}
		})
	}
	l, original, _, p := journalFixture(t)
	_, _ = l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64))
	p.settleErr = inference.Invalid
	raw := inference.Outcome{State: inference.Unknown, ResponseID: "response", Code: "unqualified-fixed-protocol-fixture", HTTPStatus: 999}
	if err := l.Settle(context.Background(), original.Reference(), raw); !errors.Is(err, inference.Invalid) || p.outcome != raw {
		t.Fatal("adapter silently sanitized original metadata", err)
	}
}

func TestJournalChangedIntentCannotReplaceConsumedOriginal(t *testing.T) {
	l, original, c, p := journalFixture(t)
	_, _ = l.Reserve(context.Background(), original.Reference(), strings.Repeat("f", 64))
	if fresh, err := l.Reserve(context.Background(), original.Reference(), strings.Repeat("9", 64)); fresh || !errors.Is(err, inference.Conflict) || p.reserves != 1 || c.calls != 1 {
		t.Fatal("changed intent entered original owner", fresh, err)
	}
	if fresh, err := l.Reserve(context.Background(), original.Reference(), "not-a-digest"); fresh || !errors.Is(err, inference.Invalid) || p.reserves != 1 {
		t.Fatal("unbounded intent entered owner", fresh, err)
	}
}

func TestJournalConcurrentCallsConsumeOneOriginalKnownFreshReceipt(t *testing.T) {
	l, original, c, p := journalFixture(t)
	ref := original.Reference()
	var wait sync.WaitGroup
	var resultsMu sync.Mutex
	freshCount := 0
	for range 16 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			fresh, err := l.Reserve(context.Background(), ref, strings.Repeat("f", 64))
			if err != nil {
				t.Error(err)
			}
			if fresh {
				resultsMu.Lock()
				freshCount++
				resultsMu.Unlock()
			}
		}()
	}
	wait.Wait()
	if freshCount != 1 || c.calls != 1 || p.captures != 1 || p.reserves != 16 {
		t.Fatal("concurrent source/knownfresh witness recreated", freshCount, c.calls, p.captures, p.reserves)
	}
	if err := l.Settle(context.Background(), ref, inference.Outcome{State: inference.Completed, ResponseID: "response"}); err != nil || p.settles != 1 {
		t.Fatal("duplicate erased original knownfresh receipt", err)
	}
}

func TestJournalImpossibleNewFreshDuplicateCannotDispatchAgain(t *testing.T) {
	l, original, _, p := journalFixture(t)
	ref := original.Reference()
	intent := strings.Repeat("f", 64)
	_, _ = l.Reserve(context.Background(), ref, intent)
	p.forceFresh = true
	if fresh, err := l.Reserve(context.Background(), ref, intent); fresh || !errors.Is(err, inference.PersistenceUnknown) {
		t.Fatal("unexpected fresh protocol reply authorized a second HTTP", fresh, err)
	}
}

func TestJournalZeroValueCannotEnterUnownedProtocol(t *testing.T) {
	l := &JournalLedger{}
	if fresh, err := l.Reserve(context.Background(), Reference{}, strings.Repeat("f", 64)); fresh || !errors.Is(err, inference.Invalid) {
		t.Fatal("zero-value adapter entered an absent owner", fresh, err)
	}
}

func TestJournalConstructorRejectsUnqualifiedMissingCrossScopeOrCancelledInputs(t *testing.T) {
	original := journalOriginal()
	for _, variant := range []string{"nil repository", "empty actual repository", "zero prepared", "nil prepared"} {
		t.Run(variant, func(t *testing.T) {
			repo := &lifecycle.Repository{}
			p := original
			switch variant {
			case "nil repository":
				repo = nil
			case "zero prepared":
				p = &Prepared{}
			case "nil prepared":
				p = nil
			}
			if l, err := NewJournalLedger(context.Background(), repo, p); l != nil || err == nil {
				t.Fatal("unqualified actual repository minted capability", l, err)
			}
		})
	}
	for _, variant := range []string{"cancelled", "head error", "cross profile", "cross incarnation", "invalid digest"} {
		t.Run(variant, func(t *testing.T) {
			ctx := context.Background()
			c := &journalCaptureFixture{head: lifecycle.PlanHead{Scope: port.JournalScope{ProfileID: "profile", BackendGeneration: "generation"}, PublicationDigest: strings.Repeat("e", 64)}}
			switch variant {
			case "cancelled":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			case "head error":
				c.err = inference.Withdrawn
			case "cross profile":
				c.head.Scope.ProfileID = "replacement"
			case "cross incarnation":
				c.head.Scope.BackendGeneration = "replacement"
			case "invalid digest":
				c.head.PublicationDigest = "invalid"
			}
			compositions := 0
			l, err := newJournalLedger(ctx, original, c.capture, func(planledger.Capture) (inference.Ledger, error) {
				compositions++
				return &journalProtocolFixture{}, nil
			})
			if l != nil || err == nil || compositions != 0 {
				t.Fatal("invalid original head reached composition", l, err, compositions)
			}
			if variant == "cancelled" && c.calls != 0 {
				t.Fatal("cancelled constructor recaptured source")
			}
		})
	}
}

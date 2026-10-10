package planledger

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/chat/app/port"
	"github.com/legrch/farol/modules/chat/app/services/inference"
	"github.com/legrch/farol/modules/chat/infra/repos/lifecycle"
)

// This private mapping fixture exercises the adapter boundary only. Actual
// image-CAS, poisoned owner, restart/no-replay, native claim and source-head
// regressions reside beside the original lifecycle.Repository implementation.
type repositoryFixture struct {
	reserves, settles     int
	reservation           lifecycle.PlanReservation
	outcome               lifecycle.PlanOutcome
	reserveErr, settleErr error
}

func (r *repositoryFixture) ReservePlan(_ context.Context, v lifecycle.PlanReservation) (bool, error) {
	r.reserves++
	r.reservation = v
	return r.reserves == 1 && r.reserveErr == nil, r.reserveErr
}
func (r *repositoryFixture) SettlePlan(_ context.Context, v lifecycle.PlanReservation, o lifecycle.PlanOutcome) error {
	r.settles++
	r.reservation = v
	r.outcome = o
	return r.settleErr
}
func originalBinding() inference.Binding {
	return inference.Binding{OperationID: "original-operation", ProfileID: "profile", BackendGeneration: "generation", OwnerID: "owner", SessionID: "session", DeadlineMillis: 100, Selection: inference.Selection{Backend: inference.PlanBackend, Account: inference.AccountIdentity{Issuer: "https://auth.openai.com", Subject: "private-account", ClientID: "client", HostID: "urn:uuid:host", Epoch: 1}, ConsentID: "consent", ConsentRevision: 2, Model: inference.ModelSelection{Slug: "model", Effort: "high", CapabilityEvidence: "verified", CatalogueEpoch: 3}}, Context: inference.ContextSelection{CheckpointID: "checkpoint", InputHash: strings.Repeat("a", 64), EstimatedTokens: 1, TokenLimit: 10}}
}
func fixtureLedger() (*Ledger, *repositoryFixture, *int) {
	b := originalBinding()
	r := &repositoryFixture{}
	calls := 0
	return &Ledger{repository: r, capture: func(got inference.Binding, intent string) (lifecycle.PlanHead, string, error) {
		calls++
		if got != b {
			return lifecycle.PlanHead{}, "", inference.Withdrawn
		}
		return lifecycle.PlanHead{Scope: port.JournalScope{ProfileID: b.ProfileID, BackendGeneration: b.BackendGeneration}, Revision: 7, PublicationDigest: strings.Repeat("b", 64)}, strings.Repeat("c", 64), nil
	}}, r, &calls
}
func TestOriginalCapturedWitnessAndNoRawPrivateIdentityInMetadata(t *testing.T) {
	l, r, calls := fixtureLedger()
	b := originalBinding()
	intent := strings.Repeat("d", 64)
	fresh, err := l.Reserve(context.Background(), b, intent)
	if err != nil || !fresh || *calls != 1 || r.reserves != 1 {
		t.Fatal(fresh, err)
	}
	v := r.reservation
	if v.OperationDigest != hash([]byte(b.OperationID)) || v.BindingDigest != bindingDigest(b) || v.IntentDigest != intent || v.WitnessDigest != strings.Repeat("c", 64) || v.Source.Revision != 7 {
		t.Fatal("original source witness mismatch", v)
	}
	if v.BindingDigest == b.Selection.Account.Subject || v.OperationDigest == b.OperationID {
		t.Fatal("private identity was stored directly")
	}
	fresh, err = l.Reserve(context.Background(), b, intent)
	if err != nil || fresh || *calls != 1 || r.reserves != 2 {
		t.Fatal("existing original became fresh", fresh, err)
	}
}
func TestOriginalUncertainCaptureCannotBeReplacedOrAuthorizeFreshIO(t *testing.T) {
	l, r, calls := fixtureLedger()
	b := originalBinding()
	intent := strings.Repeat("d", 64)
	r.reserveErr = &lifecycle.Failure{Code: lifecycle.Unknown, OutcomeUnknown: true}
	if fresh, err := l.Reserve(context.Background(), b, intent); fresh || !errors.Is(err, lifecycle.Unknown) {
		t.Fatal(fresh, err)
	}
	l.capture = func(inference.Binding, string) (lifecycle.PlanHead, string, error) {
		t.Fatal("lost ACK reacquired new source")
		return lifecycle.PlanHead{}, "", nil
	}
	if fresh, err := l.Reserve(context.Background(), b, intent); fresh || !errors.Is(err, lifecycle.Unknown) || *calls != 1 {
		t.Fatal(fresh, err)
	}
	changed := b
	changed.Selection.ConsentRevision++
	if fresh, err := l.Reserve(context.Background(), changed, intent); fresh || !errors.Is(err, inference.Conflict) || r.reserves != 2 {
		t.Fatal("rebound original operation", fresh, err)
	}
	if fresh, err := l.Reserve(context.Background(), b, strings.Repeat("e", 64)); fresh || !errors.Is(err, inference.Conflict) || r.reserves != 2 {
		t.Fatal("changed original fingerprint", fresh, err)
	}
}
func TestKnownRemoteCompletionUsesOriginalWitnessAfterSourceWithdrawal(t *testing.T) {
	l, r, calls := fixtureLedger()
	b := originalBinding()
	intent := strings.Repeat("d", 64)
	if _, err := l.Reserve(context.Background(), b, intent); err != nil {
		t.Fatal(err)
	}
	original := r.reservation
	l.capture = func(inference.Binding, string) (lifecycle.PlanHead, string, error) {
		return lifecycle.PlanHead{}, "", inference.Withdrawn
	}
	outcome := inference.Outcome{State: inference.Completed, ResponseID: "original-response", HTTPStatus: 200}
	if err := l.Settle(context.Background(), b, outcome); err != nil {
		t.Fatal(err)
	}
	if r.reservation != original || r.outcome.ResponseDigest != hash([]byte(outcome.ResponseID)) || r.outcome.State != "completed" || *calls != 1 {
		t.Fatal("remote facts replaced by current consent", r.outcome)
	}
}
func TestSettlementRejectsTextSuppressionOrDifferentOriginalBinding(t *testing.T) {
	for _, change := range []func(*inference.Binding, *inference.Outcome){func(b *inference.Binding, o *inference.Outcome) { o.Text = "private response" }, func(b *inference.Binding, o *inference.Outcome) { o.RemoteState = inference.Completed }, func(b *inference.Binding, o *inference.Outcome) { b.Context.CheckpointID = "replacement" }} {
		l, r, _ := fixtureLedger()
		b := originalBinding()
		if _, err := l.Reserve(context.Background(), b, strings.Repeat("d", 64)); err != nil {
			t.Fatal(err)
		}
		o := inference.Outcome{State: inference.Completed, ResponseID: "response"}
		change(&b, &o)
		if err := l.Settle(context.Background(), b, o); err == nil || r.settles != 0 {
			t.Fatal("private/rebound settlement entered journal", err)
		}
	}
}
func TestUnboundSettlementAndCrossScopeCaptureRefuseBeforeJournalIO(t *testing.T) {
	l, r, _ := fixtureLedger()
	b := originalBinding()
	if err := l.Settle(context.Background(), b, inference.Outcome{State: inference.Unknown, Code: "INFERENCE_TRANSPORT_UNKNOWN"}); !errors.Is(err, inference.Conflict) || r.settles != 0 {
		t.Fatal(err)
	}
	l.capture = func(inference.Binding, string) (lifecycle.PlanHead, string, error) {
		return lifecycle.PlanHead{Scope: port.JournalScope{ProfileID: "other", BackendGeneration: b.BackendGeneration}}, strings.Repeat("a", 64), nil
	}
	if fresh, err := l.Reserve(context.Background(), b, strings.Repeat("d", 64)); fresh || !errors.Is(err, inference.Invalid) || r.reserves != 0 {
		t.Fatal("cross-profile capture accepted", fresh, err)
	}
}
func TestConcurrentAdapterCallsNeverRecaptureOriginalOperation(t *testing.T) {
	l, r, calls := fixtureLedger()
	b := originalBinding()
	var wait sync.WaitGroup
	for n := 0; n < 16; n++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			if _, err := l.Reserve(context.Background(), b, strings.Repeat("d", 64)); err != nil {
				t.Error(err)
			}
		}()
	}
	wait.Wait()
	if *calls != 1 || r.reserves != 16 {
		t.Fatal(*calls, r.reserves)
	}
}

func TestBoundedCaptureRejectsMalformedBindingBeforeCaptureOrJournal(t *testing.T) {
	for _, change := range []func(*inference.Binding){func(b *inference.Binding) { b.OperationID = strings.Repeat("x", 121) }, func(b *inference.Binding) { b.Selection.Account.Issuer = "unverified" }, func(b *inference.Binding) { b.Context.InputHash = "invalid" }, func(b *inference.Binding) { b.Context.EstimatedTokens = b.Context.TokenLimit + 1 }} {
		l, r, calls := fixtureLedger()
		b := originalBinding()
		change(&b)
		if fresh, err := l.Reserve(context.Background(), b, strings.Repeat("d", 64)); fresh || !errors.Is(err, inference.Invalid) || *calls != 0 || r.reserves != 0 {
			t.Fatal("unbounded/malformed capture entered IO", fresh, err)
		}
	}
}

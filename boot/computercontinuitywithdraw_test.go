package boot

import (
	"context"
	"testing"

	journal "github.com/legrch/farol/modules/computer/domain/journal"
	accessrepo "github.com/legrch/farol/modules/computer/infra/repos/access"
)

// Test-only synthetic Go access owner. No live native process or Mac setup.
type continuityReadFixture struct {
	computerIngressStore
	original string
	planned  journal.Receipt
	checks   int
	statuses int
}

func (f *continuityReadFixture) TransitionEffectSnapshot(_ context.Context, id string, phase journal.Phase, receipt journal.Receipt) (accessrepo.Status, error) {
	f.checks++
	if id != f.original || phase != journal.WithdrawIntent || receipt != f.planned {
		return accessrepo.Status{}, computerUnavailable()
	}
	return accessrepo.Status{Revision: 5, Generation: 3, ApprovalPresent: true}, nil
}

func (f *continuityReadFixture) Status(context.Context) (accessrepo.Status, error) {
	f.statuses++
	return accessrepo.Status{}, computerUnavailable() // ordinary WAL-fenced read
}

func TestContinuityWithdrawalMustUseOriginalProtectedIntentNotOrdinaryStatus(t *testing.T) {
	ctx := context.Background()
	original := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	planned := journal.Receipt{EffectID: "withdraw-effect", Digest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	access := &continuityReadFixture{original: original, planned: planned}
	ingress := &ComputerIngress{store: access, used: make(map[string]bool)}
	fence, err := ingress.guard.deactivate()
	if err != nil || ingress.guard.activate(fence) != nil {
		t.Fatal("initial test activation failed")
	}
	if _, err := ingress.withdrawForContinuity(ctx, original, journal.Receipt{EffectID: "wrong", Digest: planned.Digest}); err == nil {
		t.Fatal("wrong WAL intent crossed native fence")
	}
	if !ingress.guard.active {
		t.Fatal("wrong intent withdrew current authority")
	}
	ack, err := ingress.withdrawForContinuity(ctx, original, planned)
	if err != nil || ack.EffectID != planned.EffectID || ack.Digest == "" || access.statuses != 0 || ingress.guard.active {
		t.Fatal("original intent not used or ordinary status observed", ack, err)
	}
	if _, err := ingress.withdrawForContinuity(ctx, original, planned); err == nil || access.checks != 3 {
		t.Fatal("original native withdrawal was replayed")
	}
}

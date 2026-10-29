package boot

import (
	"context"
	"errors"
	"testing"

	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
)

func TestStageGateNeverClaimsAdmissionWithoutEvidence(t *testing.T) {
	for _, ledger := range []*SettingsMutationIngress{
		{},
		{stageBaseline: true},
		{stageOwner: &computerStageOwner{}},
		{stageBaseline: true, stageOwner: &computerStageOwner{}, operations: nil},
	} {
		called := false
		if err := ledger.withSelfTestStage(context.Background(), "00000000-0000-4000-8000-000000000001", func(context.Context, int, NativeRoot) error { called = true; return nil }, func(err error) error { return err }); err == nil || called || ledger.stagePending {
			t.Fatal("stage admitted without evidence")
		}
	}
}

func TestStageRetirementPreservesUnconfirmedOutcome(t *testing.T) {
	ledger := &SettingsMutationIngress{stagePending: true, operations: make(map[string]*settingsMutationOperation)}
	var failure *mutationct.Failure
	if err := ledger.freezeForRetirement(); !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || failure.Retry != "never" {
		t.Fatal("stage retirement was promoted to settled", err)
	}
	if err := ledger.freezeForRetirement(); !errors.As(err, &failure) || !ledger.frozen {
		t.Fatal("retirement lost sticky result", err)
	}
}

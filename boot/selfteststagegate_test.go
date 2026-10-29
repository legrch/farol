package boot

import (
	"context"
	"errors"
	"testing"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	mutationct "github.com/legrch/farol/modules/computer/contracts/mutation"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestStagingRequiresDescendantEvidenceForPriorWritableProcess(t *testing.T) {
	terminal := &processsvc.TerminalResult{Intent: processsvc.Intent{Seal: processsvc.Seal{Write: true}}, Observation: processsvc.Observation{GroupCleanup: processsvc.CleanupConfirmed, DescendantCleanup: processsvc.CleanupUnverified}}
	prior := &settingsMutationOperation{settled: true, process: &connectorProcessOperation{result: terminal, publication: "durable"}}
	if stagingPriorEligible(prior) {
		t.Fatal("group-only settlement authorized scratch staging")
	}
	const id = "00000000-0000-4000-8000-000000000001"
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{
		id:      {stageScratch: true, pending: true, path: mutation.ScratchPath(id)},
		"prior": prior,
	}}
	if lease, err := ledger.beginSelfTestStage(context.Background(), id); err == nil || lease != nil || ledger.stagePending {
		t.Fatal("group-only prior process crossed the staging gate")
	}
	terminal.Observation.DescendantCleanup = processsvc.CleanupConfirmed
	if !stagingPriorEligible(prior) {
		t.Fatal("fully confirmed process was refused")
	}
	prior.process.publication = ""
	if stagingPriorEligible(prior) {
		t.Fatal("unconfirmed terminal publication authorized staging")
	}
	prior.process.publication = "durable"
	terminal.Observation.DescendantCleanup = processsvc.CleanupUnverified
	terminal.Intent.Seal.Write = false
	if !stagingPriorEligible(prior) {
		t.Fatal("settled read-only process was treated as writable")
	}
}

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

package mutation

import (
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestMarkerRepositoryRequiresOriginalTerminalAndSingleTransitions(t *testing.T) {
	r, disk, _ := fixture()
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	admission, err := r.AdmitSelfTestMarker(context.Background(), marker)
	if err != nil || admission.Status != port.MutationAdmitted {
		t.Fatal(admission, err)
	}
	second, err := r.AdmitSelfTestMarker(context.Background(), marker)
	if err != nil || second.Status != port.MutationExisting || disk.creates != 1 {
		t.Fatal("marker admitted twice", second, err)
	}
	if err := r.BeginSelfTestMarkerSettlement(context.Background(), b); err == nil {
		t.Fatal("missing original accepted")
	}
	parent, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
	if _, err := r.AdmitSelfTest(context.Background(), parent); err != nil {
		t.Fatal(err)
	}
	if err := r.BeginSelfTestMarkerSettlement(context.Background(), b); err == nil {
		t.Fatal("prepared original accepted")
	}
	failed, _ := domain.RestoreSelfTest(b, domain.Failed, &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: scratchTestRun}}})
	if err := r.SaveSelfTest(context.Background(), failed); err != nil {
		t.Fatal(err)
	}
	if err := r.BeginSelfTestMarkerSettlement(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if err := r.BeginSelfTestMarkerSettlement(context.Background(), b); err == nil {
		t.Fatal("settlement intent repeated")
	}
	if err := r.FinishSelfTestMarker(context.Background(), b); err != nil {
		t.Fatal(err)
	}
	if err := r.FinishSelfTestMarker(context.Background(), b); err == nil {
		t.Fatal("settlement repeated")
	}
	got, err := r.LoadSelfTestMarker(context.Background(), b)
	if err != nil || got.Phase() != domain.SelfTestMarkerSettled || got.Binding() != b {
		t.Fatal("settled marker lost", got, err)
	}
}

func TestSelfTestMarkerRepositoryFencesLostAdmission(t *testing.T) {
	r, disk, _ := fixture()
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	disk.createErr, disk.visibleBeforeError = errors.New("lost"), true
	if _, err := r.AdmitSelfTestMarker(context.Background(), marker); err == nil || !r.fenced {
		t.Fatal("lost admission accepted")
	}
	disk.createErr = nil
	reopened := newRepository(disk)
	got, err := reopened.LoadSelfTestMarker(context.Background(), b)
	if err != nil || got == nil || got.Phase() != domain.SelfTestMarkerSelected {
		t.Fatal("original lost", got, err)
	}
	existing, err := reopened.AdmitSelfTestMarker(context.Background(), marker)
	if err != nil || existing.Status != port.MutationExisting || disk.creates != 1 {
		t.Fatal("unknown admission repeated", existing, err)
	}
}

func TestSelfTestMarkerRepositoryDoesNotRepeatUnconfirmedTransition(t *testing.T) {
	r, disk, _ := fixture()
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), marker); err != nil {
		t.Fatal(err)
	}
	parent, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
	if _, err := r.AdmitSelfTest(context.Background(), parent); err != nil {
		t.Fatal(err)
	}
	failed, _ := domain.RestoreSelfTest(b, domain.Failed, &domain.SelfTestResult{Status: "failed", Steps: []domain.SelfTestStep{{Name: "scratch", Status: "fail", Operation: scratchTestRun}}})
	if err := r.SaveSelfTest(context.Background(), failed); err != nil {
		t.Fatal(err)
	}
	disk.replaceErr, disk.visibleBeforeError = errors.New("lost"), true
	if err := r.BeginSelfTestMarkerSettlement(context.Background(), b); err == nil || !r.fenced {
		t.Fatal("unknown transition accepted")
	}
	disk.replaceErr = nil
	reopened := newRepository(disk)
	got, err := reopened.LoadSelfTestMarker(context.Background(), b)
	if err != nil || got == nil || got.Phase() != domain.SelfTestMarkerSettling {
		t.Fatal("intent not retained", got, err)
	}
	replaces := disk.replaces
	if err := reopened.BeginSelfTestMarkerSettlement(context.Background(), b); err == nil || disk.replaces != replaces {
		t.Fatal("intent repeated")
	}
}

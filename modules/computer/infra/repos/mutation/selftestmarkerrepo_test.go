package mutation

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestVersionTwoAdmissionRequiresMatchingSelectedMarker(t *testing.T) {
	_, original, _ := fixture()
	disk := &historyMemory{memory: original}
	r := newRepository(disk)
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	parent, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
	if _, err := r.AdmitSelfTest(context.Background(), parent); err == nil || disk.creates != 0 {
		t.Fatal("missing marker admitted")
	}
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), marker); err != nil {
		t.Fatal(err)
	}
	crossed := b
	crossed.ComputerGeneration++
	crossedParent, _ := domain.RestoreSelfTest(crossed, domain.Prepared, nil)
	if _, err := r.AdmitSelfTest(context.Background(), crossedParent); err == nil || disk.creates != 1 {
		t.Fatal("crossed marker admitted")
	}
	out, err := r.AdmitSelfTest(context.Background(), parent)
	if err != nil || out.Status != port.MutationAdmitted || disk.creates != 2 {
		t.Fatal("selected original refused", out, err)
	}
}

func TestSelfTestMarkerRepositoryRequiresOriginalTerminalAndSingleTransitions(t *testing.T) {
	_, memoryDisk, _ := fixture()
	disk := &historyMemory{memory: memoryDisk}
	r := newRepository(disk)
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
	_, memoryDisk, _ := fixture()
	disk := &historyMemory{memory: memoryDisk}
	r := newRepository(disk)
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

func TestSelfTestMarkerRepositoryExcludesDifferentUnresolvedIDsInWorkspace(t *testing.T) {
	_, memoryDisk, _ := fixture()
	disk := &historyMemory{memory: memoryDisk}
	r := newRepository(disk)
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	first, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), first); err != nil {
		t.Fatal(err)
	}
	b.Identity.OperationID = "00000000-0000-4000-8000-000000000098"
	second, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), second); err == nil || disk.creates != 1 {
		t.Fatal("unresolved marker admitted a second operation", err)
	}
	b.WorkspaceID = "other"
	third, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), third); err != nil || disk.creates != 2 {
		t.Fatal("other workspace rejected", err)
	}
}

func TestSelfTestMarkerAdmissionSerializesConcurrentWorkspaceAttempts(t *testing.T) {
	_, original, _ := fixture()
	disk := &historyMemory{memory: original}
	r := newRepository(disk)
	var wg sync.WaitGroup
	admitted := make(chan bool, 12)
	for i := range 12 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: fmt.Sprintf("00000000-0000-4000-8000-%012d", i), OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
			marker, err := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
			if err != nil {
				admitted <- false
				return
			}
			result, err := r.AdmitSelfTestMarker(context.Background(), marker)
			admitted <- err == nil && result.Status == port.MutationAdmitted
		}(i)
	}
	wg.Wait()
	close(admitted)
	count := 0
	for ok := range admitted {
		if ok {
			count++
		}
	}
	if count != 1 || disk.creates != 1 {
		t.Fatal("concurrent admissions", count, disk.creates)
	}
}

func TestSelfTestMarkerAdmissionRetainsOlderUnknownWithoutMarker(t *testing.T) {
	_, original, _ := fixture()
	disk := &historyMemory{memory: original}
	r := newRepository(disk)
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	old, _ := domain.RestoreSelfTest(b, domain.OutcomeUnknown, &domain.SelfTestResult{Status: "unknown"})
	raw, _ := encodeSelfTest(old)
	key, _ := selfTestKey(b.Identity)
	disk.files[key] = raw
	b.Identity.OperationID = "00000000-0000-4000-8000-000000000098"
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), marker); err == nil || disk.creates != 0 {
		t.Fatal("unknown history was ignored", err)
	}
}

func TestSelfTestMarkerAdmissionDoesNotOverflowReadableHistory(t *testing.T) {
	_, original, _ := fixture()
	disk := &historyMemory{memory: original}
	r := newRepository(disk)
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 2}
	for i := range maxSelfTestHistory {
		b.Identity.OperationID = fmt.Sprintf("00000000-0000-4000-8000-%012d", i)
		b.WorkspaceID = fmt.Sprintf("work-%d", i)
		marker, err := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
		if err != nil {
			t.Fatal(err)
		}
		key, _ := selfTestMarkerKey(b)
		raw, _ := encodeSelfTestMarker(marker)
		disk.files[key] = raw
	}
	b.Identity.OperationID = "00000000-0000-4000-8000-999999999999"
	b.WorkspaceID = "new-work"
	marker, _ := domain.RestoreSelfTestMarker(b, domain.SelfTestMarkerSelected)
	if _, err := r.AdmitSelfTestMarker(context.Background(), marker); err == nil || disk.creates != 0 {
		t.Fatal("history overflow accepted", err)
	}
	markers, err := r.ListSelfTestMarkers(context.Background(), "owner", "profile", "computer")
	if err != nil || len(markers) != maxSelfTestHistory {
		t.Fatal("existing history became unreadable", len(markers), err)
	}
}

func TestSelfTestMarkerRepositoryDoesNotRepeatUnconfirmedTransition(t *testing.T) {
	_, memoryDisk, _ := fixture()
	disk := &historyMemory{memory: memoryDisk}
	r := newRepository(disk)
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

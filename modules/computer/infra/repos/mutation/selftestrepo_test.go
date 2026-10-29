package mutation

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestSelfTestRepositoryAdmitsOnlyOnceAndPreservesUnknown(t *testing.T) {
	r, disk, _ := fixture()
	b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
	prepared, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
	results := make(chan port.SelfTestAdmission, 12)
	errs := make(chan error, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() { result, err := r.AdmitSelfTest(context.Background(), prepared); results <- result; errs <- err })
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	fresh := 0
	for result := range results {
		if result.Status == port.MutationAdmitted {
			fresh++
		} else if result.Status != port.MutationExisting {
			t.Fatal("invalid result")
		}
	}
	if fresh != 1 || disk.creates != 1 {
		t.Fatal("multiple admissions", fresh, disk.creates)
	}
	terminal, _ := domain.RestoreSelfTest(b, domain.OutcomeUnknown, &domain.SelfTestResult{Status: "unknown"})
	if err := r.SaveSelfTest(context.Background(), terminal); err != nil {
		t.Fatal(err)
	}
	observer := newRepository(disk)
	out, err := observer.AdmitSelfTest(context.Background(), prepared)
	if err != nil || out.Status != port.MutationExisting || out.Record.Phase() != domain.OutcomeUnknown || disk.creates != 1 {
		t.Fatal("unknown replayed", out, err)
	}
	if err := observer.SaveSelfTest(context.Background(), terminal); err == nil {
		t.Fatal("terminal rewritten")
	}
	changed := b
	changed.WorkspaceID = "other"
	other, _ := domain.RestoreSelfTest(changed, domain.Prepared, nil)
	if _, err := observer.AdmitSelfTest(context.Background(), other); err == nil {
		t.Fatal("identity rebound")
	}
}

func TestSelfTestRepositoryLostAdmissionAndSaveFenceWriter(t *testing.T) {
	for _, mode := range []string{"admission", "save"} {
		t.Run(mode, func(t *testing.T) {
			r, disk, _ := fixture()
			b := domain.SelfTestBinding{Identity: domain.Identity{Scope: domain.ScopeOwnerSettings, OperationID: scratchTestRun, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", ComputerGeneration: 7, Version: 1}
			prepared, _ := domain.RestoreSelfTest(b, domain.Prepared, nil)
			if mode == "admission" {
				disk.createErr, disk.visibleBeforeError = errors.New("lost admission"), true
				if _, err := r.AdmitSelfTest(context.Background(), prepared); err == nil || !r.fenced {
					t.Fatal("lost admission acknowledged")
				}
				disk.createErr = nil
				out, err := newRepository(disk).AdmitSelfTest(context.Background(), prepared)
				if err != nil || out.Status != port.MutationExisting || out.Record.Phase() != domain.Prepared || disk.creates != 1 {
					t.Fatal("lost admission repeated", out, err)
				}
				return
			}
			if _, err := r.AdmitSelfTest(context.Background(), prepared); err != nil {
				t.Fatal(err)
			}
			terminal, _ := domain.RestoreSelfTest(b, domain.OutcomeUnknown, &domain.SelfTestResult{Status: "unknown"})
			disk.replaceErr, disk.visibleBeforeError = errors.New("lost save"), true
			if err := r.SaveSelfTest(context.Background(), terminal); err == nil || !r.fenced {
				t.Fatal("lost save acknowledged")
			}
			if _, err := r.LoadSelfTest(context.Background(), b); err == nil {
				t.Fatal("fenced writer accepted observation")
			}
			if err := r.SaveSelfTest(context.Background(), terminal); err == nil || disk.replaces != 1 {
				t.Fatal("lost save repeated")
			}
		})
	}
}

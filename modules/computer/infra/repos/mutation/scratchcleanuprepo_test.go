package mutation

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

func cleanupFixture(t *testing.T) (*Repository, *memory, *domain.State, *domain.ScratchCleanupState) {
	t.Helper()
	r, disk, _ := ownerFixture(t)
	creation := scratchPrepared(t)
	admitted(t, r, creation)
	creation = scratchCompleted(t, creation)
	if err := r.Save(context.Background(), creation); err != nil {
		t.Fatal(err)
	}
	cleanup, err := domain.NewScratchCleanup(creation)
	if err != nil {
		t.Fatal(err)
	}
	return r, disk, creation, cleanup
}

func TestScratchCleanupRepositoryRequiresExactDurableParent(t *testing.T) {
	r, disk, creation, cleanup := cleanupFixture(t)
	ctx := context.Background()
	parentKey, _ := recordKey(creation.Binding().Identity)
	original := bytes.Clone(disk.files[parentKey])
	delete(disk.files, parentKey)
	if out, err := r.AdmitScratchCleanup(ctx, cleanup); err == nil || out.Record != nil || disk.creates != 1 {
		t.Fatal("missing parent admitted", out, err)
	}
	prepared, _ := domain.NewPrepared(creation.Binding())
	disk.files[parentKey], _ = encode(prepared)
	if out, err := r.AdmitScratchCleanup(ctx, cleanup); err == nil || out.Record != nil || disk.creates != 1 {
		t.Fatal("unfinished parent admitted", out, err)
	}
	other := *creation.Receipt()
	other.Directory.Inode = "42"
	crossed, _ := domain.Restore(creation.Binding(), domain.Completed, &other, nil)
	disk.files[parentKey], _ = encode(crossed)
	if out, err := r.AdmitScratchCleanup(ctx, cleanup); err == nil || out.Record != nil || disk.creates != 1 {
		t.Fatal("crossed parent admitted", out, err)
	}
	disk.files[parentKey] = original
	if out, err := r.AdmitScratchCleanup(ctx, cleanup); err != nil || out.Status != port.MutationAdmitted || out.Record == nil || !bytes.Equal(disk.files[parentKey], original) {
		t.Fatal("original parent admission failed", out, err)
	}
}

func TestScratchCleanupRepositoryOneAttemptAndUnknownSurvivesReopen(t *testing.T) {
	r, disk, creation, cleanup := cleanupFixture(t)
	ctx := context.Background()
	parentKey, _ := recordKey(creation.Binding().Identity)
	before := bytes.Clone(disk.files[parentKey])
	results := make(chan ScratchCleanupAdmission, 16)
	errs := make(chan error, 16)
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { out, err := r.AdmitScratchCleanup(ctx, cleanup); results <- out; errs <- err })
	}
	wg.Wait()
	close(results)
	close(errs)
	fresh := 0
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for out := range results {
		if out.Record == nil {
			t.Fatal("admission lost original record")
		}
		if out.Status == port.MutationAdmitted {
			fresh++
		} else if out.Status != port.MutationExisting {
			t.Fatal("unexpected admission", out.Status)
		}
	}
	if fresh != 1 || disk.creates != 2 {
		t.Fatal("duplicate cleanup admission", fresh, disk.creates)
	}
	unknown, _ := domain.RestoreScratchCleanup(cleanup.Binding(), domain.OutcomeUnknown, &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err := r.SaveScratchCleanup(ctx, unknown); err != nil {
		t.Fatal(err)
	}
	observer := newRepository(disk)
	out, err := observer.AdmitScratchCleanup(ctx, cleanup)
	if err != nil || out.Status != port.MutationExisting || out.Record == nil || out.Record.Phase() != domain.OutcomeUnknown || !bytes.Equal(before, disk.files[parentKey]) {
		t.Fatal("reopen changed original or admitted retry", out, err)
	}
	completed, _ := domain.RestoreScratchCleanup(cleanup.Binding(), domain.Completed, nil)
	if err := observer.SaveScratchCleanup(ctx, completed); err == nil {
		t.Fatal("unknown cleanup was upgraded")
	}
}

func TestScratchCleanupRepositoryLostSaveFencesOriginalWriter(t *testing.T) {
	r, disk, _, cleanup := cleanupFixture(t)
	ctx := context.Background()
	if out, err := r.AdmitScratchCleanup(ctx, cleanup); err != nil || out.Status != port.MutationAdmitted {
		t.Fatal(out, err)
	}
	completed, _ := domain.RestoreScratchCleanup(cleanup.Binding(), domain.Completed, nil)
	disk.replaceErr, disk.visibleBeforeError = errors.New("lost acknowledgement"), true
	if err := r.SaveScratchCleanup(ctx, completed); err == nil || !r.fenced {
		t.Fatal("lost save acknowledged")
	}
	if _, err := r.LoadScratchCleanup(ctx, cleanup.Binding()); err == nil {
		t.Fatal("fenced writer promoted visible bytes")
	}
	if err := r.SaveScratchCleanup(ctx, completed); err == nil || disk.replaces != 2 {
		t.Fatal("lost save retried", err, disk.replaces)
	}
}

func TestScratchCleanupRepositoryLostAdmissionNeverMintsAnotherAttempt(t *testing.T) {
	r, disk, _, cleanup := cleanupFixture(t)
	disk.createErr, disk.visibleBeforeError = errors.New("lost acknowledgement"), true
	if out, err := r.AdmitScratchCleanup(context.Background(), cleanup); err == nil || out.Record != nil || !r.fenced {
		t.Fatal("lost admission acknowledged", out, err)
	}
	observer := newRepository(disk)
	disk.createErr = nil
	out, err := observer.AdmitScratchCleanup(context.Background(), cleanup)
	if err != nil || out.Status != port.MutationExisting || out.Record == nil || out.Record.Phase() != domain.Prepared || disk.creates != 2 {
		t.Fatal("reopen minted replacement cleanup", out, err, disk.creates)
	}
}

func TestScratchCleanupRepositoryParentChangeDuringAdmissionIsUnknown(t *testing.T) {
	r, disk, creation, cleanup := cleanupFixture(t)
	parentKey, _ := recordKey(creation.Binding().Identity)
	disk.afterCreate = func() { delete(disk.files, parentKey) }
	if out, err := r.AdmitScratchCleanup(context.Background(), cleanup); err == nil || out.Record != nil || !r.fenced {
		t.Fatal("changed parent was acknowledged", out, err)
	}
	if out, err := r.AdmitScratchCleanup(context.Background(), cleanup); err == nil || out.Record != nil || disk.creates != 2 {
		t.Fatal("uncertain admission repeated", out, err)
	}
}

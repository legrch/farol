package mutation

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	domain "github.com/legrch/farol/modules/computer/domain/mutation"
)

// The byte store is injected and has no native filesystem side effects.
func TestScratchFileCleanupRepositoryBindsBothOriginalsAndKeepsUnknown(t *testing.T) {
	creation, file, inventory := fileCleanupFixture(t)
	r, disk, _ := fixture()
	parentKey, _ := recordKey(creation.Binding().Identity)
	fileKey, _ := recordKey(file.Binding().Identity)
	parentRaw, _ := encode(creation)
	fileRaw, _ := encode(file)
	disk.files[parentKey], disk.files[fileKey] = bytes.Clone(parentRaw), bytes.Clone(fileRaw)
	cleanup, err := domain.RestoreScratchFileCleanup(*inventory, domain.Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	delete(disk.files, fileKey)
	if out, err := r.AdmitScratchFileCleanup(ctx, cleanup); err == nil || out.Record != nil || disk.creates != 0 {
		t.Fatal("missing file terminal admitted")
	}
	prepared, _ := domain.NewPrepared(file.Binding())
	disk.files[fileKey], _ = encode(prepared)
	if out, err := r.AdmitScratchFileCleanup(ctx, cleanup); err == nil || out.Record != nil || disk.creates != 0 {
		t.Fatal("prepared file admitted")
	}
	disk.files[fileKey] = bytes.Clone(fileRaw)
	if out, err := r.AdmitScratchFileCleanup(ctx, cleanup); err != nil || out.Status != port.MutationAdmitted {
		t.Fatal("admission", out, err)
	}
	unknown, _ := domain.RestoreScratchFileCleanup(*inventory, domain.OutcomeUnknown, &domain.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err := r.SaveScratchFileCleanup(ctx, unknown); err != nil {
		t.Fatal(err)
	}
	observer := newRepository(disk)
	out, err := observer.AdmitScratchFileCleanup(ctx, cleanup)
	if err != nil || out.Status != port.MutationExisting || out.Record.Phase() != domain.OutcomeUnknown || disk.creates != 1 {
		t.Fatal("unknown was retried", out, err)
	}
	completed, _ := domain.RestoreScratchFileCleanup(*inventory, domain.Completed, nil)
	if observer.SaveScratchFileCleanup(ctx, completed) == nil {
		t.Fatal("unknown overwritten")
	}
	if !bytes.Equal(disk.files[parentKey], parentRaw) || !bytes.Equal(disk.files[fileKey], fileRaw) {
		t.Fatal("original history changed")
	}
}

func TestScratchFileCleanupRepositoryLostAdmissionFencesWriter(t *testing.T) {
	creation, file, inventory := fileCleanupFixture(t)
	r, disk, _ := fixture()
	parentKey, _ := recordKey(creation.Binding().Identity)
	fileKey, _ := recordKey(file.Binding().Identity)
	disk.files[parentKey], _ = encode(creation)
	disk.files[fileKey], _ = encode(file)
	cleanup, _ := domain.RestoreScratchFileCleanup(*inventory, domain.Prepared, nil)
	disk.createErr, disk.visibleBeforeError = errors.New("lost acknowledgement"), true
	if out, err := r.AdmitScratchFileCleanup(context.Background(), cleanup); err == nil || out.Record != nil || !r.fenced {
		t.Fatal("lost admission acknowledged")
	}
	disk.createErr = nil
	observer := newRepository(disk)
	out, err := observer.AdmitScratchFileCleanup(context.Background(), cleanup)
	if err != nil || out.Status != port.MutationExisting || out.Record.Phase() != domain.Prepared || disk.creates != 1 {
		t.Fatal("lost attempt was re-admitted", out, err)
	}
}

func TestScratchFileCleanupRepositoryFencesLostSaveAndParentChange(t *testing.T) {
	for _, mode := range []string{"lost save", "changed parent during admission"} {
		t.Run(mode, func(t *testing.T) {
			creation, file, inventory := fileCleanupFixture(t)
			r, disk, _ := fixture()
			parentKey, _ := recordKey(creation.Binding().Identity)
			fileKey, _ := recordKey(file.Binding().Identity)
			disk.files[parentKey], _ = encode(creation)
			disk.files[fileKey], _ = encode(file)
			cleanup, _ := domain.RestoreScratchFileCleanup(*inventory, domain.Prepared, nil)
			if mode == "changed parent during admission" {
				disk.afterCreate = func() { delete(disk.files, fileKey) }
				if out, err := r.AdmitScratchFileCleanup(context.Background(), cleanup); err == nil || out.Record != nil || !r.fenced {
					t.Fatal("changed parent admitted")
				}
				return
			}
			if _, err := r.AdmitScratchFileCleanup(context.Background(), cleanup); err != nil {
				t.Fatal(err)
			}
			terminal, _ := domain.RestoreScratchFileCleanup(*inventory, domain.Completed, nil)
			disk.replaceErr, disk.visibleBeforeError = errors.New("lost acknowledgement"), true
			if err := r.SaveScratchFileCleanup(context.Background(), terminal); err == nil || !r.fenced {
				t.Fatal("lost terminal acknowledged")
			}
			if _, err := r.LoadScratchFileCleanup(context.Background(), *inventory); err == nil {
				t.Fatal("fenced writer allowed observation")
			}
			if err := r.SaveScratchFileCleanup(context.Background(), terminal); err == nil || disk.replaces != 1 {
				t.Fatal("lost terminal retried")
			}
		})
	}
}

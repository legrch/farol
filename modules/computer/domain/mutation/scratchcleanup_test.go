package mutation

import "testing"

func TestScratchCleanupRequiresOriginalCompletedCreation(t *testing.T) {
	b := scratchBindingFixture()
	prepared, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewScratchCleanup(prepared); err == nil {
		t.Fatal("prepared creation authorized cleanup")
	}
	unknown, err := prepared.Refuse(Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewScratchCleanup(unknown); err == nil {
		t.Fatal("unknown creation authorized cleanup")
	}
	dir := DirectoryIdentity{Device: "1", Inode: "42"}
	created, err := prepared.Complete(Receipt{Operation: ScratchKind, RelativePath: b.RelativePath, Directory: dir})
	if err != nil {
		t.Fatal(err)
	}
	cleanup, err := NewScratchCleanup(created)
	if err != nil || cleanup.Phase() != Prepared || cleanup.Binding().Creation != b || cleanup.Binding().Directory != dir {
		t.Fatal("original creation lost", cleanup, err)
	}
	copy, err := NewScratchCleanup(created)
	if err != nil || copy.Binding() != cleanup.Binding() {
		t.Fatal("same creation produced another binding", err)
	}
}

func TestScratchCleanupUnknownAndCompletedNeverReopen(t *testing.T) {
	b := scratchBindingFixture()
	prepared, _ := NewPrepared(b)
	created, _ := prepared.Complete(Receipt{Operation: ScratchKind, RelativePath: b.RelativePath, Directory: DirectoryIdentity{Device: "1", Inode: "42"}})
	cleanup, err := NewScratchCleanup(created)
	if err != nil {
		t.Fatal(err)
	}
	unknown, err := RestoreScratchCleanup(cleanup.Binding(), OutcomeUnknown, &Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err != nil {
		t.Fatal(err)
	}
	unknown, err = cleanup.Apply(*unknown)
	if err != nil {
		t.Fatal(err)
	}
	completed, err := RestoreScratchCleanup(cleanup.Binding(), Completed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := unknown.Apply(*completed); err == nil {
		t.Fatal("unknown cleanup became completed")
	}
	if _, err := unknown.Apply(*cleanup); err == nil {
		t.Fatal("unknown cleanup reopened")
	}
	changed := cleanup.Binding()
	changed.Directory.Inode = "43"
	crossed, err := RestoreScratchCleanup(changed, Completed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cleanup.Apply(*crossed); err == nil {
		t.Fatal("different directory accepted")
	}
	if _, err := cleanup.Apply(*completed); err != nil {
		t.Fatal("original completion refused", err)
	}
}

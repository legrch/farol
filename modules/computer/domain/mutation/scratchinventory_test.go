package mutation

import "testing"

func inventoryFixture(t *testing.T) (*State, *State) {
	t.Helper()
	b := scratchBindingFixture()
	p, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	creation, err := p.Complete(Receipt{Operation: ScratchKind, RelativePath: b.RelativePath, Directory: DirectoryIdentity{Device: "1", Inode: "42"}})
	if err != nil {
		t.Fatal(err)
	}
	f := connectorV3Binding()
	f.RelativePath = b.RelativePath + "/check.txt"
	p, err = NewPrepared(f)
	if err != nil {
		t.Fatal(err)
	}
	file, err := p.Complete(Receipt{Operation: WriteKind, RelativePath: f.RelativePath, AfterSHA256: digest("b")})
	if err != nil {
		t.Fatal(err)
	}
	return creation, file
}

func TestScratchFileInventoryBindsExactDurableRecords(t *testing.T) {
	creation, file := inventoryFixture(t)
	witness, err := NewScratchFileInventory(creation, file, DirectoryIdentity{Device: "1", Inode: "80"})
	if err != nil || witness == nil || witness.Creation.Creation != creation.Binding() || witness.Mutation != file.Binding() || witness.SHA256 != file.Receipt().AfterSHA256 || witness.File.Inode != "80" {
		t.Fatal("exact records refused", witness, err)
	}
	for name, change := range map[string]func(*Binding){
		"owner":          func(b *Binding) { b.Identity.OwnerID = "other" },
		"profile":        func(b *Binding) { b.Identity.ProfileID = "other" },
		"computer":       func(b *Binding) { b.Identity.ComputerID = "other" },
		"generation":     func(b *Binding) { b.ComputerGeneration++ },
		"workspace":      func(b *Binding) { b.WorkspaceID = "other" },
		"path":           func(b *Binding) { b.RelativePath = "other/check.txt" },
		"same operation": func(b *Binding) { b.Identity.OperationID = creation.Binding().Identity.OperationID },
	} {
		t.Run(name, func(t *testing.T) {
			b := file.Binding()
			change(&b)
			receipt := file.Receipt()
			receipt.RelativePath = b.RelativePath
			crossed, err := Restore(b, Completed, receipt, nil)
			if err != nil {
				t.Fatal(err)
			}
			if got, err := NewScratchFileInventory(creation, crossed, DirectoryIdentity{Device: "1", Inode: "80"}); err == nil || got != nil {
				t.Fatal("crossed witness accepted")
			}
		})
	}
	for _, phase := range []Phase{Prepared, Failed, OutcomeUnknown} {
		b := file.Binding()
		p, _ := NewPrepared(b)
		if phase == Failed {
			p, _ = p.Refuse(Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"})
		}
		if phase == OutcomeUnknown {
			p, _ = p.Refuse(Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"})
		}
		if got, err := NewScratchFileInventory(creation, p, DirectoryIdentity{Device: "1", Inode: "80"}); err == nil || got != nil {
			t.Fatal("unfinished file accepted", phase)
		}
	}
	if got, err := NewScratchFileInventory(creation, file, DirectoryIdentity{Device: "1", Inode: "0"}); err == nil || got != nil {
		t.Fatal("invalid file identity accepted")
	}
}

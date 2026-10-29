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

func TestScratchFileCleanupRetainsExactInventoryAndTerminal(t *testing.T) {
	creation, file := inventoryFixture(t)
	inventory, err := NewScratchFileInventory(creation, file, DirectoryIdentity{Device: "1", Inode: "80"})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := RestoreScratchFileCleanup(*inventory, Prepared, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, phase := range []Phase{Completed, Failed, OutcomeUnknown} {
		var failure *Failure
		if phase == Failed {
			failure = &Failure{Code: "WORKSPACE_MUTATION_CONFLICT", Source: "native-workspace"}
		}
		if phase == OutcomeUnknown {
			failure = &Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace"}
		}
		terminal, err := RestoreScratchFileCleanup(*inventory, phase, failure)
		if err != nil {
			t.Fatal(err)
		}
		accepted, err := prepared.Apply(*terminal)
		if err != nil || accepted.Phase() != phase {
			t.Fatal("terminal refused", err)
		}
		if _, err := accepted.Apply(*prepared); err == nil {
			t.Fatal("terminal reopened")
		}
		if failure != nil {
			copy := accepted.Failure()
			copy.Code = "changed"
			if accepted.Failure().Code != failure.Code {
				t.Fatal("failure alias leaked")
			}
		}
	}
	changed := *inventory
	changed.File.Inode = "81"
	other, _ := RestoreScratchFileCleanup(changed, Completed, nil)
	if _, err := prepared.Apply(*other); err == nil {
		t.Fatal("changed file identity accepted")
	}
	changed.SHA256 = "invalid"
	if _, err := RestoreScratchFileCleanup(changed, Prepared, nil); err == nil {
		t.Fatal("invalid digest accepted")
	}
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

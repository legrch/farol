package mutation

import "testing"

func scratchBindingFixture() Binding {
	b := ownerBinding()
	b.Identity.OperationID = "00000000-0000-4000-8000-000000000001"
	b.RelativePath = ScratchPath(b.Identity.OperationID)
	b.Scratch = ScratchBinding{RunID: b.Identity.OperationID, Root: "/workspace", Leaf: b.RelativePath, RootIdentity: DirectoryIdentity{Device: "1", Inode: "2"}, ExpectedInventory: EmptyScratchInventory}
	return b
}

func TestScratchBindingAndTerminalAreExactAndImmutable(t *testing.T) {
	b := scratchBindingFixture()
	if ValidateNative(Scratch{Binding: b.Scratch}) != nil {
		t.Fatal("valid scratch refused")
	}
	prepared, err := NewPrepared(b)
	if err != nil {
		t.Fatal(err)
	}
	dir := DirectoryIdentity{Device: "1", Inode: "42"}
	receipt := Receipt{Operation: ScratchKind, RelativePath: b.RelativePath, Directory: dir}
	completed, err := prepared.Complete(receipt)
	if err != nil || completed.Phase() != Completed {
		t.Fatal("scratch completion refused", err)
	}
	unknown, err := prepared.Refuse(Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "native-workspace", Directory: dir})
	if err != nil || unknown.Phase() != OutcomeUnknown {
		t.Fatal("unknown identity lost", err)
	}
	if _, err := unknown.Complete(receipt); err == nil {
		t.Fatal("unknown operation became executable")
	}
	for _, change := range []func(*Binding){
		func(v *Binding) { v.Scratch.RunID = "other" },
		func(v *Binding) { v.Scratch.Leaf += "/child" },
		func(v *Binding) { v.Scratch.Root = "/" },
		func(v *Binding) { v.Scratch.RootIdentity.Inode = "0" },
		func(v *Binding) { v.Scratch.ExpectedInventory = "other" },
	} {
		bad := b
		change(&bad)
		if _, err := NewPrepared(bad); err == nil {
			t.Fatal("crossed or invalid binding admitted")
		}
	}
	connector := connectorV3Binding()
	connector.Scratch = b.Scratch
	if _, err := NewPrepared(connector); err == nil {
		t.Fatal("connector supplied owner-only scratch")
	}
	if _, err := prepared.Complete(Receipt{Operation: WriteKind, RelativePath: b.RelativePath, AfterSHA256: digest("a")}); err == nil {
		t.Fatal("ordinary receipt admitted for scratch")
	}
}

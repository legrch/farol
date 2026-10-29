package filesystem

import (
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
)

func TestMutationDigestJSONStringifyUnicodeControlsAndOrderedEdits(t *testing.T) {
	cases := []struct {
		op   mutation.Operation
		want string
	}{
		{mutation.Write{RelativePath: "note.md", Content: "<>&😀\u2028\u2029\b\f\n\r\t\x01\"\\"}, "65f967f9b20d3bca47e75ff5ed9da48e6d44ccb685c26ef3de9376b187b5046c"},
		{mutation.Edit{RelativePath: "note.md", ExpectedSHA256: strings.Repeat("a", 64), Edits: []mutation.TextEdit{{OldText: "a", NewText: "b"}, {OldText: "c", NewText: "d"}}}, "38da363f85bf46f1e30e222c4ac408fc9adfd33ba26ca95591ba3aaa03421033"},
	}
	for _, c := range cases {
		got, err := (Digester{}).Digest(port.MutationDigestInput{WorkspaceID: "work", Operation: c.op})
		if err != nil || got != c.want {
			t.Fatalf("got %s %v; want %s", got, err, c.want)
		}
	}
	op := mutation.Edit{RelativePath: "note.md", ExpectedSHA256: strings.Repeat("a", 64), Edits: []mutation.TextEdit{{OldText: "c", NewText: "d"}, {OldText: "a", NewText: "b"}}}
	got, err := (Digester{}).Digest(port.MutationDigestInput{WorkspaceID: "work", Operation: op})
	if err != nil || got == cases[1].want {
		t.Fatal("lost edit order")
	}
}

func TestScratchDigestBindsOriginalDirectoryIdentity(t *testing.T) {
	id := "00000000-0000-4000-8000-000000000001"
	binding := mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: mutation.ScratchPath(id),
		RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "42"}, ExpectedInventory: mutation.EmptyScratchInventory}
	digest := func(workspace string, b mutation.ScratchBinding) string {
		t.Helper()
		got, err := (Digester{}).Digest(port.MutationDigestInput{WorkspaceID: workspace, Operation: mutation.Scratch{Binding: b}})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	baseline := digest("work", binding)
	want := payloadHash([]byte(`["work","workspace.self-test-scratch",".farol-self-test-00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000001","/work","7","42","empty"]`))
	if baseline != want {
		t.Fatalf("scratch fingerprint %s, want %s", baseline, want)
	}
	changes := []mutation.ScratchBinding{binding, binding, binding, binding}
	changes[0].Root = "/other"
	changes[1].RootIdentity.Device = "8"
	changes[2].RootIdentity.Inode = "43"
	changes[3].RunID = "00000000-0000-4000-8000-000000000002"
	changes[3].Leaf = mutation.ScratchPath(changes[3].RunID)
	for _, changed := range changes {
		if digest("work", changed) == baseline {
			t.Fatalf("scratch fingerprint ignored a changed binding: %#v", changed)
		}
	}
	if digest("other", binding) == baseline {
		t.Fatal("scratch fingerprint ignored workspace")
	}
}

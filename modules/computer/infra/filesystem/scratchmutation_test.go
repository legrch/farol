package filesystem

import (
	"context"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// An injected descriptor/inode model; this is not native filesystem evidence.
func TestScratchMutationPinsOriginalParentAndNeverCreatesIt(t *testing.T) {
	for _, mode := range []string{"exact", "missing", "replaced", "symlink", "permissions", "displaced before publication", "wrong path"} {
		t.Run(mode, func(t *testing.T) {
			m, f := fakeMutable()
			id := "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(id)
			original := f.directory(0700)
			f.work.children[leaf] = original
			b := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: "7", Inode: strconv.FormatUint(original.v.ino, 10)}}
			r := fakeRequest(mutation.Write{RelativePath: leaf + "/check.txt", Content: "new"})
			switch mode {
			case "missing":
				delete(f.work.children, leaf)
			case "replaced":
				f.work.children[leaf] = f.directory(0700)
			case "symlink":
				f.work.children[leaf] = f.node(unix.S_IFLNK | 0777)
			case "permissions":
				original.v.mode = unix.S_IFDIR | 0755
			case "wrong path":
				r.Operation = mutation.Write{RelativePath: "elsewhere/check.txt", Content: "new"}
			case "displaced before publication":
				checks := 0
				r.BeforePublish = func(context.Context) error {
					checks++
					if checks == 2 {
						f.work.children[leaf] = f.directory(0700)
					}
					return nil
				}
			}
			out, err := m.MutateScratch(context.Background(), r, b)
			if mode == "exact" {
				if err != nil || out == nil || f.links != 1 || string(original.children["check.txt"].data) != "new" {
					t.Fatalf("create %#v %v", out, err)
				}
			} else if err == nil || out != nil || f.links != 0 || f.swaps != 0 || f.mkdirs != 0 {
				t.Fatalf("unbound parent published: %#v %v", out, err)
			}
			if len(f.handles) != 0 {
				t.Fatal("descriptor leak")
			}
		})
	}
}

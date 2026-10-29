//go:build darwin

package filesystem

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Disposable native filesystem: no live profile, process or journal is used.
func TestNativeScratchMutationRejectsDisplacedParent(t *testing.T) {
	for _, displaced := range []bool{false, true} {
		t.Run(strconv.FormatBool(displaced), func(t *testing.T) {
			base, err := os.MkdirTemp("/private/tmp", "farol-scratch-mutation-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(base); err != nil {
					t.Error(err)
				}
			})
			workspace := filepath.Join(base, "workspace")
			if err := os.Mkdir(workspace, 0700); err != nil {
				t.Fatal(err)
			}
			const id = "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(id)
			dir := filepath.Join(workspace, leaf)
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			var rootStat, dirStat unix.Stat_t
			if unix.Lstat(workspace, &rootStat) != nil || unix.Lstat(dir, &dirStat) != nil {
				t.Fatal("fixture stat")
			}
			root := port.Root{Path: workspace, Device: strconv.FormatUint(uint64(rootStat.Dev), 10), Inode: strconv.FormatUint(rootStat.Ino, 10)}
			binding := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: workspace, Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: root.Device, Inode: root.Inode}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: strconv.FormatUint(uint64(dirStat.Dev), 10), Inode: strconv.FormatUint(dirStat.Ino, 10)}}
			request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: workspace, ApprovedRoot: root}, Operation: mutation.Write{RelativePath: leaf + "/check.txt", Content: "test"}, ScratchParent: &binding, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, fn func() error) error {
				if displaced {
					if err := os.Rename(dir, dir+"-held"); err != nil {
						return err
					}
					if err := os.Mkdir(dir, 0700); err != nil {
						return err
					}
				}
				return fn()
			}}
			out, err := NewMutable(base).Mutate(context.Background(), request)
			if !displaced {
				if err != nil || out == nil || !out.ScratchFile.Valid() {
					t.Fatalf("write %#v %v", out, err)
				}
				if b, err := os.ReadFile(filepath.Join(dir, "check.txt")); err != nil || string(b) != "test" {
					t.Fatal("write not visible", err)
				}
				edit := request
				edit.Operation = mutation.Edit{RelativePath: leaf + "/check.txt", ExpectedSHA256: payloadHash([]byte("test")), Edits: []mutation.TextEdit{{OldText: "test", NewText: "updated"}}}
				edit.ScratchExpectedFile = &out.ScratchFile
				edited, err := NewMutable(base).Mutate(context.Background(), edit)
				if err != nil || edited == nil || !edited.ScratchFile.Valid() || edited.ScratchFile == out.ScratchFile {
					t.Fatalf("edit %#v %v", edited, err)
				}
				if b, err := os.ReadFile(filepath.Join(dir, "check.txt")); err != nil || string(b) != "updated" {
					t.Fatal("edit not visible", err)
				}
			} else {
				if err == nil || out != nil {
					t.Fatal("displaced parent admitted")
				}
				for _, path := range []string{dir, dir + "-held"} {
					if _, err := os.Lstat(filepath.Join(path, "check.txt")); !os.IsNotExist(err) {
						t.Fatal("published under displaced parent", err)
					}
				}
			}
		})
	}
}

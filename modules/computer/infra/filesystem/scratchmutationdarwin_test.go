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
			request.HoldScratchFile = true
			out, err := NewMutable(base).Mutate(context.Background(), request)
			if !displaced {
				if err != nil || out == nil || !out.ScratchFile.Valid() || out.ScratchFileHold == nil || out.ScratchFileHold.Check(out.ScratchFile) != nil {
					t.Fatalf("write %#v %v", out, err)
				}
				if b, err := os.ReadFile(filepath.Join(dir, "check.txt")); err != nil || string(b) != "test" {
					t.Fatal("write not visible", err)
				}
				edit := request
				edit.Operation = mutation.Edit{RelativePath: leaf + "/check.txt", ExpectedSHA256: payloadHash([]byte("test")), Edits: []mutation.TextEdit{{OldText: "test", NewText: "updated"}}}
				edit.ScratchExpectedFile = &out.ScratchFile
				edited, err := NewMutable(base).Mutate(context.Background(), edit)
				if err != nil || edited == nil || !edited.ScratchFile.Valid() || edited.ScratchFile == out.ScratchFile || edited.ScratchFileHold == nil || edited.ScratchFileHold.Check(edited.ScratchFile) != nil {
					t.Fatalf("edit %#v %v", edited, err)
				}
				if b, err := os.ReadFile(filepath.Join(dir, "check.txt")); err != nil || string(b) != "updated" {
					t.Fatal("edit not visible", err)
				}
				if err := out.ScratchFileHold.Close(); err != nil {
					t.Fatal(err)
				}
				if err := edited.ScratchFileHold.Close(); err != nil {
					t.Fatal(err)
				}
				if edited.ScratchFileHold.Check(edited.ScratchFile) == nil {
					t.Fatal("closed file descriptor accepted")
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

func TestNativeScratchFileHoldPinsUnlinkedInode(t *testing.T) {
	base, err := os.MkdirTemp("/private/tmp", "farol-file-custody-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(base); err != nil {
			t.Error(err)
		}
	})
	path := filepath.Join(base, "check.txt")
	if err := os.WriteFile(path, []byte("same"), 0600); err != nil {
		t.Fatal(err)
	}
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	fs := darwinMutation{}
	version, err := fs.stat(fd)
	if err != nil {
		_ = unix.Close(fd)
		t.Fatal(err)
	}
	hold, err := fs.holdScratchFile(fd, version)
	if err != nil {
		_ = unix.Close(fd)
		t.Fatal(err)
	}
	if err := unix.Close(fd); err != nil {
		_ = hold.Close()
		t.Fatal(err)
	}
	identity := mutation.DirectoryIdentity{Device: strconv.FormatUint(version.dev, 10), Inode: strconv.FormatUint(version.ino, 10)}
	if err := hold.Check(identity); err != nil {
		_ = hold.Close()
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		_ = hold.Close()
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("same"), 0600); err != nil {
		_ = hold.Close()
		t.Fatal(err)
	}
	var replacement unix.Stat_t
	if err := unix.Lstat(path, &replacement); err != nil || replacement.Ino == version.ino {
		_ = hold.Close()
		t.Fatal("held inode was reused", err)
	}
	if hold.Check(identity) == nil {
		_ = hold.Close()
		t.Fatal("unlinked original accepted as live file")
	}
	if err := hold.Close(); err != nil {
		t.Fatal(err)
	}
}

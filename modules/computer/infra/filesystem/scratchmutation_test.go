package filesystem

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

type testScratchFileHold struct {
	closed   int
	closeErr error
}

func (h *testScratchFileHold) Check(mutation.DirectoryIdentity) error {
	if h.closed != 0 {
		return errors.New("custody closed")
	}
	return nil
}
func (h *testScratchFileHold) Close() error { h.closed++; return h.closeErr }

type testHeldMutation struct {
	mutationFS
	hold *testScratchFileHold
}

func (h testHeldMutation) holdScratchFile(int, fileVersion) (port.ScratchFileCustody, error) {
	return h.hold, nil
}

func TestScratchMutationLostPublicationClosesOriginalFileHold(t *testing.T) {
	m, f := fakeMutable()
	hold := &testScratchFileHold{}
	m.fs = testHeldMutation{mutationFS: f, hold: hold}
	id := "00000000-0000-4000-8000-000000000001"
	leaf := mutation.ScratchPath(id)
	dir := f.directory(0700)
	f.work.children[leaf] = dir
	b := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: "7", Inode: strconv.FormatUint(dir.v.ino, 10)}}
	r := fakeRequest(mutation.Write{RelativePath: leaf + "/check.txt", Content: "new"})
	r.ScratchDirectoryHold = &testScratchFileHold{}
	r.HoldScratchFile = true
	r.WithPublication = func(_ context.Context, publish func() error) error {
		if err := publish(); err != nil {
			return err
		}
		return errors.New("lost acknowledgement")
	}
	out, err := m.MutateScratch(context.Background(), r, b)
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	if out != nil || f.links != 1 || hold.closed != 1 {
		t.Fatal("lost publication leaked or repeated its original hold", out, f.links, hold.closed)
	}
}

func TestScratchMutationUnconfirmedHoldClosePreservesCandidate(t *testing.T) {
	m, f := fakeMutable()
	hold := &testScratchFileHold{closeErr: errors.New("unconfirmed close")}
	m.fs = testHeldMutation{mutationFS: f, hold: hold}
	id := "00000000-0000-4000-8000-000000000001"
	leaf := mutation.ScratchPath(id)
	dir := f.directory(0700)
	f.work.children[leaf] = dir
	b := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: "7", Inode: strconv.FormatUint(dir.v.ino, 10)}}
	r := fakeRequest(mutation.Write{RelativePath: leaf + "/check.txt", Content: "new"})
	r.ScratchDirectoryHold = &testScratchFileHold{}
	r.HoldScratchFile = true
	r.WithPublication = func(context.Context, func() error) error { return errors.New("guard refusal") }
	out, err := m.MutateScratch(context.Background(), r, b)
	nativeCode(t, err, "WORKSPACE_MUTATION_OUTCOME_UNKNOWN")
	stage := dir.children[".farol-mutation-0123456789abcdef"]
	if out != nil || hold.closed != 1 || f.unlinks != 0 || stage == nil || stage.children["candidate"] == nil {
		t.Fatal("uncertain close allowed cleanup", out, hold.closed, f.unlinks)
	}
}

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
			r.ScratchDirectoryHold = &testScratchFileHold{}
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

func TestScratchMutationEditRequiresOriginalFileIdentity(t *testing.T) {
	for _, replaced := range []bool{false, true} {
		t.Run(strconv.FormatBool(replaced), func(t *testing.T) {
			m, f := fakeMutable()
			id := "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(id)
			dir := f.directory(0700)
			f.work.children[leaf] = dir
			b := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: "7", Inode: strconv.FormatUint(dir.v.ino, 10)}}
			path := leaf + "/check.txt"
			create := fakeRequest(mutation.Write{RelativePath: path, Content: "old"})
			create.ScratchDirectoryHold = &testScratchFileHold{}
			created, err := m.MutateScratch(context.Background(), create, b)
			if err != nil || created == nil || !created.ScratchFile.Valid() {
				t.Fatalf("creation %#v %v", created, err)
			}
			if replaced {
				dir.children["check.txt"] = f.file("old")
			}
			request := fakeRequest(mutation.Edit{RelativePath: path, ExpectedSHA256: payloadHash([]byte("old")), Edits: []mutation.TextEdit{{OldText: "old", NewText: "new"}}})
			request.ScratchExpectedFile = &created.ScratchFile
			request.ScratchDirectoryHold = create.ScratchDirectoryHold
			request.ScratchPreviousFile = &testScratchFileHold{}
			result, err := m.MutateScratch(context.Background(), request, b)
			if replaced {
				if err == nil || result != nil || string(dir.children["check.txt"].data) != "old" || f.swaps != 0 {
					t.Fatal("same-content replacement edited")
				}
			} else if err != nil || result == nil || !result.ScratchFile.Valid() || result.ScratchFile == created.ScratchFile || string(dir.children["check.txt"].data) != "new" {
				t.Fatalf("edit %#v %v", result, err)
			}
		})
	}
}

func TestScratchMutationRejectsLostCustodyBeforePublication(t *testing.T) {
	for _, mode := range []string{"missing directory", "closed directory", "closed file"} {
		t.Run(mode, func(t *testing.T) {
			m, f := fakeMutable()
			id := "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(id)
			dir := f.directory(0700)
			f.work.children[leaf] = dir
			b := mutation.ScratchCleanupBinding{Creation: mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: "/work", Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: "7", Inode: "2"}, ExpectedInventory: mutation.EmptyScratchInventory}}, Directory: mutation.DirectoryIdentity{Device: "7", Inode: strconv.FormatUint(dir.v.ino, 10)}}
			directory := &testScratchFileHold{}
			create := fakeRequest(mutation.Write{RelativePath: leaf + "/check.txt", Content: "old"})
			create.ScratchDirectoryHold = directory
			if mode == "missing directory" {
				create.ScratchDirectoryHold = nil
				if out, err := m.MutateScratch(context.Background(), create, b); err == nil || out != nil || f.links != 0 {
					t.Fatal("missing custody admitted")
				}
				return
			}
			if mode == "closed directory" {
				create.WithPublication = func(_ context.Context, publish func() error) error {
					_ = directory.Close()
					return publish()
				}
				if out, err := m.MutateScratch(context.Background(), create, b); err == nil || out != nil || f.links != 0 {
					t.Fatal("lost directory custody admitted")
				}
				return
			}
			created, err := m.MutateScratch(context.Background(), create, b)
			if err != nil {
				t.Fatal(err)
			}
			file := &testScratchFileHold{}
			edit := fakeRequest(mutation.Edit{RelativePath: leaf + "/check.txt", ExpectedSHA256: payloadHash([]byte("old")), Edits: []mutation.TextEdit{{OldText: "old", NewText: "new"}}})
			edit.ScratchDirectoryHold, edit.ScratchPreviousFile, edit.ScratchExpectedFile = directory, file, &created.ScratchFile
			edit.WithPublication = func(_ context.Context, publish func() error) error { _ = file.Close(); return publish() }
			if out, err := m.MutateScratch(context.Background(), edit, b); err == nil || out != nil || f.swaps != 0 || string(dir.children["check.txt"].data) != "old" {
				t.Fatal("lost file custody admitted")
			}
		})
	}
}

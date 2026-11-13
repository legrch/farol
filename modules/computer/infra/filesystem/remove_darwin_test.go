//go:build darwin

package filesystem

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Disposable native filesystem; no live profile, journal, or process fence.
func TestNativeScratchFileCleanupOneShot(t *testing.T) {
	for _, mode := range []string{"success", "foreign", "changed", "replaced", "directory_replaced", "custody_lost", "lost_first_ack", "duplicate_guard", "refused_second_guard", "foreign_after_unlink", "sync_failed", "close_failed"} {
		t.Run(mode, func(t *testing.T) {
			base, err := os.MkdirTemp("/private/tmp", "farol-file-cleanup-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(base); err != nil {
					t.Error(err)
				}
			})
			workspace := filepath.Join(base, "work")
			if err := os.Mkdir(workspace, 0700); err != nil {
				t.Fatal(err)
			}
			const id = "00000000-0000-4000-8000-000000000001"
			leaf := mutation.ScratchPath(id)
			dir := filepath.Join(workspace, leaf)
			if err := os.Mkdir(dir, 0700); err != nil {
				t.Fatal(err)
			}
			filePath := filepath.Join(dir, "check.txt")
			if err := os.WriteFile(filePath, []byte("test"), 0600); err != nil {
				t.Fatal(err)
			}
			var rootStat, dirStat, fileStat unix.Stat_t
			if unix.Lstat(workspace, &rootStat) != nil || unix.Lstat(dir, &dirStat) != nil || unix.Lstat(filePath, &fileStat) != nil {
				t.Fatal("fixture stat")
			}
			ident := func(s unix.Stat_t) mutation.DirectoryIdentity {
				return mutation.DirectoryIdentity{Device: strconv.FormatUint(uint64(s.Dev), 10), Inode: strconv.FormatUint(s.Ino, 10)}
			}
			rootID, dirID, fileID := ident(rootStat), ident(dirStat), ident(fileStat)
			root := port.Root{Path: workspace, Device: rootID.Device, Inode: rootID.Inode}
			creation := mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, ComputerGeneration: 7, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: workspace, Leaf: leaf, RootIdentity: rootID, ExpectedInventory: mutation.EmptyScratchInventory}}
			fileBinding := mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeConnector, OperationID: "file-op", OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, ComputerGeneration: 7, WorkspaceID: "work", RelativePath: leaf + "/check.txt", RequestDigest: strings.Repeat("b", 64), Connector: mutation.ConnectorOrigin{BuildID: "build", BackendGeneration: "backend", RuntimeID: "runtime", ConnectorGeneration: 2, SessionID: "session", TaskID: "task", ParticipantID: "participant", TurnID: "turn", CallID: "call", TaskEpoch: 3, Generation: 4, Operation: mutation.WriteKind}}
			inventory := mutation.ScratchFileInventory{Creation: mutation.ScratchCleanupBinding{Creation: creation, Directory: dirID}, Mutation: fileBinding, File: fileID, SHA256: payloadHash([]byte("test"))}
			if !inventory.Valid() {
				t.Fatal("invalid fixture inventory")
			}
			dfd, err := unix.Open(dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			dirHold := &scratchDirectoryCustody{fd: dfd, identity: dirID, uid: uint32(os.Getuid())}
			t.Cleanup(func() { _ = dirHold.Close() })
			ffd, err := unix.Open(filePath, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			fileHold := &scratchFileCustody{fd: ffd, identity: fileID, uid: uint32(os.Getuid())}
			t.Cleanup(func() { _ = fileHold.Close() })
			if mode == "foreign" {
				if err := os.WriteFile(filepath.Join(dir, "foreign"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if mode == "changed" {
				if err := os.WriteFile(filePath, []byte("changed"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			calls := 0
			req := port.ScratchFileCleanupRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: workspace, ApprovedRoot: root}, Inventory: inventory, DirectoryHold: dirHold, FileHold: fileHold, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, fn func() error) error {
				calls++
				if mode == "refused_second_guard" && calls == 2 {
					return errors.New("refused")
				}
				if mode == "replaced" && calls == 1 {
					if err := os.Rename(filePath, filePath+"-held"); err != nil {
						return err
					}
					if err := os.WriteFile(filePath, []byte("test"), 0600); err != nil {
						return err
					}
				}
				if mode == "directory_replaced" && calls == 1 {
					if err := os.Rename(dir, dir+"-held"); err != nil {
						return err
					}
					if err := os.Mkdir(dir, 0700); err != nil {
						return err
					}
					if err := os.WriteFile(filePath, []byte("test"), 0600); err != nil {
						return err
					}
				}
				if mode == "custody_lost" && calls == 1 {
					_ = fileHold.Close()
				}
				if mode == "foreign_after_unlink" && calls == 2 {
					if err := os.WriteFile(filepath.Join(dir, "foreign"), []byte("keep"), 0600); err != nil {
						return err
					}
				}
				err := fn()
				if mode == "duplicate_guard" && calls == 1 {
					_ = fn()
				}
				if mode == "lost_first_ack" && calls == 1 {
					return errors.New("lost acknowledgement")
				}
				return err
			}}
			native := NewMutable(base)
			if mode == "sync_failed" {
				native.fs = cleanupSyncFailure{native.fs}
			}
			if mode == "close_failed" {
				native.fs = cleanupCloseFailure{native.fs}
			}
			err = native.RemoveScratchFile(context.Background(), req)
			_, dirErr := os.Lstat(dir)
			switch mode {
			case "success":
				if err != nil || !errors.Is(dirErr, os.ErrNotExist) || calls != 2 {
					t.Fatal("cleanup", err, dirErr, calls)
				}
			case "close_failed":
				var f *authority.Failure
				if !errors.As(err, &f) || f.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || !errors.Is(dirErr, os.ErrNotExist) {
					t.Fatal("lost close not unknown", err, dirErr)
				}
			case "lost_first_ack", "duplicate_guard", "refused_second_guard", "foreign_after_unlink", "sync_failed":
				var f *authority.Failure
				if !errors.As(err, &f) || f.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || dirErr != nil {
					t.Fatal("partial result not unknown", err, dirErr)
				}
			default:
				if err == nil || dirErr != nil {
					t.Fatal("refusal deleted directory", err, dirErr)
				}
				if _, err := os.Lstat(filePath); err != nil {
					t.Fatal("refusal deleted named file", err)
				}
			}
		})
	}
}

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

type cleanupSyncFailure struct{ mutationFS }

func (cleanupSyncFailure) sync(int) error            { return errors.New("lost sync") }
func (cleanupSyncFailure) closeChecked(fd int) error { return unix.Close(fd) }

type cleanupCloseFailure struct{ mutationFS }

func (cleanupCloseFailure) closeChecked(fd int) error {
	return errors.Join(unix.Close(fd), errors.New("lost close"))
}

// Disposable native filesystem only. It does not qualify the journal, live
// process fence or concurrent same-UID adversaries.
func TestNativeEmptyScratchCleanupOneShot(t *testing.T) {
	for _, name := range []string{"success", "nonempty", "wrong_inode", "wrong_workspace", "wrong_root", "symlink", "authority_refused", "guard_refused", "replaced_before_guard", "lost_ack", "duplicate_guard", "cancel_after", "sync_failed", "close_failed"} {
		t.Run(name, func(t *testing.T) {
			base, err := os.MkdirTemp("/private/tmp", "farol-cleanup-")
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
			child := filepath.Join(workspace, leaf)
			if err := os.Mkdir(child, 0700); err != nil {
				t.Fatal(err)
			}
			var rootStat, childStat unix.Stat_t
			if unix.Lstat(workspace, &rootStat) != nil || unix.Lstat(child, &childStat) != nil {
				t.Fatal("fixture stat")
			}
			root := port.Root{Path: workspace, Device: strconv.FormatUint(uint64(rootStat.Dev), 10), Inode: strconv.FormatUint(rootStat.Ino, 10)}
			binding := mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: id, OwnerID: "owner", ProfileID: "profile", ComputerID: "computer"}, WorkspaceID: "work", RequestDigest: strings.Repeat("a", 64), RelativePath: leaf, Scratch: mutation.ScratchBinding{RunID: id, Root: workspace, Leaf: leaf, RootIdentity: mutation.DirectoryIdentity{Device: root.Device, Inode: root.Inode}, ExpectedInventory: mutation.EmptyScratchInventory}}
			selected := mutation.ScratchCleanupBinding{Creation: binding, Directory: mutation.DirectoryIdentity{Device: strconv.FormatUint(uint64(childStat.Dev), 10), Inode: strconv.FormatUint(childStat.Ino, 10)}}
			if name == "nonempty" {
				if err := os.WriteFile(filepath.Join(child, "foreign"), []byte("keep"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if name == "wrong_inode" {
				selected.Directory.Inode = "999999"
			}
			if name == "symlink" {
				if err := os.Rename(child, child+"-held"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(child+"-held", child); err != nil {
					t.Fatal(err)
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			req := port.ScratchCleanupRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: workspace, ApprovedRoot: root}, Binding: selected, BeforePublish: func(context.Context) error {
				if name == "authority_refused" {
					return errors.New("authority withdrawn")
				}
				return nil
			}, WithPublication: func(_ context.Context, fn func() error) error {
				calls++
				if name == "guard_refused" {
					return errors.New("refused before callback")
				}
				if name == "replaced_before_guard" {
					if err := os.Rename(child, child+"-held"); err != nil {
						return err
					}
					if err := os.Mkdir(child, 0700); err != nil {
						return err
					}
				}
				err := fn()
				if name == "duplicate_guard" {
					_ = fn()
				}
				if name == "cancel_after" {
					cancel()
				}
				if name == "lost_ack" {
					return errors.New("lost acknowledgement")
				}
				return err
			}}
			if name == "wrong_workspace" {
				req.Workspace.WorkspaceID = "other"
			}
			if name == "wrong_root" {
				req.Workspace.ApprovedRoot.Inode = "999999"
			}
			native := NewMutable(base)
			if name == "sync_failed" {
				native.fs = cleanupSyncFailure{native.fs}
			}
			if name == "close_failed" {
				native.fs = cleanupCloseFailure{native.fs}
			}
			err = native.RemoveEmptyScratch(ctx, req)
			_, statErr := os.Lstat(child)
			switch name {
			case "success":
				if err != nil || !errors.Is(statErr, os.ErrNotExist) || calls != 1 {
					t.Fatal("cleanup failed", err, statErr, calls)
				}
			case "lost_ack", "duplicate_guard", "cancel_after", "sync_failed", "close_failed":
				var failure *authority.Failure
				if !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || !errors.Is(statErr, os.ErrNotExist) || calls != 1 {
					t.Fatal("unknown cleanup lost", err, statErr, calls)
				}
			default:
				if err == nil || statErr != nil {
					t.Fatal("refusal changed selected name", err, statErr)
				}
			}
		})
	}
}

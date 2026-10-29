//go:build darwin

package filesystem

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

type scratchSyncMutation struct {
	mutationFS
	destination fileVersion
	afterSync   func() error
}

func (m scratchSyncMutation) sync(fd int) error {
	if err := m.mutationFS.sync(fd); err != nil {
		return err
	}
	v, err := m.mutationFS.stat(fd)
	if err != nil {
		return err
	}
	if v.inode(m.destination) {
		return m.afterSync()
	}
	return nil
}

// Disposable native filesystem only. Same-account adversarial processes and
// the full owner, journal, shell and desktop lifecycle are outside this test.
func TestNativeStagedScratchPublicationAndRefusal(t *testing.T) {
	for _, name := range []string{"publish", "collision", "guard_refused", "wrong_stage", "wrong_root", "source_replaced", "published_replaced", "cancel_after_publish", "replaced_after_sync", "cancel_after_sync"} {
		t.Run(name, func(t *testing.T) {
			base, err := os.MkdirTemp("/private/tmp", "farol-scratch-")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				if err := os.RemoveAll(base); err != nil {
					t.Error(err)
				}
			})
			stagePath, workspace := filepath.Join(base, "stage"), filepath.Join(base, "workspace")
			for _, path := range []string{stagePath, workspace} {
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			var stageStat, wsStat unix.Stat_t
			if err := unix.Lstat(stagePath, &stageStat); err != nil {
				t.Fatal(err)
			}
			if err := unix.Lstat(workspace, &wsStat); err != nil {
				t.Fatal(err)
			}
			stageFD, err := unix.Open(stagePath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer unix.Close(stageFD)
			root := port.Root{Path: workspace, Device: strconv.FormatUint(uint64(wsStat.Dev), 10), Inode: strconv.FormatUint(wsStat.Ino, 10)}
			stage := port.Root{Path: stagePath, Device: strconv.FormatUint(uint64(stageStat.Dev), 10), Inode: strconv.FormatUint(stageStat.Ino, 10)}
			id := "00000000-0000-4000-8000-000000000001"
			op := mutation.Scratch{Binding: mutation.ScratchBinding{RunID: id, Root: workspace, Leaf: mutation.ScratchPath(id), RootIdentity: mutation.DirectoryIdentity{Device: root.Device, Inode: root.Inode}, ExpectedInventory: mutation.EmptyScratchInventory}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			guards, checks := 0, 0
			r := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: workspace, ApprovedRoot: root}, Operation: op, BeforePublish: func(context.Context) error {
				checks++
				if name == "source_replaced" && checks == 2 {
					entries, err := os.ReadDir(stagePath)
					if err != nil || len(entries) != 1 {
						return errors.New("candidate unavailable")
					}
					path := filepath.Join(stagePath, entries[0].Name())
					if err := os.Rename(path, path+"-held"); err != nil {
						return err
					}
					if err := os.Mkdir(path, 0700); err != nil {
						return err
					}
				}
				return nil
			}, WithPublication: func(_ context.Context, f func() error) error {
				guards++
				if name == "guard_refused" {
					return errors.New("guard refused")
				}
				err := f()
				if err != nil {
					return err
				}
				if name == "cancel_after_publish" {
					cancel()
				}
				if name == "published_replaced" {
					path := filepath.Join(workspace, op.Path())
					if err := os.Rename(path, path+"-held"); err != nil {
						return err
					}
					if err := os.Mkdir(path, 0700); err != nil {
						return err
					}
				}
				return nil
			}}
			if name == "collision" {
				if err := os.Mkdir(filepath.Join(workspace, op.Path()), 0700); err != nil {
					t.Fatal(err)
				}
			}
			if name == "wrong_stage" {
				stage.Inode = "999999"
			}
			if name == "wrong_root" {
				r.Workspace.ApprovedRoot.Inode = "999999"
			}
			native := NewMutable(base)
			if name == "replaced_after_sync" || name == "cancel_after_sync" {
				native.fs = scratchSyncMutation{mutationFS: native.fs, destination: fileVersion{dev: uint64(wsStat.Dev), ino: wsStat.Ino}, afterSync: func() error {
					if name == "cancel_after_sync" {
						cancel()
						return nil
					}
					path := filepath.Join(workspace, op.Path())
					if err := os.Rename(path, path+"-held"); err != nil {
						return err
					}
					return os.Mkdir(path, 0700)
				}}
			}
			result, err := native.CreateStagedScratch(ctx, r, stageFD, stage)
			entries, listErr := os.ReadDir(stagePath)
			if listErr != nil {
				t.Fatal(listErr)
			}
			switch name {
			case "publish":
				if err != nil || result == nil || !result.Directory.Valid() || guards != 1 || len(entries) != 0 {
					t.Fatalf("publication: %#v %v guards=%d stage=%d", result, err, guards, len(entries))
				}
				var got unix.Stat_t
				if err := unix.Lstat(filepath.Join(workspace, op.Path()), &got); err != nil || result.Directory.Device != strconv.FormatUint(uint64(got.Dev), 10) || result.Directory.Inode != strconv.FormatUint(got.Ino, 10) {
					t.Fatalf("identity: %#v %v", got, err)
				}
			case "wrong_stage", "wrong_root":
				if err == nil || result != nil || guards != 0 || len(entries) != 0 {
					t.Fatalf("invalid identity admitted: %#v %v", result, err)
				}
			case "collision":
				if err == nil || result != nil || guards != 0 || len(entries) != 0 {
					t.Fatalf("collision: %#v %v guards=%d stage=%d", result, err, guards, len(entries))
				}
			case "published_replaced", "cancel_after_publish", "replaced_after_sync", "cancel_after_sync":
				var failure *authority.Failure
				if !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || result == nil || !result.Directory.Valid() || guards != 1 {
					t.Fatalf("post-publication outcome: %#v %v guards=%d", result, err, guards)
				}
			case "source_replaced":
				var failure *authority.Failure
				if !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || result == nil || guards != 1 || len(entries) != 2 {
					t.Fatalf("replacement: %#v %v guards=%d stage=%d", result, err, guards, len(entries))
				}
				if _, err := os.Lstat(filepath.Join(workspace, op.Path())); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("replacement published: %v", err)
				}
			case "guard_refused":
				var failure *authority.Failure
				if !errors.As(err, &failure) || failure.Code != "WORKSPACE_MUTATION_OUTCOME_UNKNOWN" || result == nil || !result.Directory.Valid() || guards != 1 || len(entries) != 1 {
					t.Fatalf("guard: %#v %v guards=%d stage=%d", result, err, guards, len(entries))
				}
				if _, err := os.Lstat(filepath.Join(workspace, op.Path())); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("unexpected publication: %v", err)
				}
			}
		})
	}
}

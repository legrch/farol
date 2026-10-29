//go:build darwin

package boot

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/domain/mutation"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
	"golang.org/x/sys/unix"
)

// Real filesystem producer with an injected native lease. This does not prove
// a real profile qualification, journal, Shell, Electron or provider flow.
func TestNativeStagedWorkspaceRetainsGateUntilRelease(t *testing.T) {
	base, err := os.MkdirTemp("/private/tmp", "farol-stage-workspace-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if t.Failed() {
			t.Log("retained fixture", base)
			return
		}
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
	fd, err := unix.Open(stagePath, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	root := port.Root{Path: workspace, Device: strconv.FormatUint(uint64(wsStat.Dev), 10), Inode: strconv.FormatUint(wsStat.Ino, 10)}
	id := "00000000-0000-4000-8000-000000000001"
	binding := mutation.ScratchBinding{RunID: id, Root: workspace, Leaf: mutation.ScratchPath(id), RootIdentity: mutation.DirectoryIdentity{Device: root.Device, Inode: root.Inode}, ExpectedInventory: mutation.EmptyScratchInventory}
	ledger := &SettingsMutationIngress{stageBaseline: true, stageOwner: &computerStageOwner{}, stageLifetime: context.Background(), operations: map[string]*settingsMutationOperation{id: {workspace: "work", path: binding.Leaf, pending: true, stageScratch: true}}}
	w := &stagedScratchWorkspace{ledger: ledger, operation: id, native: filesystem.NewMutable(base)}
	request := port.MutationRequest{Workspace: port.MutationDescriptor{WorkspaceID: "work", Root: workspace, ApprovedRoot: root}, Operation: mutation.Scratch{Binding: binding}, BeforePublish: func(context.Context) error { return nil }, WithPublication: func(_ context.Context, publish func() error) error { return publish() }}
	selected, err := w.BeginStage(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	attempt := selected.(*stagedScratchAttempt)
	attempt.lease.runNative = func(ctx context.Context, use func(context.Context, int, NativeRoot) error) error {
		return use(ctx, fd, NativeRoot{Path: stagePath, Device: uint64(stageStat.Dev), Inode: stageStat.Ino})
	}
	result, err := attempt.Execute(context.Background())
	if err != nil || result == nil || !result.Directory.Valid() {
		t.Fatalf("publication: %#v %v", result, err)
	}
	ledger.mu.Lock()
	pending := ledger.stagePending
	ledger.mu.Unlock()
	if !pending {
		t.Fatal("gate released before terminal publication")
	}
	if _, err := attempt.Execute(context.Background()); err == nil {
		t.Fatal("native operation repeated")
	}
	attempt.Release()
	ledger.mu.Lock()
	pending = ledger.stagePending
	ledger.mu.Unlock()
	if pending {
		t.Fatal("gate not released")
	}
}

//go:build darwin

package boot

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	mutation "github.com/legrch/farol/modules/computer/domain/mutation"
	"golang.org/x/sys/unix"
)

// Actual native stores and filesystem. The old owner is closed without a clean
// handoff, with a real prepared/unknown journal record but no workspace effect.
// This does not establish process death, arbitrary descendant closure, Electron
// selection or permission to replay any old operation.
func recoveryNativeFixture(t *testing.T) (NativeLaunch, string, mutation.Binding) {
	t.Helper()
	launch, old := retirementStorageFixture(t, true)
	workspace := filepath.Join(launch.Profile.Root, "workspace")
	if err := os.Mkdir(workspace, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "note.md"), []byte("retained native recovery text\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, "untouched.txt"), []byte("unrequested recovery canary\n"), 0600); err != nil {
		t.Fatal(err)
	}
	nativeSettingsPublication(t, old, workspace, 1)
	binding := mutation.Binding{Identity: mutation.Identity{Scope: mutation.ScopeOwnerSettings, OperationID: "unknown-write", OwnerID: launch.OwnerID, ProfileID: launch.Profile.ProfileID, ComputerID: launch.ComputerID}, ComputerGeneration: 1, WorkspaceID: "00000000-0000-4000-8000-000000000004", RelativePath: "note.md", RequestDigest: strings.Repeat("a", 64)}
	prepared, err := mutation.NewPrepared(binding)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.mutationStore.Admit(context.Background(), prepared); err != nil {
		t.Fatal(err)
	}
	uncertain, err := prepared.Refuse(mutation.Failure{Code: "WORKSPACE_MUTATION_OUTCOME_UNKNOWN", Source: "operation-store"})
	if err != nil {
		t.Fatal(err)
	}
	if err = old.mutationStore.Save(context.Background(), uncertain); err != nil {
		t.Fatal(err)
	}
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	launch.StoreMode = "open"
	launch.SettingsMutations = false
	launch.HostLifetimeID, launch.ChildLaunchID = "recovery-host", "recovery-child"
	return launch, workspace, binding
}

func recoverySnapshot(t *testing.T, root string) map[string]string {
	t.Helper()
	out := map[string]string{}
	for _, name := range []string{"chat", "task", filepath.Join("computer", "mutations"), "workspace"} {
		if name == "workspace" {
			if _, err := os.Lstat(filepath.Join(root, name)); os.IsNotExist(err) {
				out[name] = "absent"
				continue
			} else if err != nil {
				t.Fatal(err)
			}
		}
		err := filepath.WalkDir(filepath.Join(root, name), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() && name != "workspace" {
				return nil
			}
			var data []byte
			if entry.Type().IsRegular() {
				data, err = os.ReadFile(path)
				if err != nil {
					return err
				}
			} else if !entry.IsDir() {
				return fmt.Errorf("unexpected non-regular recovery fixture: %s", path)
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			// Reads may update access time; content, identity and change times must stay intact.
			var physical unix.Stat_t
			if err := unix.Lstat(path, &physical); err != nil {
				return err
			}
			out[strings.TrimPrefix(path, root)] = fmt.Sprintf("%o:%d:%d:%d:%d:%d:%d:%v:%v:%s", info.Mode(), physical.Dev, physical.Ino, physical.Uid, physical.Gid, physical.Nlink, physical.Size, physical.Mtim, physical.Ctim, data)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return out
}

//go:build darwin && farol_native_root_scoped

package boot

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/legrch/farol/modules/computer/app/port"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// Explicit local filesystem test only. No child, lease, app profile, sandbox or
// release qualification. Successful cleanup removes only this known empty test
// directory; failures retain it. Production cannot infer this cleanup safety.
func TestNativeConnectorShellScratch(t *testing.T) {
	scratch, err := newConnectorShellScratch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("fresh synthetic scratch: %s device=%s inode=%s", scratch.path, scratch.identity.Device, scratch.identity.Inode)
	t.Cleanup(func() {
		if !t.Failed() {
			if err := os.Remove(scratch.path); err != nil {
				t.Error("could not remove original empty test directory", err)
			}
		}
	})
	if filepath.Dir(scratch.path) != "/private/tmp" || !strings.HasPrefix(filepath.Base(scratch.path), "farol-shell-") {
		t.Fatal("scratch outside the compiler's fixed class")
	}
	selected := port.Root{Path: scratch.path, Device: scratch.identity.Device, Inode: scratch.identity.Inode}
	observed, err := filesystem.ObserveRoot(context.Background(), selected)
	if err != nil || observed != selected {
		t.Fatal("original physical root not retained", err)
	}
	info, err := os.Lstat(scratch.path)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		t.Fatal("scratch mode not private", err)
	}
}

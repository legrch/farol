//go:build darwin && farol_native_process_observer

package process

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/legrch/farol/modules/computer/app/port"
	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
	"github.com/legrch/farol/modules/computer/infra/filesystem"
)

// Explicit root-observation native lane only. Every filesystem path is inside
// this test's private disposable directory. No executable, sandbox, child,
// app/profile, provider, package, network, grant or execution lease is touched.
func nativeObservationFixture(t *testing.T) (processsvc.ObservedWorkspace, *WorkspaceObservation) {
	t.Helper()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	container := filepath.Join(base, "container")
	root := filepath.Join(container, "root")
	if err := os.Mkdir(container, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(root)
	if err != nil {
		t.Fatal(err)
	}
	id, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("root identity unavailable")
	}
	selected := processsvc.ObservedWorkspace{WorkspaceID: "disposable", Root: root, RootIdentity: authority.RootIdentity{Device: strconv.FormatUint(uint64(id.Dev), 10), Inode: strconv.FormatUint(id.Ino, 10)}}
	w, err := NewObservationWorkspace(selected)
	if err != nil {
		t.Fatal(err)
	}
	return selected, w
}

func TestNativeProcessObservationCurrentReopensEveryCall(t *testing.T) {
	selected, w := nativeObservationFixture(t)
	for i := 0; i < 3; i++ {
		out, err := w.ObserveWorkspace(context.Background())
		if err != nil || out == nil || *out != selected {
			t.Fatal("fixed original root refused", out, err)
		}
		out.Root = "/changed-return-value"
		out.RootIdentity.Inode = "0"
	}
}

func TestNativeProcessObservationChangedRootBetweenCalls(t *testing.T) {
	for _, mode := range []string{"replacement", "root-link", "ancestor-link", "regular-file", "fifo", "missing", "group-writable"} {
		t.Run(mode, func(t *testing.T) {
			selected, w := nativeObservationFixture(t)
			if out, err := w.ObserveWorkspace(context.Background()); err != nil || out == nil {
				t.Fatal("initial observation unavailable", err)
			}
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			root, held := selected.Root, selected.Root+"-original"
			switch mode {
			case "ancestor-link":
				parent := filepath.Dir(root)
				must(os.Rename(parent, parent+"-original"))
				must(os.Symlink(parent+"-original", parent))
			case "group-writable":
				must(os.Chmod(root, 0770))
			default:
				// Preserve the old inode so replacement cannot reuse it.
				must(os.Rename(root, held))
				switch mode {
				case "replacement":
					must(os.Mkdir(root, 0700))
				case "root-link":
					// Target is the SAME original inode; link traversal must fail.
					must(os.Symlink(held, root))
				case "regular-file":
					must(os.WriteFile(root, []byte("disposable text; never execute"), 0600))
				case "fifo":
					must(syscall.Mkfifo(root, 0600))
				}
			}
			out, err := w.ObserveWorkspace(context.Background())
			if out != nil || err == nil || w.selected != selected {
				t.Fatal("changed root accepted or refreshed original identity", out, err)
			}
		})
	}
}

// Err is a deterministic native fault point in this TEST context only. It
// replaces the named root after the first open/stat and before final recheck.
type replacingObservationContext struct {
	context.Context
	checks, replaceAt int
	replace           func()
}

func (c *replacingObservationContext) Err() error {
	c.checks++
	if c.checks == c.replaceAt {
		c.replace()
	}
	return c.Context.Err()
}

func TestNativeProcessObservationRootReplacementDuringObservation(t *testing.T) {
	for _, entry := range []string{"helper", "producer"} {
		for _, mode := range []string{"replacement", "link"} {
			t.Run(entry+"/"+mode, func(t *testing.T) {
				selected, w := nativeObservationFixture(t)
				ctx := &replacingObservationContext{Context: context.Background(), replaceAt: 2}
				if entry == "producer" {
					// Producer has one cancellation check before helper entry;
					// the helper's second Err call is therefore the third overall.
					ctx.replaceAt = 3
				}
				ctx.replace = func() {
					if err := os.Rename(selected.Root, selected.Root+"-original"); err != nil {
						t.Fatal(err)
					}
					var err error
					if mode == "replacement" {
						err = os.Mkdir(selected.Root, 0700)
					} else {
						err = os.Symlink(selected.Root+"-original", selected.Root)
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				if entry == "helper" {
					out, err := filesystem.ObserveRoot(ctx, port.Root{Path: selected.Root, Device: selected.RootIdentity.Device, Inode: selected.RootIdentity.Inode})
					if err == nil || out != (port.Root{}) {
						t.Fatal("helper final root recheck missed replacement", out, err)
					}
				} else if out, err := w.ObserveWorkspace(ctx); err == nil || out != nil {
					t.Fatal("producer disclosed a replaced root", out, err)
				}
				if ctx.checks != ctx.replaceAt || w.selected != selected {
					t.Fatal("fault did not occur before final recheck, or identity refreshed", ctx.checks)
				}
			})
		}
	}
}

func TestNativeProcessObservationOwnerChange(t *testing.T) {
	// No elevation or foreign fixture access is attempted. A normal-user lane
	// must report this case SKIP, not owner-change qualification PASS.
	if os.Geteuid() != 0 {
		t.Skip("changing a disposable root UID requires a separately privileged lane")
	}
	selected, w := nativeObservationFixture(t)
	originalUID := os.Getuid()
	if err := os.Chown(selected.Root, originalUID+1, -1); err != nil {
		t.Fatal("disposable root ownership change unavailable", err)
	}
	defer func() {
		if err := os.Chown(selected.Root, originalUID, -1); err != nil {
			t.Error("disposable root ownership restoration failed", err)
		}
	}()
	if out, err := w.ObserveWorkspace(context.Background()); err == nil || out != nil {
		t.Fatal("changed root owner accepted", out, err)
	}
}

func TestNativeProcessObservationAfterUnrelatedExecutionExpiry(t *testing.T) {
	selected, w := nativeObservationFixture(t)
	// This represents an already expired execution context. The producer has
	// no execution input or lease to preserve/renew and observes with read ctx.
	execution, cancel := context.WithDeadline(context.Background(), time.Unix(1, 0))
	defer cancel()
	if execution.Err() != context.DeadlineExceeded {
		t.Fatal("fixture execution context did not expire")
	}
	if out, err := w.ObserveWorkspace(context.Background()); err != nil || out == nil || *out != selected {
		t.Fatal("fresh root observation inherited execution expiry", out, err)
	}
	if execution.Err() != context.DeadlineExceeded {
		t.Fatal("root observation renewed execution")
	}
}

func TestNativeProcessObservationCancelledReadContext(t *testing.T) {
	_, w := nativeObservationFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if out, err := w.ObserveWorkspace(ctx); err == nil || out != nil {
		t.Fatal("cancelled observation accepted", out, err)
	}
}

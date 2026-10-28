//go:build darwin

package process

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	processsvc "github.com/legrch/farol/modules/computer/app/services/process"
	"github.com/legrch/farol/modules/computer/domain/authority"
)

// CPU doubles only, including the Darwin descriptor verifier below. These tests
// open no files, launch no commands, and prove no native/platform enforcement.
func retainedMeasurementFixture(t *testing.T, ctx context.Context) (*retainedLaunchMeasurement, Command, *confinedLaunch, *measurementFilesystemDouble) {
	t.Helper()
	_, command, launch, fs := rootMeasurementFixture(t)
	path := "/approved/git/common/metadata"
	identity := authority.RootIdentity{Device: "1", Inode: "91"}
	launch.gitDirectories = append(launch.gitDirectories, gitReadDirectory{"/approved/git", path, identity})
	fs.directories[path] = directoryFacts{identity, os.ModeDir | 0700, 501}
	m, err := retainLaunchFiles(ctx, command, launch, fs)
	if err != nil || m == nil {
		t.Fatal("initial retained measurement failed", err)
	}
	t.Cleanup(m.Close)
	return m, command, launch, fs
}
func assertMeasurementRefused(t *testing.T, err error) {
	t.Helper()
	var failure *processsvc.NativeFailure
	if !errors.As(err, &failure) || failure.Unknown {
		t.Fatalf("expected known pre-dispatch refusal, got %v", err)
	}
}

func TestRetainedMeasurementSameHandlesAndFrozenSelection(t *testing.T) {
	m, command, launch, fs := retainedMeasurementFixture(t, context.Background())
	handles := append([]*measurementHandleDouble(nil), fs.handles...)
	absolute := append([]string(nil), fs.absolute...)
	anchored := append([][2]string(nil), fs.anchored...)
	// Caller mutation cannot replace the identities/paths already captured.
	command.Root, command.Cwd = "/foreign", "/foreign"
	launch.scratch, launch.scratchIdentity.Inode = "/foreign", "changed"
	launch.roots[0].ScopeRoot = "/foreign"
	launch.pins[0] = ExecutablePin{"/foreign", "changed"}
	for i := 0; i < 2; i++ {
		if err := m.Recheck(context.Background()); err != nil {
			t.Fatal(err)
		}
		fs.assertCloses(t, 0)
	}
	if !reflect.DeepEqual(handles, fs.handles) || !reflect.DeepEqual(absolute, fs.absolute) || !reflect.DeepEqual(anchored, fs.anchored) {
		t.Fatal("recheck reopened or replaced a descriptor")
	}
	for _, pin := range m.executables {
		if pin.(*measurementExecutableDouble).checks != 3 {
			t.Fatal("initial/final executable rechecks missing")
		}
	}
	m.Close()
	m.Close()
	fs.assertCloses(t, 1)
	assertMeasurementRefused(t, m.Recheck(context.Background()))
	fs.assertCloses(t, 1)
}

func TestRetainedMeasurementBetweenChecksDirectoryDrift(t *testing.T) {
	for _, target := range []string{"root", "cwd", "scratch", "approved", "scope", "git-directory"} {
		for _, drift := range []string{"device", "inode", "alias", "missing", "not-directory", "symlink", "resolve-error"} {
			t.Run(target+"/"+drift, func(t *testing.T) {
				m, command, launch, fs := retainedMeasurementFixture(t, context.Background())
				paths := map[string]string{"root": command.Root, "cwd": command.Cwd, "scratch": launch.scratch,
					"approved": "/approved/git", "scope": "/approved/git/common", "git-directory": "/approved/git/common/metadata"}
				path := paths[target]
				beforeOpens := len(fs.handles)
				facts := fs.directories[path]
				switch drift {
				case "device":
					facts.identity.Device = "2"
				case "inode":
					facts.identity.Inode = "replacement"
				case "alias":
					fs.alias = path
				case "missing":
					delete(fs.directories, path)
				case "not-directory":
					facts.mode = 0700
				case "symlink":
					facts.mode |= os.ModeSymlink
				case "resolve-error":
					fs.resolveError = path
				}
				if drift != "missing" {
					fs.directories[path] = facts
				}
				assertMeasurementRefused(t, m.Recheck(context.Background()))
				fs.assertCloses(t, 1)
				// Restoration does not resurrect or swap the consumed measurement.
				facts.identity.Inode = "restored"
				fs.directories[path] = facts
				assertMeasurementRefused(t, m.Recheck(context.Background()))
				if len(fs.handles) != beforeOpens {
					t.Fatal("refusal reopened handles")
				}
				fs.assertCloses(t, 1)
			})
		}
	}
}

func TestRetainedMeasurementScratchOwnerAndModeDrift(t *testing.T) {
	for _, drift := range []string{"owner", "mode"} {
		t.Run(drift, func(t *testing.T) {
			m, _, launch, fs := retainedMeasurementFixture(t, context.Background())
			facts := fs.directories[launch.scratch]
			if drift == "owner" {
				facts.uid++
			} else {
				facts.mode = os.ModeDir | 0755
			}
			fs.directories[launch.scratch] = facts
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementExecutableFailureClosesEverything(t *testing.T) {
	_, _, launch, _ := rootMeasurementFixture(t)
	for i := range launch.pins {
		t.Run(launch.pins[i].Path, func(t *testing.T) {
			m, _, _, fs := retainedMeasurementFixture(t, context.Background())
			m.executables[i].(*measurementExecutableDouble).fail = true
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementCancellationConsumesOriginalLifetime(t *testing.T) {
	for _, mode := range []string{"nil", "caller-before", "caller-during-image", "original-before", "original-during-image", "during-directory", "deadline"} {
		t.Run(mode, func(t *testing.T) {
			original, cancelOriginal := context.WithCancel(context.Background())
			defer cancelOriginal()
			m, _, _, fs := retainedMeasurementFixture(t, original)
			caller, cancelCaller := context.WithCancel(context.Background())
			defer cancelCaller()
			switch mode {
			case "nil":
				caller = nil
			case "caller-before":
				cancelCaller()
			case "caller-during-image":
				m.executables[0].(*measurementExecutableDouble).before = func(context.Context) { cancelCaller() }
			case "original-before":
				cancelOriginal()
			case "original-during-image":
				m.executables[0].(*measurementExecutableDouble).before = func(context.Context) { cancelOriginal() }
			case "during-directory":
				fs.inspectHook = func(string) { cancelCaller() }
			case "deadline":
				caller, cancelCaller = context.WithDeadline(context.Background(), time.Unix(1, 0))
				defer cancelCaller()
			}
			assertMeasurementRefused(t, m.Recheck(caller))
			fs.assertCloses(t, 1)
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			fs.assertCloses(t, 1)
		})
	}
}

func TestRetainedMeasurementPartialCancellationAndCloseErrors(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	fs.afterOpen = func(string) { cancel() }
	m, err := retainLaunchFiles(ctx, command, launch, fs)
	if m != nil {
		t.Fatal("partial cancelled measurement escaped")
	}
	assertMeasurementRefused(t, err)
	fs.assertCloses(t, 1)
	m, _, _, fs = retainedMeasurementFixture(t, context.Background())
	var order []int
	for i, h := range fs.handles {
		h.closeError = errors.New("synthetic close error")
		h.onClose = func() { order = append(order, i) }
	}
	m.Close()
	m.Close()
	fs.assertCloses(t, 1)
	for i, got := range order {
		if got != len(fs.handles)-1-i {
			t.Fatal("partial cleanup or wrong close order", order)
		}
	}
	var missing *retainedLaunchMeasurement
	missing.Close()
	assertMeasurementRefused(t, missing.Recheck(context.Background()))
}

func TestRetainedMeasurementCloserCompatibilityIsIdempotent(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	close, err := measureLaunchFiles(context.Background(), command, launch, fs)
	if err != nil || close == nil {
		t.Fatal(err)
	}
	fs.assertCloses(t, 0)
	close()
	close()
	fs.assertCloses(t, 1)
}

// Immutable metadata snapshots implement os.FileInfo; neither Stat nor ReadAt
// invokes native APIs. The verifier compares Darwin device/inode stat values.
type retainedImageInfo struct {
	mode     os.FileMode
	size     int64
	modified time.Time
	stat     syscall.Stat_t
}

func (i retainedImageInfo) Name() string       { return "synthetic-image" }
func (i retainedImageInfo) Size() int64        { return i.size }
func (i retainedImageInfo) Mode() os.FileMode  { return i.mode }
func (i retainedImageInfo) ModTime() time.Time { return i.modified }
func (i retainedImageInfo) IsDir() bool        { return i.mode.IsDir() }
func (i retainedImageInfo) Sys() any           { stat := i.stat; return &stat }

type retainedImageFileDouble struct {
	data                 []byte
	info                 retainedImageInfo
	closes, stats, reads int
	statErrorAt          int
	readError            bool
	duringRead           func()
	offsets              []int64
}

func (f *retainedImageFileDouble) Close() error { f.closes++; return nil }
func (f *retainedImageFileDouble) Stat() (os.FileInfo, error) {
	f.stats++
	if f.stats == f.statErrorAt {
		return nil, errors.New("synthetic stat error")
	}
	return f.info, nil
}
func (f *retainedImageFileDouble) ReadAt(b []byte, offset int64) (int, error) {
	f.reads++
	f.offsets = append(f.offsets, offset)
	if f.duringRead != nil {
		f.duringRead()
	}
	if f.readError {
		return 0, errors.New("synthetic read error")
	}
	return bytes.NewReader(f.data).ReadAt(b, offset)
}
func retainedImageFixture(t *testing.T) (*retainedLaunchMeasurement, *darwinExecutableMeasurement, *retainedImageFileDouble, *measurementFilesystemDouble) {
	t.Helper()
	_, command, launch, fs := rootMeasurementFixture(t)
	data := []byte("synthetic pinned image bytes")
	digest := sha256.Sum256(data)
	info := retainedImageInfo{mode: 0500, size: int64(len(data)), modified: time.Unix(1, 0), stat: syscall.Stat_t{Dev: 1, Ino: 2, Uid: 501, Nlink: 1}}
	file := &retainedImageFileDouble{data: data, info: info}
	pin := &darwinExecutableMeasurement{file: file, selected: ExecutablePin{"/synthetic/image", hex.EncodeToString(digest[:])}, original: info, ownerUID: 501}
	pin.named = func(path string) (os.FileInfo, error) {
		if path != pin.selected.Path {
			t.Fatal("named path changed")
		}
		return file.info, nil
	}
	m, err := retainLaunchFiles(context.Background(), command, launch, fs)
	if err != nil {
		t.Fatal(err)
	}
	// Attach the real verifier over CPU doubles; this seam performs no open.
	m.executables = append(m.executables, pin)
	m.pins = append(m.pins, pin)
	t.Cleanup(m.Close)
	if err := m.Recheck(context.Background()); err != nil {
		t.Fatal("synthetic original refused", err)
	}
	return m, pin, file, fs
}

func TestRetainedExecutableSameDescriptorHashAndOffset(t *testing.T) {
	m, pin, file, fs := retainedImageFixture(t)
	for i := 0; i < 2; i++ {
		if err := m.Recheck(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if pin.file != file || !reflect.DeepEqual(file.offsets, []int64{0, 0, 0}) || file.closes != 0 {
		t.Fatal("hash did not reuse the original descriptor at offset zero", file.offsets)
	}
	m.Close()
	m.Close()
	if file.closes != 1 {
		t.Fatal("retained image not closed exactly once")
	}
	fs.assertCloses(t, 1)
}

func TestRetainedExecutableBetweenChecksDriftAndErrors(t *testing.T) {
	for _, mode := range []string{"hash", "descriptor-device", "descriptor-inode", "named-inode", "named-symlink", "named-alias-error", "mode", "owner", "hardlink", "size", "mtime", "not-regular", "oversize", "stat-before", "stat-after", "read", "named", "during-hash", "cancel-read", "cancel-named"} {
		t.Run(mode, func(t *testing.T) {
			m, pin, file, fs := retainedImageFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "hash":
				file.data[0] ^= 1 // Same inode/size/mtime; digest still must fail.
			case "descriptor-device":
				file.info.stat.Dev++
			case "descriptor-inode":
				file.info.stat.Ino++
			case "named-inode", "named-symlink":
				named := file.info
				if mode == "named-inode" {
					named.stat.Ino++
				} else {
					named.mode |= os.ModeSymlink
				}
				pin.named = func(string) (os.FileInfo, error) { return named, nil }
			case "named-alias-error", "named":
				pin.named = func(string) (os.FileInfo, error) { return nil, errors.New("synthetic named path error") }
			case "mode":
				file.info.mode = 0520
			case "owner":
				file.info.stat.Uid++
			case "hardlink":
				file.info.stat.Nlink++
			case "size":
				file.info.size++
			case "mtime":
				file.info.modified = file.info.modified.Add(time.Second)
			case "not-regular":
				file.info.mode |= os.ModeDir
			case "oversize":
				file.info.size = 128*1024*1024 + 1
			case "stat-before":
				file.statErrorAt = file.stats + 1
			case "stat-after":
				file.statErrorAt = file.stats + 2
			case "read":
				file.readError = true
			case "during-hash":
				file.duringRead = func() { file.info.stat.Ino++ }
			case "cancel-read":
				file.duringRead = cancel
			case "cancel-named":
				pin.named = func(string) (os.FileInfo, error) { cancel(); return file.info, nil }
			}
			assertMeasurementRefused(t, m.Recheck(ctx))
			if file.closes != 1 {
				t.Fatal("image failure did not close retained descriptor")
			}
			fs.assertCloses(t, 1)
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			if file.closes != 1 {
				t.Fatal("failed image measurement resurrected")
			}
		})
	}
}

var _ io.ReaderAt = (*retainedImageFileDouble)(nil)

func TestRetainedMeasurementLateImageDriftRefusesInitialCapture(t *testing.T) {
	_, command, launch, fs := rootMeasurementFixture(t)
	fs.afterOpen = func(string) { fs.images[0].fail = true }
	m, err := retainLaunchFiles(context.Background(), command, launch, fs)
	if m != nil {
		t.Fatal("later directory measurement hid early image drift")
	}
	assertMeasurementRefused(t, err)
	fs.assertCloses(t, 1)
}

type hostRuntimeMeasurementFilesystemDouble struct {
	*measurementFilesystemDouble
	runtime *hostRuntimeFixtureFS
}

func (f *hostRuntimeMeasurementFilesystemDouble) checkHostRuntime(ctx context.Context, p *HostRuntimePlan) error {
	return p.recheck(ctx, f.runtime)
}
func TestRetainedInstalledRuntimeCannotRefreshOrRenewPreparation(t *testing.T) {
	for _, mode := range []string{"drift", "cancelled", "missing-reader"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			runtime := runtimeFixture()
			p, err := buildRuntimeFixture(runtime)
			if err != nil {
				t.Fatal(err)
			}
			_, command, launch, base := rootMeasurementFixture(t)
			launch.hostRuntime = p
			var fs launchFilesystem = &hostRuntimeMeasurementFilesystemDouble{base, runtime}
			if mode == "missing-reader" {
				fs = base
			}
			m, err := retainLaunchFiles(ctx, command, launch, fs)
			if mode == "missing-reader" {
				if err == nil {
					m.Close()
					t.Fatal("unimplemented runtime fact reader accepted")
				}
				base.assertCloses(t, 1)
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if m.Recheck(context.Background()) != nil {
				t.Fatal("initial immutable plan refused")
			}
			// A caller cannot swap the snapshot retained by this original invocation.
			p.frozen.ExecFiles = nil
			if mode == "drift" {
				n := runtime.nodes["/install/bin/git-real"]
				n.SHA256 = strings.Repeat("f", 64)
				runtime.nodes[n.Path] = n
			} else {
				cancel()
			}
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			assertMeasurementRefused(t, m.Recheck(context.Background()))
			base.assertCloses(t, 1)
		})
	}
}
